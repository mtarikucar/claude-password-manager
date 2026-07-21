/**
 * Tests for the secrets-file importer (src/import.ts).
 *
 * The parser turns a free-form markdown/text secrets file into structured
 * credential entries so `pm-cli import <file>` can bulk-load a vault. All
 * fixtures here are FAKE — the parser runs on the user's machine at import
 * time; real secret values never pass through the model.
 *
 * Run with `tsx test/import.test.ts`.
 */
import { parseSecretsMarkdown } from "../src/import.js";

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

// --- Headings + "key: value" lines ----------------------------------------
{
  const md = [
    "# GitHub",
    "URL: https://github.com",
    "Username: alice",
    "Password: hunter2",
    "",
    "## Gmail",
    "Email: bob@gmail.com",
    "Şifre: s3cret!",
  ].join("\n");
  const out = parseSecretsMarkdown(md);
  const gh = out.find((e) => e.name === "GitHub");
  const gmail = out.find((e) => e.name === "Gmail");
  check("github parsed", !!gh);
  check("github username", gh?.username === "alice");
  check("github password", gh?.password === "hunter2");
  check("github url", gh?.url === "https://github.com");
  check("gmail via turkish 'Şifre' key", gmail?.password === "s3cret!");
  check("gmail email as username", gmail?.username === "bob@gmail.com");
}

// --- Markdown table rows ---------------------------------------------------
{
  const md = ["## Work VPN", "| Kullanıcı | carol |", "| Parola | vpnpass |"].join("\n");
  const out = parseSecretsMarkdown(md);
  const vpn = out.find((e) => e.name === "Work VPN");
  check("table username", vpn?.username === "carol");
  check("table password", vpn?.password === "vpnpass");
}

// --- Inline "email / password" pair ---------------------------------------
{
  const md = ["## Misc", "dev@example.com / mypassword123"].join("\n");
  const out = parseSecretsMarkdown(md);
  const e = out.find((x) => x.username === "dev@example.com");
  check("inline pair username", e?.username === "dev@example.com");
  check("inline pair password", e?.password === "mypassword123");
}

// --- Entries without a password are skipped -------------------------------
{
  const md = ["## NoPass", "Username: onlyuser"].join("\n");
  const out = parseSecretsMarkdown(md);
  check("password-less section skipped", !out.some((e) => e.name === "NoPass"));
}

// --- API keys / tokens count as secrets -----------------------------------
{
  const md = ["## Stripe", "API Key: sk_test_abc123"].join("\n");
  const out = parseSecretsMarkdown(md);
  const s = out.find((e) => e.name === "Stripe");
  check("api key captured as password", s?.password === "sk_test_abc123");
}

// --- A URL value on its own line becomes url, not password ----------------
{
  const md = ["## Site", "Website: https://site.example", "Token: t0ken"].join("\n");
  const out = parseSecretsMarkdown(md);
  const s = out.find((e) => e.name === "Site");
  check("url line -> url", s?.url === "https://site.example");
  check("token line -> password", s?.password === "t0ken");
}

// --- 'key' must not false-match inside another word (monkey) ---------------
{
  const md = ["## Zoo", "Monkey: banana", "Password: realpass"].join("\n");
  const out = parseSecretsMarkdown(md);
  const z = out.find((e) => e.name === "Zoo");
  check("'monkey' not treated as key", z?.password === "realpass");
}

// --- Duplicates (same name+user+pass) are de-duplicated -------------------
{
  const md = [
    "## Dup",
    "Password: same",
    "## Dup",
    "Password: same",
  ].join("\n");
  const out = parseSecretsMarkdown(md);
  check("duplicate entries collapsed", out.filter((e) => e.name === "Dup").length === 1);
}

// --- Multiple secrets in one section -> one entry per secret --------------
{
  const md = ["## TikTok", "Client Key: ck_123", "Client Secret: cs_456", "Access Token: at_789"].join("\n");
  const out = parseSecretsMarkdown(md);
  const forTk = out.filter((e) => e.name.startsWith("TikTok"));
  check("multi-secret section yields 3 entries", forTk.length === 3);
  check("multi-secret names include the key label", forTk.some((e) => /Client Secret/i.test(e.name) && e.password === "cs_456"));
  check("multi-secret keeps each value", forTk.some((e) => e.password === "ck_123") && forTk.some((e) => e.password === "at_789"));
}

// --- Inline "(şifre X)" is split out of the username ----------------------
{
  const md = ["## FB Business", "Hesap: tarik@example.com (şifre Merhabalar06.)"].join("\n");
  const out = parseSecretsMarkdown(md);
  const e = out.find((x) => x.name === "FB Business");
  check("inline (şifre X) -> password", e?.password === "Merhabalar06.");
  check("inline (şifre X) -> username cleaned", e?.username === "tarik@example.com");
}

// --- A bare keyword value is not mistaken for a username -----------------
{
  const md = ["## Insta", "Kullanıcı: Şifre", "Password: realpass"].join("\n");
  const out = parseSecretsMarkdown(md);
  const e = out.find((x) => x.name === "Insta");
  check("bare 'Şifre' rejected as username", e?.username === undefined);
  check("real password still captured", e?.password === "realpass");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
