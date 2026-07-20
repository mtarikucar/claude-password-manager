/**
 * Append-only audit log. Every read and mutation of the vault is recorded as a
 * single JSON line so the owner can review exactly what the agent accessed and
 * when. Passwords are never written to the log — only the entry name/id.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AuditAction =
  | "list"
  | "get"
  | "add"
  | "update"
  | "delete"
  | "generate"
  | "unlock_failed";

export interface AuditRecord {
  ts: string;
  action: AuditAction;
  target?: string;
  detail?: string;
}

export class AuditLog {
  constructor(private readonly path: string) {}

  record(action: AuditAction, target?: string, detail?: string): void {
    const line: AuditRecord = {
      ts: new Date().toISOString(),
      action,
      ...(target ? { target } : {}),
      ...(detail ? { detail } : {}),
    };
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, JSON.stringify(line) + "\n", { mode: 0o600 });
    } catch {
      // Auditing must never crash the server; swallow write failures.
    }
  }
}
