#!/usr/bin/env node
/**
 * Native-messaging host for the Claude Password Manager browser extension.
 *
 * Chrome launches this process and speaks the 4-byte-length + JSON protocol
 * over stdin/stdout. The host opens the local OS-protected (or password) vault
 * and answers:
 *
 *   { type:"status" }                                  -> { ok, unlocked, count }
 *   { type:"query",  url }                             -> { ok, matches:[{id,name,username}] }
 *   { type:"get",    id }                              -> { ok, username, password }   (autofill)
 *   { type:"save",   name?, username?, password, url } -> { ok, id, updated? }          (capture)
 *
 * Credentials flow only between the browser and the vault — no AI is involved,
 * so there is no plaintext boundary to cross.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Vault, defaultVaultPath } from "./vault.js";
import { resolveMaster } from "./master.js";
import { encodeMessage, MessageReader } from "./native-messaging.js";
import { hostFromUrl } from "./domain.js";

const VAULT_PATH = defaultVaultPath();

function send(msg: unknown): void {
  process.stdout.write(encodeMessage(msg));
}

async function openVault(): Promise<Vault | null> {
  if (!existsSync(VAULT_PATH)) return null;
  const resolved = await resolveMaster(VAULT_PATH);
  if (!resolved) return null;
  const v = new Vault(VAULT_PATH, resolved.master, resolved.keySource);
  try {
    v.verify();
  } catch {
    return null;
  }
  return v;
}

function uniqueName(vault: Vault, base: string): string {
  const existing = new Set(vault.list().map((e) => e.name.toLowerCase()));
  if (!existing.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const cand = `${base} (${i})`;
    if (!existing.has(cand.toLowerCase())) return cand;
  }
  return `${base} (${Date.now()})`;
}

export async function handleMessage(msg: Record<string, unknown>, vault: Vault | null): Promise<unknown> {
  const type = msg.type;
  if (type === "status") {
    return { ok: true, unlocked: !!vault, count: vault ? vault.count() : 0 };
  }
  if (!vault) return { ok: false, error: "vault-locked" };

  try {
    switch (type) {
      case "query": {
        const matches = vault
          .matchUrl(String(msg.url ?? ""))
          .map((e) => ({ id: e.id, name: e.name, username: e.username ?? "" }));
        return { ok: true, matches };
      }
      case "get": {
        const e = vault.get(String(msg.id));
        return { ok: true, id: e.id, name: e.name, username: e.username ?? "", password: e.password ?? "" };
      }
      case "save": {
        const password = typeof msg.password === "string" ? msg.password : "";
        if (!password) return { ok: false, error: "no-password" };
        const url = typeof msg.url === "string" ? msg.url : undefined;
        const username = typeof msg.username === "string" ? msg.username : undefined;
        // Re-login on a known site+user updates in place instead of duplicating.
        const known = url
          ? vault.matchUrl(url).find((e) => (e.username ?? "") === (username ?? ""))
          : undefined;
        if (known) {
          vault.update(known.id, { password });
          return { ok: true, id: known.id, updated: true };
        }
        const label = typeof msg.name === "string" && msg.name ? msg.name : hostFromUrl(url ?? "") ?? "Saved login";
        const e = vault.add({ name: uniqueName(vault, String(label).slice(0, 100)), username, password, url });
        return { ok: true, id: e.id };
      }
      default:
        return { ok: false, error: "unknown-type" };
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function main(): Promise<void> {
  const reader = new MessageReader();
  process.stdin.on("data", (chunk: Buffer) => {
    for (const raw of reader.push(chunk)) {
      const msg = (raw ?? {}) as Record<string, unknown>;
      // Re-open the vault per message so a vault created/rekeyed after launch is
      // picked up (resolveMaster memoises the OS key, so this stays cheap).
      openVault()
        .then((vault) => handleMessage(msg, vault))
        .then((resp) => send({ ...(resp as Record<string, unknown>), _rid: msg._rid }))
        .catch((err) => send({ ok: false, error: String(err), _rid: msg._rid }));
    }
  });
  process.stdin.on("end", () => process.exit(0));
  // Keep the event loop alive.
  process.stdin.resume();
}

// Only run the stdin loop when Chrome launches this file directly — importing it
// (e.g. from tests) must not start listening on stdin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
