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
import { readFileSync } from "node:fs";
import { Vault, WrongPasswordError, generatePassword, defaultVaultPath, auditLogPath } from "./vault.js";
import { parseSecretsMarkdown } from "./import.js";

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
    case "import": {
      const file = positional[0];
      if (!file) return usage("import needs a <file> (e.g. secrets.md)");
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        console.error(`Cannot read file: ${file}`);
        process.exit(1);
      }
      const parsed = parseSecretsMarkdown(text);
      if (parsed.length === 0) {
        console.log("No credentials recognised in that file. Add them individually with `pm-cli add`.");
        return;
      }
      const vault = await open();
      let added = 0;
      const skipped: string[] = [];
      for (const c of parsed) {
        try {
          vault.add({ name: c.name, username: c.username, password: c.password, url: c.url });
          added++;
          console.log(`  + ${c.name}`);
        } catch (e) {
          skipped.push(`${c.name} (${(e as Error).message.split(".")[0]})`);
        }
      }
      console.log(`\nImported ${added} credential(s); skipped ${skipped.length}. No passwords were printed.`);
      if (skipped.length) console.log(`Skipped: ${skipped.join(", ")}`);
      console.log("Review them with `pm-cli list`.");
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
    case "import": {
      const file = positional[0];
      if (!file) return usage("import needs a <file> (e.g. secrets.md)");
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        console.error(`Cannot read file: ${file}`);
        process.exit(1);
      }
      const parsed = parseSecretsMarkdown(text);
      if (parsed.length === 0) {
        console.log("No credentials recognised in that file.");
        return;
      }
      const vault = await open();
      let added = 0;
      const skipped: string[] = [];
      for (const c of parsed) {
        try {
          vault.add({ name: c.name, username: c.username, password: c.password, url: c.url });
          console.log(`  + ${c.name}`);
          added++;
        } catch (e) {
          skipped.push(`${c.name} (${(e as Error).message.split(".")[0]})`);
        }
      }
      console.log(`\nImported ${added} credential(s); skipped ${skipped.length}.`);
      if (skipped.length) console.log(`Skipped: ${skipped.join(", ")}`);
      console.log('No passwords were printed. Review names with "pm-cli list".');
      return;
    }
    default:
      return usage();
  }
}

async function open(): Promise<Vault> {
  const master = await getMaster();
  const vault = new Vault(VAULT_PATH, master);
  if (!vault.exists()) {
    console.error(`No vault at ${VAULT_PATH}. Run "pm-cli init" first.`);
    process.exit(1);
  }
  try {
    vault.verify();
  } catch (e) {
    if (e instanceof WrongPasswordError) {
      console.error("Wrong master password.");
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
      "  init                       create a new encrypted vault",
      "  add <name> [flags]         add a credential (--user --url --notes --tags a,b --pass P | --gen)",
      "  import <file>              bulk-load credentials from a markdown/text secrets file",
      "  list [query]               list credentials (no passwords)",
      "  get <name|id>              show one credential including its password",
      "  update <name|id> [flags]   change fields (--name --user --pass --url --notes --tags)",
      "  rm <name|id>               delete a credential",
      "  passwd                     change the master password",
      "  import <file>              bulk-load credentials from a markdown/text file (no values printed)",
      "  gen [length]               print a strong password (not stored)",
      "  path                       print vault + audit-log paths",
    ].join("\n"),
  );
  process.exit(msg ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
