/**
 * Resolve the master secret for a vault without any user interaction:
 *   - OS-keyed vault  → fetch the secret from the OS credential store.
 *   - password vault  → use the CCPM_MASTER_PASSWORD env var, if set.
 * Returns null when it can't be resolved non-interactively (the CLI then
 * prompts; the server reports "locked").
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { readVaultKeySource, type KeySource } from "./vault.js";
import { loadOsSecret } from "./oskey.js";

export interface ResolvedMaster {
  master: string;
  keySource: KeySource;
}

// Memoise a successful resolution for the process lifetime. This is a no-op for
// the one-shot CLI but spares the long-lived MCP server a PowerShell/keychain
// spawn on every tool call. Only non-null results are cached, so a vault created
// after the server started still resolves on a later call.
const cache = new Map<string, ResolvedMaster>();

export async function resolveMaster(vaultPath: string): Promise<ResolvedMaster | null> {
  const cached = cache.get(vaultPath);
  if (cached) return cached;

  const source: KeySource = existsSync(vaultPath) ? readVaultKeySource(vaultPath) : "password";
  let resolved: ResolvedMaster | null = null;
  if (source === "os") {
    const secret = await loadOsSecret({ configDir: dirname(vaultPath) });
    resolved = secret ? { master: secret, keySource: "os" } : null;
  } else {
    const env = process.env.CCPM_MASTER_PASSWORD;
    resolved = env ? { master: env, keySource: "password" } : null;
  }

  if (resolved) cache.set(vaultPath, resolved);
  return resolved;
}
