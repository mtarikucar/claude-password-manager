#!/usr/bin/env node
/**
 * Claude Password Manager — MCP server (stdio transport).
 *
 * Exposes a small, auditable set of tools that let an MCP client (e.g. Claude
 * Code) read and manage credentials the user owns. Design goals:
 *
 *   - Passwords are encrypted at rest (see vault.ts); the master password is
 *     supplied out-of-band via the CCPM_MASTER_PASSWORD env var and is never
 *     persisted.
 *   - Listing never reveals secrets. The model can TYPE a secret into the
 *     focused field (fill_credential) without the value being returned; the
 *     plaintext-revealing get_credential is opt-in via CCPM_ALLOW_REVEAL=1.
 *     Every access requires a stated reason and is audit-logged.
 *   - CCPM_READONLY=1 disables all mutating tools.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import {
  Vault,
  WrongPasswordError,
  generatePassword,
  defaultVaultPath,
  auditLogPath,
  readVaultKeySource,
} from "./vault.js";
import { AuditLog } from "./audit.js";
import { injectKeystrokes, shouldExposeReveal } from "./injector.js";
import { resolveMaster } from "./master.js";

const VAULT_PATH = defaultVaultPath();
const AUDIT = new AuditLog(auditLogPath(VAULT_PATH));
const READONLY = process.env.CCPM_READONLY === "1";

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * Build an unlocked Vault from the master password in the environment.
 * Returns an error-result string instead of throwing so each tool can bail out
 * cleanly with a helpful message.
 */
async function openVault(): Promise<{ vault: Vault } | { error: string }> {
  if (!existsSync(VAULT_PATH)) {
    return {
      error: `No vault exists yet at ${VAULT_PATH}. Create one with "pm-cli setup" (OS-protected) or "pm-cli init".`,
    };
  }
  const resolved = await resolveMaster(VAULT_PATH);
  if (!resolved) {
    if (readVaultKeySource(VAULT_PATH) === "os") {
      return {
        error:
          "Vault is OS-protected but its key could not be retrieved from the OS " +
          "credential store (different user/machine, or the key file was removed).",
      };
    }
    return {
      error:
        "Vault is locked: CCPM_MASTER_PASSWORD is not set. Add it to this " +
        "server's `env` block in your MCP config, then restart the client.",
    };
  }
  const vault = new Vault(VAULT_PATH, resolved.master, resolved.keySource);
  try {
    vault.verify();
  } catch (e) {
    if (e instanceof WrongPasswordError) {
      AUDIT.record("unlock_failed");
      return { error: "The configured master password/key does not match this vault." };
    }
    return { error: `Could not open vault: ${(e as Error).message}` };
  }
  return { vault };
}

const server = new McpServer({
  name: "claude-password-manager",
  version: "1.0.6",
});

server.registerTool(
  "vault_status",
  {
    title: "Vault status",
    description:
      "Report whether the vault is unlocked, where it lives, how many " +
      "credentials it holds, and whether the server is read-only. Reveals no secrets.",
    inputSchema: {},
  },
  async () => {
    const keySource = existsSync(VAULT_PATH) ? readVaultKeySource(VAULT_PATH) : "password";
    const lines = [
      `vault path : ${VAULT_PATH}`,
      `audit log  : ${auditLogPath(VAULT_PATH)}`,
      `read-only  : ${READONLY ? "yes" : "no"}`,
      `key source : ${keySource === "os" ? "OS credential store (no master password)" : "master password (CCPM_MASTER_PASSWORD)"}`,
    ];
    const opened = await openVault();
    if ("error" in opened) {
      lines.push(`state      : locked — ${opened.error}`);
      return ok(lines.join("\n"));
    }
    lines.push(`state      : unlocked`);
    lines.push(`entries    : ${opened.vault.count()}`);
    return ok(lines.join("\n"));
  },
);

server.registerTool(
  "list_credentials",
  {
    title: "List credentials",
    description:
      "List stored credentials as names, usernames, URLs and tags. " +
      "PASSWORDS ARE NEVER RETURNED by this tool — use get_credential for that. " +
      "Optionally filter by a free-text query or an exact tag.",
    inputSchema: {
      query: z.string().optional().describe("Case-insensitive substring match on name/username/url/tag"),
      tag: z.string().optional().describe("Return only entries carrying this exact tag"),
    },
  },
  async ({ query, tag }) => {
    const opened = await openVault();
    if ("error" in opened) return fail(opened.error);
    const items = opened.vault.list({ query, tag });
    AUDIT.record("list", undefined, `${items.length} result(s)`);
    if (items.length === 0) return ok("No matching credentials.");
    const rendered = items
      .map(
        (e) =>
          `• ${e.name}  [id:${e.id}]\n    user: ${e.username ?? "—"}\n    url:  ${
            e.url ?? "—"
          }\n    tags: ${e.tags.length ? e.tags.join(", ") : "—"}`,
      )
      .join("\n");
    return ok(`${items.length} credential(s):\n${rendered}`);
  },
);

// fill_credential TYPES a secret into the focused field without ever returning
// it — this is how the model should use a password. get_credential (below)
// instead RETURNS the plaintext to the client, so it is registered only when
// explicitly opted in with CCPM_ALLOW_REVEAL=1.
server.registerTool(
  "fill_credential",
  {
    title: "Type a credential into the focused field (never returns it)",
    description:
      "Auto-type a stored credential's password (or username) into whatever " +
      "text field currently has OS focus. The value is TYPED, never returned — " +
      "it never enters the client's context. Focus the target field first " +
      "(same contract as a password manager's auto-type). Does NOT press Enter. " +
      "Every call is audit-logged.",
    inputSchema: {
      name_or_id: z.string().describe("Exact credential name (case-insensitive) or its id"),
      field: z
        .enum(["password", "username"])
        .optional()
        .describe("Which field to type; defaults to password"),
      reason: z
        .string()
        .min(3)
        .describe("Why the credential is being typed — recorded in the audit log"),
    },
  },
  async ({ name_or_id, field, reason }) => {
    const opened = await openVault();
    if ("error" in opened) return fail(opened.error);
    try {
      const entry = opened.vault.get(name_or_id);
      const which = field ?? "password";
      const value = which === "username" ? entry.username : entry.password;
      if (!value) return fail(`Credential "${entry.name}" has no ${which} to type.`);
      await injectKeystrokes(value);
      AUDIT.record("fill", `${entry.name} [${entry.id}]`, `${which}: ${reason}`);
      return ok(
        `Typed the ${which} of "${entry.name}" into the focused window. ` +
          `The value never left the vault.`,
      );
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

if (shouldExposeReveal(process.env)) {
  server.registerTool(
    "get_credential",
    {
      title: "Get a credential (reveals the password)",
      description:
        "Retrieve a single credential INCLUDING its password, by name or id. " +
        "This is the only tool that reveals a secret; every call is audit-logged. " +
        "Provide a short `reason` describing why the password is needed.",
      inputSchema: {
        name_or_id: z.string().describe("Exact credential name (case-insensitive) or its id"),
        reason: z
          .string()
          .min(3)
          .describe("Why the password is being retrieved — recorded in the audit log"),
      },
    },
    async ({ name_or_id, reason }) => {
      const opened = await openVault();
      if ("error" in opened) return fail(opened.error);
      try {
        const e = opened.vault.get(name_or_id);
        AUDIT.record("get", `${e.name} [${e.id}]`, reason);
        const out = [
          `name:     ${e.name}`,
          `username: ${e.username ?? "—"}`,
          `password: ${e.password ?? "—"}`,
          `url:      ${e.url ?? "—"}`,
          `notes:    ${e.notes ?? "—"}`,
          `tags:     ${e.tags.length ? e.tags.join(", ") : "—"}`,
        ].join("\n");
        return ok(out);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );
}

server.registerTool(
  "add_credential",
  {
    title: "Add a credential",
    description:
      "Store a new credential. If `password` is omitted, a strong random one " +
      "is generated and returned. Fails if the name already exists.",
    inputSchema: {
      name: z.string().min(1).describe("Unique label, e.g. 'GitHub' or 'work-vpn'"),
      username: z.string().optional(),
      password: z
        .string()
        .optional()
        .describe("Omit to auto-generate a strong 24-char password"),
      url: z.string().optional(),
      notes: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
  },
  async (input) => {
    if (READONLY) return fail("Server is read-only (CCPM_READONLY=1); cannot add.");
    const opened = await openVault();
    if ("error" in opened) return fail(opened.error);
    try {
      const password = input.password ?? generatePassword({ length: 24 });
      const e = opened.vault.add({ ...input, password });
      AUDIT.record("add", `${e.name} [${e.id}]`, input.password ? "user-supplied" : "generated");
      const note = input.password ? "" : `\nGenerated password: ${password}`;
      return ok(`Added "${e.name}" (id ${e.id}).${note}`);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

server.registerTool(
  "update_credential",
  {
    title: "Update a credential",
    description:
      "Modify fields of an existing credential. Only the fields you pass are " +
      "changed. Use name_or_id to select the entry.",
    inputSchema: {
      name_or_id: z.string().describe("Existing credential name or id"),
      name: z.string().optional().describe("New name"),
      username: z.string().optional(),
      password: z.string().optional(),
      url: z.string().optional(),
      notes: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
  },
  async ({ name_or_id, ...patch }) => {
    if (READONLY) return fail("Server is read-only (CCPM_READONLY=1); cannot update.");
    const opened = await openVault();
    if ("error" in opened) return fail(opened.error);
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(clean).length === 0) return fail("No fields to update were provided.");
    try {
      const e = opened.vault.update(name_or_id, clean);
      AUDIT.record("update", `${e.name} [${e.id}]`, Object.keys(clean).join(","));
      return ok(`Updated "${e.name}" (id ${e.id}). Changed: ${Object.keys(clean).join(", ")}.`);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

server.registerTool(
  "delete_credential",
  {
    title: "Delete a credential",
    description: "Permanently remove a credential by name or id.",
    inputSchema: {
      name_or_id: z.string().describe("Credential name or id to delete"),
    },
  },
  async ({ name_or_id }) => {
    if (READONLY) return fail("Server is read-only (CCPM_READONLY=1); cannot delete.");
    const opened = await openVault();
    if ("error" in opened) return fail(opened.error);
    try {
      const e = opened.vault.remove(name_or_id);
      AUDIT.record("delete", `${e.name} [${e.id}]`);
      return ok(`Deleted "${e.name}" (id ${e.id}).`);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

server.registerTool(
  "generate_password",
  {
    title: "Generate a password",
    description:
      "Return a cryptographically strong random password without storing it. " +
      "Character classes default to on; length defaults to 24.",
    inputSchema: {
      length: z.number().int().min(8).max(256).optional(),
      uppercase: z.boolean().optional(),
      lowercase: z.boolean().optional(),
      numbers: z.boolean().optional(),
      symbols: z.boolean().optional(),
    },
  },
  async (opts) => {
    AUDIT.record("generate", undefined, `length ${opts.length ?? 24}`);
    return ok(generatePassword(opts));
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe to write to — stdout is the JSON-RPC channel.
  process.stderr.write(
    `claude-password-manager ready — vault: ${VAULT_PATH}${
      READONLY ? " (read-only)" : ""
    }\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
