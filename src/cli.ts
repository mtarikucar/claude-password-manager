#!/usr/bin/env node
/**
 * pm-cli — manage the vault directly from a terminal, without any MCP client.
 *
 * The master password is read from CCPM_MASTER_PASSWORD if set, otherwise
 * prompted interactively (never echoed). This lets you seed and audit the vault
 * yourself; the agent only ever sees what you choose to store.
 *
 * Usage:
 *   pm-cli init
 *   pm-cli add <name> [--user U] [--url URL] [--tags a,b] [--gen] [--pass P]
 *   pm-cli list [query]
 *   pm-cli get <name|id>
 *   pm-cli update <name|id> [--user U] [--pass P] [--url URL] [--notes N] [--tags a,b]
 *   pm-cli rm <name|id>
 *   pm-cli passwd            # change the master password
 *   pm-cli gen [length]
 *   pm-cli path              # print vault + audit-log locations
 */
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { Vault, WrongPasswordError, generatePassword, defaultVaultPath, auditLogPath } from "./vault.js";
import { storeOsSecret } from "./oskey.js";
import { resolveMaster } from "./master.js";
import { browserInstall } from "./browser-install.js";

const VAULT_PATH = defaultVaultPath();

function prompt(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (hidden) {
    // Suppress echo by muting the output stream while typing.
    const out = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput?: (s: string) => void };
    out._writeToOutput = () => {};
  }
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function getMaster(confirm = false): Promise<string> {
  if (process.env.CCPM_MASTER_PASSWORD) return process.env.CCPM_MASTER_PASSWORD;
  const pw = await prompt("Master password: ", true);
  if (confirm) {
    const again = await prompt("Confirm master password: ", true);
    if (pw !== again) {
      console.error("Passwords do not match.");
      process.exit(1);
    }
  }
  return pw;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case "path": {
      console.log(`vault:     ${VAULT_PATH}`);
      console.log(`audit log: ${auditLogPath(VAULT_PATH)}`);
      return;
    }
    case "gen": {
      const length = positional[0] ? parseInt(positional[0], 10) : 24;
      console.log(generatePassword({ length }));
      return;
    }
    case "init": {
      const master = await getMaster(true);
      const vault = new Vault(VAULT_PATH, master);
      if (vault.exists()) {
        console.error(`Vault already exists at ${VAULT_PATH}`);
        process.exit(1);
      }
      vault.init();
      console.log(`Created empty vault at ${VAULT_PATH}`);
      return;
    }
    case "add": {
      const name = positional[0];
      if (!name) return usage("add needs a <name>");
      const vault = await open();
      const password = flags.gen
        ? generatePassword({ length: 24 })
        : typeof flags.pass === "string"
          ? flags.pass
          : await prompt("Password (blank to auto-generate): ", true);
      const finalPassword = password || generatePassword({ length: 24 });
      const e = vault.add({
        name,
        username: typeof flags.user === "string" ? flags.user : undefined,
        password: finalPassword,
        url: typeof flags.url === "string" ? flags.url : undefined,
        notes: typeof flags.notes === "string" ? flags.notes : undefined,
        tags: typeof flags.tags === "string" ? flags.tags.split(",").map((s) => s.trim()) : undefined,
      });
      console.log(`Added "${e.name}" (id ${e.id}).`);
      if (!flags.pass) console.log(`Password: ${finalPassword}`);
      return;
    }
    case "setup": {
      if (existsSync(VAULT_PATH)) {
        console.error(`A vault already exists at ${VAULT_PATH}. Remove it first to re-run setup.`);
        process.exit(1);
      }
      // A random secret plays the master's role; the OS credential store keeps
      // it for this user account, so no password is ever needed on this machine.
      const secret = generatePassword({ length: 44, symbols: false });
      try {
        await storeOsSecret(secret, { configDir: dirname(VAULT_PATH) });
      } catch (e) {
        console.error(`Could not store the key in the OS credential store: ${(e as Error).message}`);
        process.exit(1);
      }
      new Vault(VAULT_PATH, secret, "os").init();
      console.log(`Created an OS-protected vault at ${VAULT_PATH}.`);
      console.log("No master password needed on this machine — the OS keeps the key for your user account.\n");
      console.log("Next:");
      console.log("  # add your credentials (or: pm-cli import secrets.md)");
      console.log("  npx -y -p @mtarikucar/claude-password-manager pm-cli add GitHub --user you --gen");
      console.log("  # register with Claude Code — NO secret in the config:");
      console.log("  claude mcp add passwords -- npx -y -p @mtarikucar/claude-password-manager claude-password-manager");
      console.log("  # then restart Claude Code");
      return;
    }
    case "rekey": {
      if (!existsSync(VAULT_PATH)) {
        console.error(`No vault at ${VAULT_PATH}. Nothing to convert.`);
        process.exit(1);
      }
      const toPassword = flags["to-password"] === true;
      // open() decrypts with the current secret — it prompts for the master if
      // this is a password vault, or reads the OS key if it is already OS-keyed.
      const vault = await open();
      if (toPassword) {
        const next = await prompt("New master password: ", true);
        const again = await prompt("Confirm new master password: ", true);
        if (next !== again) {
          console.error("Passwords do not match.");
          process.exit(1);
        }
        vault.reKey(next, "password");
        console.log("Vault converted to master-password protection.");
        console.log("The server now needs CCPM_MASTER_PASSWORD (env or MCP config) to unlock it.");
      } else {
        const secret = generatePassword({ length: 44, symbols: false });
        try {
          await storeOsSecret(secret, { configDir: dirname(VAULT_PATH) });
        } catch (e) {
          console.error(`Could not store the key in the OS credential store: ${(e as Error).message}`);
          process.exit(1);
        }
        vault.reKey(secret, "os");
        console.log("Vault converted to OS-protected — no master password needed on this machine, nothing lost.\n");
        console.log("If you registered the server with CCPM_MASTER_PASSWORD before, re-register WITHOUT it:");
        console.log("  claude mcp remove passwords");
        console.log("  claude mcp add passwords -- npx -y -p @mtarikucar/claude-password-manager claude-password-manager");
        console.log("  # then restart Claude Code");
      }
      return;
    }
    case "list": {
      const vault = await open();
      const items = vault.list({ query: positional[0] });
      if (items.length === 0) return console.log("No credentials.");
      for (const e of items) {
        console.log(`• ${e.name} [id:${e.id}] user=${e.username ?? "—"} url=${e.url ?? "—"} tags=${e.tags.join(",") || "—"}`);
      }
      return;
    }
    case "get": {
      const key = positional[0];
      if (!key) return usage("get needs a <name|id>");
      const vault = await open();
      const e = vault.get(key);
      console.log(`name:     ${e.name}`);
      console.log(`username: ${e.username ?? "—"}`);
      console.log(`password: ${e.password ?? "—"}`);
      console.log(`url:      ${e.url ?? "—"}`);
      console.log(`notes:    ${e.notes ?? "—"}`);
      console.log(`tags:     ${e.tags.join(", ") || "—"}`);
      return;
    }
    case "update": {
      const key = positional[0];
      if (!key) return usage("update needs a <name|id>");
      const vault = await open();
      const patch: Record<string, unknown> = {};
      if (typeof flags.name === "string") patch.name = flags.name;
      if (typeof flags.user === "string") patch.username = flags.user;
      if (typeof flags.pass === "string") patch.password = flags.pass;
      if (typeof flags.url === "string") patch.url = flags.url;
      if (typeof flags.notes === "string") patch.notes = flags.notes;
      if (typeof flags.tags === "string") patch.tags = flags.tags.split(",").map((s) => s.trim());
      const e = vault.update(key, patch);
      console.log(`Updated "${e.name}" (id ${e.id}).`);
      return;
    }
    case "rm": {
      const key = positional[0];
      if (!key) return usage("rm needs a <name|id>");
      const vault = await open();
      const e = vault.remove(key);
      console.log(`Deleted "${e.name}" (id ${e.id}).`);
      return;
    }
    case "passwd": {
      const vault = await open();
      const next = await prompt("New master password: ", true);
      const again = await prompt("Confirm new master password: ", true);
      if (next !== again) {
        console.error("Passwords do not match.");
        process.exit(1);
      }
      vault.changePassword(next);
      console.log("Master password changed.");
      return;
    }
    case "browser-install": {
      const r = browserInstall();
      console.log(`Native host registered for: ${r.registered.length ? r.registered.join(", ") : "(no supported browser found)"}`);
      console.log(`Host files: ${r.hostDir}\n`);
      console.log("Load the extension (one time):");
      console.log("  1. Open  chrome://extensions");
      console.log("  2. Enable 'Developer mode' (top-right)");
      console.log("  3. Click 'Load unpacked' and select this folder:");
      console.log(`       ${r.extensionDir}`);
      console.log(`     (its Extension ID must be  ${r.extensionId})\n`);
      console.log("Done — log into any site: a 'Kaydet' banner offers to save it,");
      console.log("and saved logins autofill when you focus the login fields.");
      return;
    }
    default:
      return usage();
  }
}

async function open(): Promise<Vault> {
  if (!existsSync(VAULT_PATH)) {
    console.error(`No vault at ${VAULT_PATH}. Run "pm-cli setup" (OS-protected) or "pm-cli init" first.`);
    process.exit(1);
  }
  // OS-keyed vaults resolve their secret from the OS store; password vaults use
  // the env var or an interactive prompt.
  const resolved = await resolveMaster(VAULT_PATH);
  const master = resolved ? resolved.master : await getMaster();
  const keySource = resolved ? resolved.keySource : "password";
  const vault = new Vault(VAULT_PATH, master, keySource);
  try {
    vault.verify();
  } catch (e) {
    if (e instanceof WrongPasswordError) {
      console.error(keySource === "os" ? "The OS-stored key does not match this vault." : "Wrong master password.");
      process.exit(1);
    }
    throw e;
  }
  return vault;
}

function usage(msg?: string) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    [
      "pm-cli — Claude Password Manager vault tool",
      "",
      "Commands:",
      "  setup                      create an OS-protected vault — no master password (recommended)",
      "  init                       create a password-protected vault",
      "  rekey [--to-password]      convert the vault to OS-protected (default) or back to a password",
      "  add <name> [flags]         add a credential (--user --url --notes --tags a,b --pass P | --gen)",
      "  list [query]               list credentials (no passwords)",
      "  get <name|id>              show one credential including its password",
      "  update <name|id> [flags]   change fields (--name --user --pass --url --notes --tags)",
      "  rm <name|id>               delete a credential",
      "  passwd                     change the master password",
      "  gen [length]               print a strong password (not stored)",
      "  path                       print vault + audit-log paths",
      "  browser-install            install the Chrome/Edge extension bridge (auto-save + autofill)",
    ].join("\n"),
  );
  process.exit(msg ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
