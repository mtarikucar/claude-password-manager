/**
 * Keystroke injection ("auto-type").
 *
 * This module lets the server type a stored secret directly into whatever text
 * field currently has OS focus — WITHOUT the secret value ever being returned
 * to the MCP client. That is the whole point: the model asks "type GitHub's
 * password", the OS types it, and the plaintext never enters the model's
 * context or the JSON-RPC channel.
 *
 * Delivery uses only tools that ship with each OS, so there is no native npm
 * dependency and `npx` installs stay fast:
 *   - Windows : PowerShell + System.Windows.Forms.SendKeys
 *   - macOS   : osascript "keystroke" via System Events
 *   - Linux   : xdotool type (X11)
 *
 * The secret is handed to the helper on STDIN — never as an argv element or an
 * environment variable — so it does not appear in the process table.
 */
import { spawn } from "node:child_process";

export type Platform = "win32" | "darwin" | "linux";

export interface InjectorSpec {
  /** Executable to run. */
  cmd: string;
  /** Arguments (no shell interpolation — passed directly to the child). */
  args: string[];
  /** Exact bytes to write to the child's stdin (already OS-escaped). */
  stdin: string;
}

/** The slice of a child process this module actually uses. */
export interface ChildLike {
  stdin: { write(s: string): void; end(): void };
  on(event: string, cb: (arg: any) => void): void;
}

export type SpawnLike = (cmd: string, args: string[]) => ChildLike;

/**
 * Escape a string for Windows SendKeys. SendKeys treats
 * `{ } [ ] ( ) + ^ % ~` as metacharacters; a literal one must be wrapped in
 * braces (e.g. `+` → `{+}`, `{` → `{{}`). Each input character is mapped
 * independently in a single pass, so emitted braces are never re-escaped.
 */
const SENDKEYS_ESCAPES: Record<string, string> = {
  "{": "{{}",
  "}": "{}}",
  "[": "{[}",
  "]": "{]}",
  "(": "{(}",
  ")": "{)}",
  "+": "{+}",
  "^": "{^}",
  "%": "{%}",
  "~": "{~}",
};

export function escapeSendKeys(text: string): string {
  let out = "";
  for (const ch of text) out += SENDKEYS_ESCAPES[ch] ?? ch;
  return out;
}

/**
 * Build an AppleScript that types `text` via System Events. The text is
 * embedded as a quoted AppleScript string, so backslashes and double quotes
 * must be escaped.
 */
export function appleScriptKeystroke(text: string): string {
  const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `tell application "System Events" to keystroke "${escaped}"`;
}

// A hidden PowerShell process reads the (SendKeys-escaped) secret from stdin
// and types it. The short sleep lets window focus settle before typing.
const WIN_PS =
  "$ErrorActionPreference='Stop'; " +
  "Add-Type -AssemblyName System.Windows.Forms; " +
  "$s=[Console]::In.ReadToEnd(); " +
  "Start-Sleep -Milliseconds 400; " +
  "[System.Windows.Forms.SendKeys]::SendWait($s)";

export function injectorSpec(platform: Platform, secret: string): InjectorSpec {
  switch (platform) {
    case "win32":
      return {
        cmd: "powershell",
        args: ["-NoProfile", "-NonInteractive", "-Command", WIN_PS],
        stdin: escapeSendKeys(secret),
      };
    case "darwin":
      return {
        cmd: "osascript",
        args: ["-"],
        stdin: appleScriptKeystroke(secret),
      };
    case "linux":
      // xdotool reads the literal string from stdin (--file -), so no escaping.
      return {
        cmd: "xdotool",
        args: ["type", "--clearmodifiers", "--file", "-"],
        stdin: secret,
      };
    default:
      throw new Error(`Unsupported platform for auto-type: ${platform}`);
  }
}

const defaultSpawn: SpawnLike = (cmd, args) => {
  // stdout/stderr ignored so nothing the helper prints can echo back; the
  // secret only flows one way, into stdin.
  const child = spawn(cmd, args, {
    windowsHide: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  return {
    stdin: {
      write: (s: string) => {
        child.stdin?.write(s);
      },
      end: () => {
        child.stdin?.end();
      },
    },
    on: (event, cb) => {
      child.on(event as "close" | "error", cb);
    },
  };
};

/**
 * Type `secret` into the focused window via the platform's auto-type helper.
 * Resolves when the helper exits 0; rejects on spawn failure or nonzero exit.
 * The secret is written to stdin and never returned.
 */
export async function injectKeystrokes(
  secret: string,
  opts: { platform?: Platform; spawnFn?: SpawnLike } = {},
): Promise<void> {
  const platform = (opts.platform ?? process.platform) as Platform;
  const spec = injectorSpec(platform, secret);
  const spawnFn = opts.spawnFn ?? defaultSpawn;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };
    const child = spawnFn(spec.cmd, spec.args);
    child.on("error", (err) =>
      done(err instanceof Error ? err : new Error(String(err))),
    );
    child.on("close", (code) =>
      done(code === 0 ? undefined : new Error(`${spec.cmd} exited with code ${code}`)),
    );
    try {
      child.stdin.write(spec.stdin);
      child.stdin.end();
    } catch (err) {
      done(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Whether the server should expose the plaintext-revealing `get_credential`
 * tool. Off by default: the model can only INJECT secrets (fill_credential),
 * not read them back. Set CCPM_ALLOW_REVEAL=1 to opt back into the old
 * reveal-to-client behaviour.
 */
export function shouldExposeReveal(env: NodeJS.ProcessEnv): boolean {
  return env.CCPM_ALLOW_REVEAL === "1";
}
