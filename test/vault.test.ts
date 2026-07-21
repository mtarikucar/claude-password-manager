/**
 * Minimal, dependency-free test harness (run with `npm test`).
 * Exercises encryption round-trip, wrong-password rejection, CRUD, and the
 * password generator. Uses a throwaway vault file under the OS temp dir.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, WrongPasswordError, generatePassword, readVaultKeySource } from "../src/vault.js";

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

function expectThrow(name: string, fn: () => void, type?: new (...a: any[]) => Error) {
  try {
    fn();
    failed++;
    console.error(`  FAIL ${name} (expected throw)`);
  } catch (e) {
    if (type && !(e instanceof type)) {
      failed++;
      console.error(`  FAIL ${name} (wrong error type: ${(e as Error).name})`);
    } else {
      passed++;
      console.log(`  ok   ${name}`);
    }
  }
}

const dir = mkdtempSync(join(tmpdir(), "ccpm-test-"));
const vaultPath = join(dir, "vault.json");

try {
  const v = new Vault(vaultPath, "correct-horse-battery-staple");
  v.init();
  check("vault created", v.exists());
  check("starts empty", v.count() === 0);

  const gh = v.add({ name: "GitHub", username: "alice", password: "hunter2", tags: ["dev"] });
  check("add returns id", typeof gh.id === "string" && gh.id.length > 0);
  check("count is 1", v.count() === 1);

  // Listing must not leak the password.
  const listed = v.list();
  check("list hides password", !("password" in (listed[0] as object)));
  check("list shows name", listed[0].name === "GitHub");

  // Retrieval by name and by id both return the secret.
  check("get by name reveals password", v.get("github").password === "hunter2");
  check("get by id reveals password", v.get(gh.id).password === "hunter2");

  // Duplicate names are rejected.
  expectThrow("duplicate name rejected", () => v.add({ name: "GitHub" }));

  // Update only the provided field.
  v.update("GitHub", { password: "newpass" });
  check("update changes password", v.get("GitHub").password === "newpass");
  check("update keeps username", v.get("GitHub").username === "alice");

  // Delete.
  v.remove(gh.id);
  check("count back to 0 after delete", v.count() === 0);

  // Wrong master password cannot decrypt.
  v.add({ name: "Email", password: "s3cret" });
  const wrong = new Vault(vaultPath, "wrong-password");
  expectThrow("wrong password rejected", () => wrong.verify(), WrongPasswordError);

  // Correct password still works (auth tag / KDF intact).
  const reopened = new Vault(vaultPath, "correct-horse-battery-staple");
  check("reopen with correct password", reopened.get("Email").password === "s3cret");

  // Password generator.
  const p = generatePassword({ length: 32, symbols: false });
  check("generated length", p.length === 32);
  check("generated no symbols", /^[A-Za-z0-9]+$/.test(p));
  check("generated is random", generatePassword() !== generatePassword());

  // Change master password re-encrypts and old password stops working.
  reopened.changePassword("brand-new-master");
  const oldKey = new Vault(vaultPath, "correct-horse-battery-staple");
  expectThrow("old master fails after passwd", () => oldKey.verify(), WrongPasswordError);
  const newKey = new Vault(vaultPath, "brand-new-master");
  check("new master works after passwd", newKey.get("Email").password === "s3cret");

  // Key-source marker: default is "password"; an OS-keyed vault records "os".
  check("default vault keySource is password", readVaultKeySource(vaultPath) === "password");
  const osPath = join(dir, "os-vault.json");
  const osSecret = "os-managed-random-secret";
  const osVault = new Vault(osPath, osSecret, "os");
  osVault.init();
  osVault.add({ name: "OsEntry", password: "kept" });
  check("os vault reports keySource os", readVaultKeySource(osPath) === "os");
  check("os vault decrypts with its secret", new Vault(osPath, osSecret, "os").get("OsEntry").password === "kept");

  // reKey converts a populated password vault to OS-protected, losslessly.
  const rkPath = join(dir, "rekey-vault.json");
  const rk = new Vault(rkPath, "old-master");
  rk.init();
  rk.add({ name: "Keeper", username: "u", password: "p" });
  rk.reKey("new-os-secret", "os");
  check("reKey switches keySource to os", readVaultKeySource(rkPath) === "os");
  check("reKey preserves entries under the new secret", new Vault(rkPath, "new-os-secret", "os").get("Keeper").password === "p");
  check("reKey invalidates the old master", (() => { try { new Vault(rkPath, "old-master").get("Keeper"); return false; } catch { return true; } })());
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
