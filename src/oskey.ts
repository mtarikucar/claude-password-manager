/**
 * OS-protected key store.
 *
 * Lets a vault unlock WITHOUT a user-chosen master password: a random secret
 * (which plays the role of the master) is stored under the OS's own per-user
 * protection, so only the logged-in user on this machine can retrieve it.
 *
 *   - Windows : DPAPI (CurrentUser) via PowerShell — the wrapped blob is kept
 *               in a `os-key.dpapi` sidecar next to the vault.
 *   - macOS   : Keychain via the `security` CLI.
 *   - Linux   : libsecret via `secret-tool`.
 *
 * No native npm dependency — each platform shells out to a built-in tool, and
 * the secret travels over stdin (never argv) wherever the tool allows it.
 *
 * Trade-off vs a master password: the vault is bound to this machine + user
 * account and is NOT portable; its security equals the OS login.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join, dirname } from "node:path";

export type Platform = "win32" | "darwin" | "linux";
export interface ExecResult {
  stdout: string;
  code: number;
}
export type ExecFn = (cmd: string, args: string[], stdin: string) => Promise<ExecResult>;
export type ReadFileFn = (path: string) => string;
export type WriteFileFn = (path: string, content: string) => void;

const SERVICE = "ccpm-vault-secret";

export function osKeyFilePath(configDir: string): string {
  return join(configDir, "os-key.dpapi");
}

// Reads the secret from stdin, DPAPI-protects it for the current user, and
// writes the base64 blob to stdout (no trailing newline).
const PS_PROTECT =
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
  "$s=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($s); " +
  "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); " +
  "[Console]::Out.Write([Convert]::ToBase64String($p))";

// Reads the base64 blob from stdin, DPAPI-unprotects it, writes the secret out.
const PS_UNPROTECT =
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
  "$b64=[Console]::In.ReadToEnd().Trim(); $p=[Convert]::FromBase64String($b64); " +
  "$u=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,'CurrentUser'); " +
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($u))";

const defaultExec: ExecFn = (cmd, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout: out, code: code ?? 0 }));
    try {
      child.stdin?.write(stdin);
      child.stdin?.end();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });

const defaultReadFile: ReadFileFn = (p) => readFileSync(p, "utf8");
const defaultWriteFile: WriteFileFn = (p, c) => {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, c, { mode: 0o600 });
};

export interface OsKeyOpts {
  platform?: Platform;
  configDir: string;
  exec?: ExecFn;
  readFile?: ReadFileFn;
  writeFile?: WriteFileFn;
  user?: string;
}

function currentUser(o: OsKeyOpts): string {
  if (o.user) return o.user;
  try {
    return userInfo().username;
  } catch {
    return "ccpm";
  }
}

/** Provision `secret` into the OS store. Throws if the OS tool fails. */
export async function storeOsSecret(secret: string, o: OsKeyOpts): Promise<void> {
  const platform = (o.platform ?? process.platform) as Platform;
  const exec = o.exec ?? defaultExec;
  const writeFile = o.writeFile ?? defaultWriteFile;
  switch (platform) {
    case "win32": {
      const { stdout, code } = await exec(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", PS_PROTECT],
        secret,
      );
      if (code !== 0 || !stdout.trim()) throw new Error("DPAPI protect failed");
      writeFile(osKeyFilePath(o.configDir), stdout.trim());
      return;
    }
    case "darwin": {
      const { code } = await exec(
        "security",
        ["add-generic-password", "-a", currentUser(o), "-s", SERVICE, "-U", "-w", secret],
        "",
      );
      if (code !== 0) throw new Error("Keychain store failed");
      return;
    }
    case "linux": {
      const { code } = await exec("secret-tool", ["store", "--label=" + SERVICE, "service", SERVICE], secret);
      if (code !== 0) throw new Error("secret-tool store failed (install libsecret-tools?)");
      return;
    }
    default:
      throw new Error(`OS key storage is not supported on ${platform}`);
  }
}

/** Retrieve the provisioned secret, or null if none is stored / unreadable. */
export async function loadOsSecret(o: OsKeyOpts): Promise<string | null> {
  const platform = (o.platform ?? process.platform) as Platform;
  const exec = o.exec ?? defaultExec;
  const readFile = o.readFile ?? defaultReadFile;
  switch (platform) {
    case "win32": {
      let blob: string;
      try {
        blob = readFile(osKeyFilePath(o.configDir)).trim();
      } catch {
        return null;
      }
      if (!blob) return null;
      const { stdout, code } = await exec(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", PS_UNPROTECT],
        blob,
      );
      if (code !== 0) return null;
      return stdout.replace(/\r?\n$/, "");
    }
    case "darwin": {
      const { stdout, code } = await exec(
        "security",
        ["find-generic-password", "-a", currentUser(o), "-s", SERVICE, "-w"],
        "",
      );
      return code === 0 ? stdout.replace(/\r?\n$/, "") : null;
    }
    case "linux": {
      const { stdout, code } = await exec("secret-tool", ["lookup", "service", SERVICE], "");
      return code === 0 && stdout ? stdout.replace(/\r?\n$/, "") : null;
    }
    default:
      return null;
  }
}
