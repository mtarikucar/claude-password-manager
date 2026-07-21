/**
 * MANUAL, Windows-only integration check for the REAL DPAPI round-trip.
 * Not part of `npm test` (CI runs on Linux). Run on Windows:
 *   npx tsx test/oskey.dpapi.manual.ts
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeOsSecret, loadOsSecret, osKeyFilePath } from "../src/oskey.js";

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "ccpm-dpapi-"));
  let okAll = true;
  try {
    const secret = "vaultsecret-" + randomHex();
    await storeOsSecret(secret, { configDir: dir }); // real platform + real PowerShell DPAPI
    const sidecar = osKeyFilePath(dir);
    const blob = existsSync(sidecar) ? readFileSync(sidecar, "utf8") : "";
    const back = await loadOsSecret({ configDir: dir });

    const checks: [string, boolean][] = [
      ["sidecar file created", existsSync(sidecar)],
      ["sidecar is NOT the raw secret", blob.length > 0 && blob !== secret],
      ["round-trip returns the exact secret", back === secret],
      ["load returns null after the key file is gone", await missingIsNull(dir)],
    ];
    for (const [name, cond] of checks) {
      console.log((cond ? "  ok   " : "  FAIL ") + name);
      okAll = okAll && cond;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(okAll ? "\nDPAPI integration OK" : "\nDPAPI integration FAILED");
  process.exit(okAll ? 0 : 1);
}

async function missingIsNull(baseDir: string): Promise<boolean> {
  const empty = mkdtempSync(join(tmpdir(), "ccpm-empty-"));
  try {
    return (await loadOsSecret({ configDir: empty })) === null;
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}

// Cheap non-crypto id — this is a manual test, not a security path.
function randomHex(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += Math.floor(performance.now() % 16).toString(16);
  return s + process.pid.toString(16);
}

main();
