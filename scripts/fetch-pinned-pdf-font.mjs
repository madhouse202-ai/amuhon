import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const VERSION = "2.003";
const FONT_NAME = "NotoSerifCJKjp-Regular.otf";
const FONT_SIZE = 24_573_864;
const FONT_SHA256 = "D9854C7A8EF170B5A7932558856FD64EB8DE0B007CD823FED6F9F514AD2803D3";
const FONT_URL = `https://raw.githubusercontent.com/notofonts/noto-cjk/Serif${VERSION}/Serif/OTF/Japanese/${FONT_NAME}`;
const LICENSE_URL = `https://raw.githubusercontent.com/notofonts/noto-cjk/Serif${VERSION}/Serif/LICENSE`;
const MAX_LICENSE_BYTES = 64 * 1024;

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

async function downloadFixed(url, maxBytes) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!response.ok || response.redirected || response.url !== url) throw new Error("download_refused");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > maxBytes) throw new Error("download_size_refused");
  return bytes;
}

async function ensureFile(filePath, bytes, expectedHash = null) {
  try {
    const existing = new Uint8Array(await readFile(filePath));
    if (expectedHash && hash(existing) !== expectedHash) throw new Error("existing_file_mismatch");
    if (!expectedHash && Buffer.compare(Buffer.from(existing), Buffer.from(bytes)) !== 0) {
      throw new Error("existing_license_mismatch");
    }
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o644 });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await import("node:fs/promises").then(({ rm }) => rm(temporaryPath, { force: true }));
    throw error;
  }
}

async function main() {
  const outputDirectory = process.argv[2];
  if (!outputDirectory || process.argv.length !== 3) throw new Error("font_output_directory_required");
  const fontBytes = await downloadFixed(FONT_URL, FONT_SIZE);
  if (fontBytes.byteLength !== FONT_SIZE || hash(fontBytes) !== FONT_SHA256 ||
      Buffer.from(fontBytes.subarray(0, 4)).toString("ascii") !== "OTTO") {
    throw new Error("font_integrity_check_failed");
  }
  const licenseBytes = await downloadFixed(LICENSE_URL, MAX_LICENSE_BYTES);
  const license = Buffer.from(licenseBytes).toString("utf8");
  if (!license.includes("SIL OPEN FONT LICENSE Version 1.1")) throw new Error("font_license_check_failed");

  const directory = path.resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  await ensureFile(path.join(directory, FONT_NAME), fontBytes, FONT_SHA256);
  await ensureFile(path.join(directory, "LICENSE-Noto-Serif-CJK.txt"), licenseBytes);
  console.log(`Pinned Noto Serif CJK JP ${VERSION}: verified (${FONT_SIZE} bytes, SHA-256 matched, OFL 1.1).`);
}

main().catch(() => {
  console.error("Pinned renderer font acquisition failed; the build must stop.");
  process.exitCode = 1;
});
