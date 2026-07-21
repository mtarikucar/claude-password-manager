/**
 * Best-effort importer for a free-form secrets file (markdown or plain text).
 *
 * Turns a human-maintained secrets document into structured credential entries
 * so `pm-cli import <file>` can bulk-load a vault. It recognises three shapes,
 * grouped under the nearest `#`/`##`/`###` heading (used as the entry name):
 *
 *   - `key: value` lines   — Password:, Şifre:, Username:, Email:, URL:, Token:…
 *   - markdown table rows  — `| Kullanıcı | carol |` / `| Parola | vpnpass |`
 *   - inline pairs         — `user@example.com / secret`
 *
 * The heuristics are deliberately conservative; the CLI prints what it added so
 * you can review with `pm-cli list`. This runs on YOUR machine — secret values
 * never leave it.
 */
export interface ParsedCredential {
  name: string;
  username?: string;
  password?: string;
  url?: string;
}

// Field-name classifiers. Short ambiguous words are word-bounded so "Monkey"
// isn't mistaken for a "key".
const USER_KEYS = /(kullan|user|e-?posta|e-?mail|\bmail\b|giri[sş]|login|hesap|account)/i;
const PASS_KEYS = /([sş]ifre|parola|password|\bpass\b|\bpwd\b|\btoken\b|\bsecret\b|\bkey\b)/i;
const URL_ANYWHERE = /https?:\/\/[^\s|)\]`]+/;
const URL_START = /^https?:\/\//i;

function clean(v: string): string {
  return v.trim().replace(/[`*]/g, "").trim();
}

export function parseSecretsMarkdown(text: string): ParsedCredential[] {
  const out: ParsedCredential[] = [];
  // Split into sections, keeping each heading at the start of its chunk.
  const sections = text.split(/(?=^#{1,6}\s+)/m);

  for (const raw of sections) {
    const sec = raw.trim();
    if (!sec) continue;
    const lines = sec.split(/\r?\n/);

    const heading = lines[0].match(/^#{1,6}\s+(.*)$/);
    const name = (heading ? heading[1] : lines[0]).replace(/[`*|#]/g, "").trim() || "item";

    let username: string | undefined;
    let password: string | undefined;
    let url: string | undefined;

    for (const line of lines) {
      // Markdown table row: | key | value |
      const tbl = line.match(/^\s*\|([^|]+)\|([^|]+)\|/);
      if (tbl) {
        const k = tbl[1].trim();
        const v = clean(tbl[2]);
        if (URL_START.test(v)) url ??= v;
        else if (PASS_KEYS.test(k) && !PASS_KEYS.test(v) && !password) password = v;
        else if (USER_KEYS.test(k) && !username) username = v;
        continue;
      }
      // key: value  (or key = value), optionally a "- " / "* " bullet
      const kv = line.match(/^[ \t]*[-*]?[ \t]*([^\n:=|]{2,40}?)[ \t]*[:=][ \t]*(\S.*?)[ \t]*$/);
      if (kv) {
        const k = kv[1].trim();
        const v = clean(kv[2]);
        if (URL_START.test(v)) {
          url ??= v;
        } else if (PASS_KEYS.test(k) && !PASS_KEYS.test(v) && !password) {
          password = v;
        } else if (USER_KEYS.test(k) && !username) {
          username = v;
        }
      }
    }

    if (!url) {
      const u = sec.match(URL_ANYWHERE);
      if (u) url = u[0];
    }

    if (password) out.push({ name, username, password, url });

    // Inline "email / password" or "email | password" (single line only).
    const pair = /([\w.\-+]+@[\w.\-]+\.\w{2,})[ \t]*[/|][ \t]*([^\s|`]{4,})/g;
    let m: RegExpExecArray | null;
    while ((m = pair.exec(sec)) !== null) {
      out.push({
        name: `${name} (${m[1]})`,
        username: m[1],
        password: m[2].replace(/[`*.,;]+$/, ""),
        url,
      });
    }
  }

  // De-duplicate identical (name, username, password) triples.
  const seen = new Set<string>();
  return out.filter((r) => {
    const key = `${r.name}|${r.username ?? ""}|${r.password ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
