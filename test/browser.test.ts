/**
 * Tests for the browser-bridge pure logic: Chrome native-messaging framing and
 * URL/domain matching used to decide which saved credential fits a page.
 *
 * Run with `tsx test/browser.test.ts`.
 */
import { encodeMessage, MessageReader } from "../src/native-messaging.js";
import { hostFromUrl, baseDomain, domainMatches } from "../src/domain.js";
import { Vault } from "../src/vault.js";
import { handleMessage } from "../src/native-host.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// --- native messaging: 4-byte LE length prefix + JSON --------------------
{
  const buf = encodeMessage({ type: "hello", n: 1 });
  check("frame starts with the LE length of the JSON", buf.readUInt32LE(0) === buf.length - 4);
  const r = new MessageReader();
  const msgs = r.push(buf) as { type: string; n: number }[];
  check("reader decodes one full message", msgs.length === 1 && msgs[0].type === "hello" && msgs[0].n === 1);
}
{
  // A frame split across two chunks must still decode once complete.
  const buf = encodeMessage({ a: "x".repeat(50) });
  const r = new MessageReader();
  const first = r.push(buf.subarray(0, 10));
  const rest = r.push(buf.subarray(10)) as { a: string }[];
  check("partial chunk yields nothing yet", first.length === 0);
  check("completing the frame yields the message", rest.length === 1 && rest[0].a.length === 50);
}
{
  // Two frames in one chunk decode as two messages.
  const two = Buffer.concat([encodeMessage({ i: 1 }), encodeMessage({ i: 2 })]);
  const msgs = new MessageReader().push(two) as { i: number }[];
  check("two concatenated frames -> two messages", msgs.length === 2 && msgs[0].i === 1 && msgs[1].i === 2);
}

// --- domain extraction + matching ----------------------------------------
check("host strips www + path", hostFromUrl("https://www.tiktok.com/login?x=1") === "tiktok.com");
check("host keeps subdomain", hostFromUrl("https://developers.tiktok.com") === "developers.tiktok.com");
check("host from a bare domain", hostFromUrl("github.com") === "github.com");
check("host from garbage is null", hostFromUrl("not a url") === null);
check("baseDomain of a subdomain", baseDomain("developers.tiktok.com") === "tiktok.com");
check("baseDomain of a plain domain", baseDomain("tiktok.com") === "tiktok.com");

check("exact host matches", domainMatches("https://tiktok.com/x", "https://www.tiktok.com/login") === true);
check("sibling subdomains match by base", domainMatches("https://developers.tiktok.com", "https://business.tiktok.com") === true);
check("different sites do not match", domainMatches("https://github.com", "https://gitlab.com") === false);
check("no stored url never matches", domainMatches(undefined, "https://tiktok.com") === false);

/* eslint-disable @typescript-eslint/no-explicit-any */
(async () => {
  // --- native host message handling (against a temp password vault) --------
  const dir = mkdtempSync(join(tmpdir(), "ccpm-host-"));
  try {
    const vault = new Vault(join(dir, "v.json"), "m");
    vault.init();
    vault.add({ name: "TikTok", username: "alice", password: "p1", url: "https://www.tiktok.com/login" });

    const status = (await handleMessage({ type: "status" }, vault)) as any;
    check("host status: unlocked + count", status.ok && status.unlocked && status.count === 1);
    const locked = (await handleMessage({ type: "status" }, null)) as any;
    check("host status: locked when no vault", locked.ok && locked.unlocked === false);

    const q = (await handleMessage({ type: "query", url: "https://tiktok.com/foo" }, vault)) as any;
    check(
      "host query: matches by domain, no password field",
      q.ok && q.matches.length === 1 && q.matches[0].username === "alice" && !("password" in q.matches[0]),
    );

    const g = (await handleMessage({ type: "get", id: q.matches[0].id }, vault)) as any;
    check("host get: returns the password for autofill", g.ok && g.password === "p1");

    const saved = (await handleMessage({ type: "save", url: "https://github.com/login", username: "bob", password: "gh" }, vault)) as any;
    check("host save: adds a new entry", saved.ok && vault.count() === 2);

    const upd = (await handleMessage({ type: "save", url: "https://github.com/session", username: "bob", password: "gh2" }, vault)) as any;
    check("host save: same site+user updates in place (no duplicate)", upd.ok && upd.updated === true && vault.count() === 2);
    check("host save: the update changed the password", vault.get(upd.id).password === "gh2");

    const noPw = (await handleMessage({ type: "save", url: "https://x.com", password: "" }, vault)) as any;
    check("host save: refuses an empty password", noPw.ok === false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
