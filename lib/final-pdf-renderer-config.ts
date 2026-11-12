import path from "node:path";

const LOCAL_FINAL_RENDER_URL = "http://localhost:3000/final";
const LOCAL_BROWSER_EXECUTABLES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

export type FinalPdfRendererConfig = {
  renderUrl: string;
  renderOrigin: string;
  executableCandidates: string[];
};

function isAbsoluteExecutablePath(value: string, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    ? path.win32.isAbsolute(value)
    : path.posix.isAbsolute(value);
}

function parseInternalFinalUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
    if (url.protocol !== "http:" || !isLoopback || !url.port || url.pathname !== "/final" ||
        url.username || url.password || url.search || url.hash) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * Production rendering must point at an explicitly configured loopback /final
 * endpoint and Chromium executable. Local development keeps its prior defaults.
 */
export function resolveFinalPdfRendererConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): FinalPdfRendererConfig {
  const isDevelopment = env.NODE_ENV === "development";
  const configuredExecutable = env.ORDER_PDF_CHROMIUM_EXECUTABLE_PATH?.trim();
  const configuredRenderUrl = env.ORDER_PDF_RENDER_URL?.trim();

  let executableCandidates: string[];
  if (configuredExecutable) {
    if (!isAbsoluteExecutablePath(configuredExecutable, platform)) {
      throw new Error("本文PDFレンダラーのChromium実行パスは絶対パスで指定してください。");
    }
    executableCandidates = [configuredExecutable];
  } else if (isDevelopment) {
    executableCandidates = [...LOCAL_BROWSER_EXECUTABLES];
  } else {
    throw new Error("本文PDFレンダラーのChromium実行パスが設定されていません。");
  }

  const renderUrlValue = configuredRenderUrl || (isDevelopment ? LOCAL_FINAL_RENDER_URL : "");
  if (!renderUrlValue) {
    throw new Error("本文PDFレンダラーの内部URLが設定されていません。");
  }
  const renderUrl = parseInternalFinalUrl(renderUrlValue);
  if (!renderUrl) {
    throw new Error("本文PDFレンダラーのURLは、ポートを明記したloopbackの/finalに限定されます。");
  }

  return {
    renderUrl: renderUrl.toString(),
    renderOrigin: renderUrl.origin,
    executableCandidates,
  };
}
