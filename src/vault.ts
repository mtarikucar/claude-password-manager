/**
 * Encrypted vault core.
 *
 * The vault is a single JSON file on disk. Everything except the KDF
 * parameters is encrypted with AES-256-GCM, using a key derived from a master
 * password via scrypt. The plaintext (an array of credential entries) never
 * touches the disk — only the master password can decrypt it, and that
 * password is never stored anywhere by this code.
 */
import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Credential {
  id: string;
  name: string;
  username?: string;
  password?: string;
  url?: string;
  notes?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export type KeySource = "password" | "os";

interface EncryptedVaultFile {
  version: 1;
  /** Where the master secret comes from: a user password (default) or the OS store. */
  keySource?: KeySource;
  kdf: { algo: "scrypt"; salt: string; N: number; r: number; p: number; keylen: number };
  cipher: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
}

interface VaultData {
  entries: Credential[];
}

const KDF_PARAMS = { N: 1 << 15, r: 8, p: 1, keylen: 32 } as const;
// scrypt with N=2^15 needs a higher maxmem than the default 32 MB.
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

/** Per-user config directory, resolved per platform. */
export function configDir(): string {
  // Windows: %APPDATA%\claude-password-manager
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "claude-password-manager");
  }
  // macOS / Linux: $XDG_CONFIG_HOME or ~/.config
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "claude-password-manager");
}

export function defaultVaultPath(): string {
  if (process.env.CCPM_VAULT_PATH) return process.env.CCPM_VAULT_PATH;
  return join(configDir(), "vault.json");
}

export function auditLogPath(vaultPath: string): string {
  return join(dirname(vaultPath), "audit.log");
}

/**
 * Read a vault's key-source marker WITHOUT decrypting it, so a caller can
 * decide where to get the master secret (user password vs OS store).
 */
export function readVaultKeySource(path: string): KeySource {
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as EncryptedVaultFile;
    return file.keySource === "os" ? "os" : "password";
  } catch {
    return "password";
  }
}

function deriveKey(masterPassword: string, salt: Buffer): Buffer {
  return scryptSync(masterPassword.normalize("NFKC"), salt, KDF_PARAMS.keylen, {
    N: KDF_PARAMS.N,
    r: KDF_PARAMS.r,
    p: KDF_PARAMS.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

function serialize(data: VaultData, masterPassword: string, keySource: KeySource = "password"): EncryptedVaultFile {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(masterPassword, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version: 1,
    keySource,
    kdf: { algo: "scrypt", salt: salt.toString("base64"), ...KDF_PARAMS },
    cipher: "aes-256-gcm",
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export class WrongPasswordError extends Error {
  constructor() {
    super("Master password is incorrect, or the vault file is corrupt.");
    this.name = "WrongPasswordError";
  }
}

function deserialize(file: EncryptedVaultFile, masterPassword: string): VaultData {
  const salt = Buffer.from(file.kdf.salt, "base64");
  const key = scryptSync(masterPassword.normalize("NFKC"), salt, file.kdf.keylen, {
    N: file.kdf.N,
    r: file.kdf.r,
    p: file.kdf.p,
    maxmem: SCRYPT_MAXMEM,
  });
  const iv = Buffer.from(file.iv, "base64");
  const authTag = Buffer.from(file.authTag, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(file.ciphertext, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as VaultData;
  } catch {
    // A bad key makes GCM authentication fail in decipher.final().
    throw new WrongPasswordError();
  }
}

export class Vault {
  constructor(
    private readonly path: string,
    private readonly masterPassword: string,
    private readonly keySource: KeySource = "password",
  ) {}

  exists(): boolean {
    return existsSync(this.path);
  }

  /** Create an empty encrypted vault. Refuses to clobber an existing one. */
  init(): void {
    if (this.exists()) {
      throw new Error(`Vault already exists at ${this.path}`);
    }
    this.write({ entries: [] });
  }

  private read(): VaultData {
    if (!this.exists()) {
      throw new Error(
        `No vault found at ${this.path}. Run "pm-cli init" first.`,
      );
    }
    const raw = readFileSync(this.path, "utf8");
    const file = JSON.parse(raw) as EncryptedVaultFile;
    return deserialize(file, this.masterPassword);
  }

  private write(data: VaultData): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const file = serialize(data, this.masterPassword, this.keySource);
    writeFileSync(this.path, JSON.stringify(file, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* best effort on platforms without POSIX permissions */
    }
  }

  /** Verify the master password can decrypt the vault. Throws if not. */
  verify(): void {
    this.read();
  }

  list(filter?: { query?: string; tag?: string }): Omit<Credential, "password">[] {
    const q = filter?.query?.toLowerCase();
    const tag = filter?.tag?.toLowerCase();
    return this.read()
      .entries.filter((e) => {
        if (tag && !e.tags.map((t) => t.toLowerCase()).includes(tag)) return false;
        if (!q) return true;
        return (
          e.name.toLowerCase().includes(q) ||
          (e.username?.toLowerCase().includes(q) ?? false) ||
          (e.url?.toLowerCase().includes(q) ?? false) ||
          e.tags.some((t) => t.toLowerCase().includes(q))
        );
      })
      .map(({ password: _password, ...rest }) => rest);
  }

  /** Resolve a single entry by id, or by exact/unique case-insensitive name. */
  private resolve(nameOrId: string): Credential {
    const entries = this.read().entries;
    const byId = entries.find((e) => e.id === nameOrId);
    if (byId) return byId;
    const key = nameOrId.toLowerCase();
    const byName = entries.filter((e) => e.name.toLowerCase() === key);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new Error(
        `Multiple credentials named "${nameOrId}". Use the id instead: ${byName
          .map((e) => e.id)
          .join(", ")}`,
      );
    }
    throw new Error(`No credential found matching "${nameOrId}".`);
  }

  get(nameOrId: string): Credential {
    return this.resolve(nameOrId);
  }

  add(input: {
    name: string;
    username?: string;
    password?: string;
    url?: string;
    notes?: string;
    tags?: string[];
  }): Credential {
    const data = this.read();
    if (data.entries.some((e) => e.name.toLowerCase() === input.name.toLowerCase())) {
      throw new Error(
        `A credential named "${input.name}" already exists. Use update instead, or pick a different name.`,
      );
    }
    const now = new Date().toISOString();
    const entry: Credential = {
      id: randomBytes(8).toString("hex"),
      name: input.name,
      username: input.username,
      password: input.password,
      url: input.url,
      notes: input.notes,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    data.entries.push(entry);
    this.write(data);
    return entry;
  }

  update(
    nameOrId: string,
    patch: Partial<Pick<Credential, "name" | "username" | "password" | "url" | "notes" | "tags">>,
  ): Credential {
    const data = this.read();
    const target = this.resolveIn(data.entries, nameOrId);
    Object.assign(target, patch);
    target.updatedAt = new Date().toISOString();
    this.write(data);
    return target;
  }

  remove(nameOrId: string): Credential {
    const data = this.read();
    const target = this.resolveIn(data.entries, nameOrId);
    data.entries = data.entries.filter((e) => e.id !== target.id);
    this.write(data);
    return target;
  }

  private resolveIn(entries: Credential[], nameOrId: string): Credential {
    const byId = entries.find((e) => e.id === nameOrId);
    if (byId) return byId;
    const key = nameOrId.toLowerCase();
    const byName = entries.filter((e) => e.name.toLowerCase() === key);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new Error(
        `Multiple credentials named "${nameOrId}". Use the id instead: ${byName
          .map((e) => e.id)
          .join(", ")}`,
      );
    }
    throw new Error(`No credential found matching "${nameOrId}".`);
  }

  count(): number {
    return this.read().entries.length;
  }

  /** Change the master password by re-encrypting under a new key. */
  changePassword(newPassword: string): void {
    const data = this.read();
    const rekeyed = new Vault(this.path, newPassword);
    rekeyed.write(data);
  }
}

/**
 * Generate a cryptographically strong password using rejection sampling over
 * the chosen alphabet (avoids modulo bias).
 */
export function generatePassword(opts?: {
  length?: number;
  uppercase?: boolean;
  lowercase?: boolean;
  numbers?: boolean;
  symbols?: boolean;
}): string {
  const length = Math.max(8, Math.min(opts?.length ?? 24, 256));
  let alphabet = "";
  if (opts?.lowercase ?? true) alphabet += "abcdefghijklmnopqrstuvwxyz";
  if (opts?.uppercase ?? true) alphabet += "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  if (opts?.numbers ?? true) alphabet += "0123456789";
  if (opts?.symbols ?? true) alphabet += "!@#$%^&*()-_=+[]{};:,.<>?";
  if (alphabet.length === 0) alphabet = "abcdefghijklmnopqrstuvwxyz";

  const max = 256 - (256 % alphabet.length);
  const out: string[] = [];
  while (out.length < length) {
    const bytes = randomBytes(length);
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      if (bytes[i] < max) out.push(alphabet[bytes[i] % alphabet.length]);
    }
  }
  return out.join("");
}

/** Constant-time-ish equality for comparing user-supplied confirmations. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
