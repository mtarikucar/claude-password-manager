/**
 * Tests for the OS-protected key store (src/oskey.ts).
 *
 * Provisions a random vault secret into the OS credential store so the vault
 * can unlock WITHOUT a master password:
 *   - Windows : DPAPI (CurrentUser) — wrapped blob in a sidecar file
 *   - macOS   : Keychain via `security`
 *   - Linux   : libsecret via `secret-tool`
 *
 * The pure orchestration is tested here with an injected exec + in-memory fs
 * (a fake DPAPI = base64). A REAL DPAPI round-trip is exercised separately in
 * test/oskey.dpapi.test.ts (Windows only).
 *
 * Run with `tsx test/oskey.test.ts`.
 */
import { osKeyFilePath, storeOsSecret, loadOsSecret, type ExecFn } from "../src/oskey.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}
async function main() {
  // --- path helper ---------------------------------------------------------
  check("os key file lives beside the vault", osKeyFilePath("/cfg").replace(/\\/g, "/") === "/cfg/os-key.dpapi");

  // A fake in-memory filesystem + a fake exec that models DPAPI as base64.
  function harness() {
    const files = new Map<string, string>();
    const calls: { cmd: string; args: string[]; stdin: string }[] = [];
    const exec: ExecFn = async (cmd, args, stdin) => {
      calls.push({ cmd, args, stdin });
      const joined = args.join(" ");
      // Fake Windows DPAPI: protect = base64(secret), unprotect = decode.
      // NB: check Unprotect first — the string "Unprotect(" contains "Protect(".
      if (/Unprotect\(/.test(joined)) {
        return { stdout: Buffer.from(stdin.trim(), "base64").toString("utf8"), code: 0 };
      }
      if (/Protect\(/.test(joined)) {
        return { stdout: Buffer.from(stdin, "utf8").toString("base64"), code: 0 };
      }
      // Fake keychain/libsecret store (secret on stdin or in -w arg).
      if (cmd === "security" && args[0] === "add-generic-password") {
        const i = args.indexOf("-w");
        files.set("kc", args[i + 1]);
        return { stdout: "", code: 0 };
      }
      if (cmd === "secret-tool" && args[0] === "store") {
        files.set("kc", stdin);
        return { stdout: "", code: 0 };
      }
      if (cmd === "security" && args[0] === "find-generic-password") {
        const v = files.get("kc");
        return v != null ? { stdout: v + "\n", code: 0 } : { stdout: "", code: 44 };
      }
      if (cmd === "secret-tool" && args[0] === "lookup") {
        const v = files.get("kc");
        return v != null ? { stdout: v + "\n", code: 0 } : { stdout: "", code: 1 };
      }
      return { stdout: "", code: 0 };
    };
    const readFile = (p: string) => {
      if (!files.has(p)) throw new Error("ENOENT");
      return files.get(p)!;
    };
    const writeFile = (p: string, c: string) => void files.set(p, c);
    return { files, calls, exec, readFile, writeFile };
  }

  const SECRET = "9f8e7d6c5b4a39281706f5e4d3c2b1a0"; // fake 32-hex vault key

  // --- Windows: store wraps via DPAPI and writes a sidecar blob ------------
  {
    const h = harness();
    await storeOsSecret(SECRET, { platform: "win32", configDir: "/cfg", exec: h.exec, readFile: h.readFile, writeFile: h.writeFile });
    check("win32 store ran powershell with the secret on stdin", h.calls.some((c) => c.cmd === "powershell" && c.stdin === SECRET));
    check("win32 store wrote a sidecar blob file", h.files.has(osKeyFilePath("/cfg")));
    check("win32 sidecar is not the raw secret", h.files.get(osKeyFilePath("/cfg")) !== SECRET);
    const back = await loadOsSecret({ platform: "win32", configDir: "/cfg", exec: h.exec, readFile: h.readFile, writeFile: h.writeFile });
    check("win32 round-trip returns the secret", back === SECRET);
  }

  // --- Windows: no sidecar -> null (vault not OS-provisioned) --------------
  {
    const h = harness();
    const back = await loadOsSecret({ platform: "win32", configDir: "/cfg", exec: h.exec, readFile: h.readFile, writeFile: h.writeFile });
    check("win32 load returns null when no key stored", back === null);
  }

  // --- macOS: keychain round-trip -----------------------------------------
  {
    const h = harness();
    await storeOsSecret(SECRET, { platform: "darwin", configDir: "/cfg", exec: h.exec, readFile: h.readFile, writeFile: h.writeFile });
    check("darwin used the security tool", h.calls.some((c) => c.cmd === "security" && c.args[0] === "add-generic-password"));
    const back = await loadOsSecret({ platform: "darwin", configDir: "/cfg", exec: h.exec, readFile: h.readFile, writeFile: h.writeFile });
    check("darwin round-trip returns the secret", back === SECRET);
  }

  // --- Linux: libsecret round-trip (secret via stdin) ---------------------
  {
    const h = harness();
    await storeOsSecret(SECRET, { platform: "linux", configDir: "/cfg", exec: h.exec, readFile: h.readFile, writeFile: h.writeFile });
    check("linux stored the secret via secret-tool stdin", h.calls.some((c) => c.cmd === "secret-tool" && c.args[0] === "store" && c.stdin === SECRET));
    const back = await loadOsSecret({ platform: "linux", configDir: "/cfg", exec: h.exec, readFile: h.readFile, writeFile: h.writeFile });
    check("linux round-trip returns the secret", back === SECRET);
  }

  // --- Linux: lookup miss -> null -----------------------------------------
  {
    const h = harness();
    const back = await loadOsSecret({ platform: "linux", configDir: "/cfg", exec: h.exec, readFile: h.readFile, writeFile: h.writeFile });
    check("linux load returns null when nothing stored", back === null);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
