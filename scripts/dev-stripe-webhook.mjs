import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;

export const LOCAL_WEBHOOK_TARGET = "http://localhost:3000/api/webhooks/stripe";
export const LOCAL_APP_ORIGIN = "http://localhost:3000";
export const WEBHOOK_EVENTS = Object.freeze(["checkout.session.completed"]);

export function parseWebhookSigningSecret(text) {
  if (typeof text !== "string") return null;
  const match = /webhook signing secret is (whsec_[A-Za-z0-9]+)/i.exec(text);
  return match?.[1] ?? null;
}

export function isLocalStripeTestConfiguration(env) {
  if (env.STRIPE_MODE !== "test" || !/^sk_test_[A-Za-z0-9_]+$/.test(env.STRIPE_SECRET_KEY ?? "")) return false;
  if (env.ORDER_APP_ORIGIN?.replace(/\/$/, "") !== LOCAL_APP_ORIGIN) return false;
  try {
    const supabase = new URL(env.SUPABASE_URL ?? "");
    return supabase.origin === "https://ahxnmkuvdpzctcwcyadl.supabase.co" && supabase.pathname === "/" &&
      supabase.username === "" && supabase.password === "" && supabase.search === "" && supabase.hash === "";
  } catch {
    return false;
  }
}

export function stripeListenArguments() {
  return ["listen", "--forward-to", LOCAL_WEBHOOK_TARGET, "--events", WEBHOOK_EVENTS.join(",")];
}

function portIsFree(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("port_check_timeout"));
    }, 1500);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED") resolve(true);
      else reject(new Error("port_check_failed"));
    });
  });
}

function stripeCliEnvironment(env) {
  const allowed = ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME", "XDG_CONFIG_HOME", "TEMP", "TMP"];
  return Object.fromEntries(allowed.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]));
}

function startStripeListener() {
  const args = stripeListenArguments();
  if (process.platform === "win32") {
    const command = `& stripe ${args.join(" ")}; exit $LASTEXITCODE`;
    return spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", command], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: stripeCliEnvironment(process.env),
    });
  }
  return spawn("stripe", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: stripeCliEnvironment(process.env),
  });
}

function stopProcess(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore", windowsHide: true,
    });
    killer.unref();
  } else {
    child.kill("SIGTERM");
  }
}

async function run() {
  process.env.NODE_ENV = "development";
  loadEnvConfig(process.cwd(), true, { log() {}, info() {}, warn() {}, error() {} });
  if (!isLocalStripeTestConfiguration(process.env)) {
    console.error("Webhook dev runner stopped: test mode, staging Supabase URL, and localhost app origin are required.");
    process.exitCode = 1;
    return;
  }
  try {
    if (!(await portIsFree("127.0.0.1", 3000))) {
      console.error("Webhook dev runner stopped: port 3000 is already in use. Stop the existing app first.");
      process.exitCode = 1;
      return;
    }
  } catch {
    console.error("Webhook dev runner stopped: localhost port availability could not be confirmed.");
    process.exitCode = 1;
    return;
  }

  let listener;
  try {
    listener = startStripeListener();
  } catch {
    console.error("Webhook dev runner stopped: Stripe CLI could not be started.");
    process.exitCode = 1;
    return;
  }

  let webhookSecret = null;
  let started = false;
  let stopping = false;
  let nextServer = null;
  let buffer = "";
  let startupTimer;

  const stopAll = (exitCode) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = exitCode;
    stopProcess(nextServer);
    stopProcess(listener);
  };

  const startNextServer = () => {
    if (started || stopping || !webhookSecret) return;
    started = true;
    clearTimeout(startupTimer);
    const nextCli = path.resolve("node_modules", "next", "dist", "bin", "next");
    nextServer = spawn(process.execPath, [nextCli, "dev", "--hostname", "127.0.0.1", "--port", "3000"], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "development", STRIPE_WEBHOOK_SECRET: webhookSecret },
      stdio: ["inherit", "ignore", "ignore"],
      windowsHide: true,
    });
    webhookSecret = null;
    console.log("Local app and Stripe test webhook listener are starting at http://localhost:3000.");
    nextServer.once("error", () => stopAll(1));
    nextServer.once("exit", (code) => {
      if (!stopping) {
        console.log(`Next.js dev server stopped (exit ${Number.isInteger(code) ? code : "unknown"}).`);
        stopAll(code === 0 ? 0 : 1);
      }
    });
  };

  const inspectOutput = (chunk) => {
    if (started || stopping) return;
    buffer = (buffer + chunk.toString("utf8")).slice(-16_384);
    const secret = parseWebhookSigningSecret(buffer);
    if (secret) {
      webhookSecret = secret;
      buffer = "";
      startNextServer();
    }
  };
  listener.stdout.on("data", inspectOutput);
  listener.stderr.on("data", inspectOutput);
  listener.once("error", () => {
    console.error("Webhook dev runner stopped: Stripe CLI could not be started.");
    stopAll(1);
  });
  listener.once("exit", (code) => {
    if (!stopping) {
      console.error(code === 0
        ? "Stripe CLI listener stopped."
        : "Stripe CLI listener failed. Check that the CLI is installed and authenticated; its output is suppressed.");
      stopAll(code === 0 ? 0 : 1);
    }
  });

  startupTimer = setTimeout(() => {
    if (!started) {
      console.error("Stripe CLI did not provide a webhook signing secret in time. Check CLI login; no secret was saved.");
      stopAll(1);
    }
  }, 30_000);

  process.once("SIGINT", () => stopAll(0));
  process.once("SIGTERM", () => stopAll(0));

  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (stopping && (!listener || listener.exitCode !== null) && (!nextServer || nextServer.exitCode !== null)) {
        clearInterval(poll);
        clearTimeout(startupTimer);
        resolve();
      }
    }, 100);
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) await run();
