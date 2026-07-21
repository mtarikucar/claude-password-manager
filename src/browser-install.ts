/**
 * Installs the browser bridge: a self-contained copy of the native host in a
 * stable directory, registered with Chrome/Edge, plus the unpacked extension
 * staged where the user can load it. No external npm deps are needed at host
 * launch — the host's whole import closure is copied.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { configDir } from "./vault.js";

export const HOST_NAME = "com.mtarikucar.ccpm";
export const EXTENSION_ID = "gjipjebiknnlhbifioipciiccdicmjmb";

// The native host + its full (dependency-free) import closure.
const HOST_FILES = ["native-host.js", "vault.js", "master.js", "oskey.js", "native-messaging.js", "domain.js"];
const EXT_FILES = ["manifest.json", "background.js", "content.js", "popup.html", "popup.js"];

export interface InstallResult {
  hostDir: string;
  extensionDir: string;
  extensionId: string;
  registered: string[];
}

export function browserInstall(): InstallResult {
  const cfg = configDir();
  const distDir = dirname(fileURLToPath(import.meta.url)); // .../dist
  const pkgRoot = dirname(distDir);
  const isWin = process.platform === "win32";

  // 1) Stage a self-contained host.
  const hostDir = join(cfg, "host");
  mkdirSync(hostDir, { recursive: true });
  for (const f of HOST_FILES) copyFileSync(join(distDir, f), join(hostDir, f));
  writeFileSync(join(hostDir, "package.json"), JSON.stringify({ type: "module" }, null, 2));

  const launcher = join(hostDir, isWin ? "ccpm-host.bat" : "ccpm-host.sh");
  if (isWin) {
    writeFileSync(launcher, `@node "%~dp0native-host.js" %*\r\n`);
  } else {
    writeFileSync(launcher, `#!/bin/sh\nexec node "$(dirname "$0")/native-host.js" "$@"\n`);
    chmodSync(launcher, 0o755);
  }

  // 2) Native-messaging host manifest + registration.
  const manifest = {
    name: HOST_NAME,
    description: "Claude Password Manager native host",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  const registered: string[] = [];

  if (isWin) {
    const manifestPath = join(hostDir, `${HOST_NAME}.json`);
    writeFileSync(manifestPath, manifestJson);
    const targets: [string, string][] = [
      ["Chrome", "Software\\Google\\Chrome"],
      ["Edge", "Software\\Microsoft\\Edge"],
    ];
    for (const [browser, keyBase] of targets) {
      try {
        execFileSync(
          "reg",
          ["add", `HKCU\\${keyBase}\\NativeMessagingHosts\\${HOST_NAME}`, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"],
          { stdio: "ignore" },
        );
        registered.push(browser);
      } catch {
        /* that browser isn't installed */
      }
    }
  } else {
    const base = homedir();
    const dirs =
      process.platform === "darwin"
        ? [
            join(base, "Library/Application Support/Google/Chrome/NativeMessagingHosts"),
            join(base, "Library/Application Support/Microsoft Edge/NativeMessagingHosts"),
            join(base, "Library/Application Support/Chromium/NativeMessagingHosts"),
          ]
        : [
            join(base, ".config/google-chrome/NativeMessagingHosts"),
            join(base, ".config/microsoft-edge/NativeMessagingHosts"),
            join(base, ".config/chromium/NativeMessagingHosts"),
          ];
    for (const d of dirs) {
      try {
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, `${HOST_NAME}.json`), manifestJson);
        registered.push(d);
      } catch {
        /* skip a browser dir we can't write */
      }
    }
  }

  // 3) Stage the extension where it can be loaded unpacked.
  const extensionDir = join(cfg, "extension");
  mkdirSync(extensionDir, { recursive: true });
  for (const f of EXT_FILES) copyFileSync(join(pkgRoot, "extension", f), join(extensionDir, f));

  return { hostDir, extensionDir, extensionId: EXTENSION_ID, registered };
}
