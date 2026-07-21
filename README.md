# Claude Password Manager (MCP)

A small, local **MCP server** that lets Claude Code use *your own* credentials in
a controlled, auditable way — the same idea as pointing Claude at a password
manager instead of leaving secrets lying in plaintext files. Runs on **Linux,
macOS and Windows**.

Nothing here bypasses a safety boundary: MCP is exactly the supported extension
mechanism for giving an agent access to a resource you own. The value this adds
over dumping passwords into a `.env` is that access is **scoped, explicit, and
logged**:

- **Encrypted at rest** — credentials live in a single AES‑256‑GCM encrypted
  file. The key is derived from a master password (scrypt); the master password
  is never written to disk.
- **Listing never leaks secrets** — `list_credentials` returns only
  names/usernames/URLs/tags. The agent can **type** a secret into a focused
  field with `fill_credential` *without the value ever being returned to it*;
  the plaintext-revealing `get_credential` is **off by default** (opt in with
  `CCPM_ALLOW_REVEAL=1`). Either path requires a stated reason and is logged.
- **Every access is audited** — reads and writes append a line to `audit.log`
  (timestamp, action, entry name, and the reason). Passwords are never logged.
- **You stay in control** — Claude Code still prompts you to approve each tool
  call, and `CCPM_READONLY=1` disables all mutations.

Each user's vault lives on **their own machine**; this package is just the code.
Installing it does **not** give anyone your passwords.

---

## Install & use (any OS)

> Requires [Node.js](https://nodejs.org) 18+. Once published to npm, no cloning
> or building is needed — `npx` fetches and runs it.

### 1. Create your vault and add credentials

Do this yourself in a terminal — Claude only ever gets the unlocked vault.

**Recommended — OS-protected, no master password (truly one command):**

```bash
# Encrypts the vault with your OS credential store (Windows DPAPI /
# macOS Keychain / Linux libsecret). Nothing to remember, nothing in any config.
npx -y -p @mtarikucar/claude-password-manager pm-cli setup
```

The vault is then bound to this machine + user account (not portable). Want a
portable, passphrase-protected vault instead? Use `init` (**if you lose the
master password the vault cannot be recovered**):

```bash
npx -y -p @mtarikucar/claude-password-manager pm-cli init   # prompts for a master password
```

Already have a password vault and want to go passwordless? Convert it **in
place** — every entry is kept, you enter your master once:

```bash
npx -y -p @mtarikucar/claude-password-manager pm-cli rekey
```

Then add credentials (works for either vault type):

```bash
# Omit --pass to auto-generate a strong one.
npx -y -p @mtarikucar/claude-password-manager pm-cli add GitHub --user you --url https://github.com --pass 'your-token'
npx -y -p @mtarikucar/claude-password-manager pm-cli add Gmail  --user you@gmail.com --gen

# Already keep a secrets file? Bulk-load it (runs locally; values never printed).
npx -y -p @mtarikucar/claude-password-manager pm-cli import ./secrets.md

npx -y -p @mtarikucar/claude-password-manager pm-cli list   # names only, no passwords
```

The vault is created with `0600` permissions at:

| OS | Default vault path |
|----|--------------------|
| Linux / macOS | `~/.config/claude-password-manager/vault.json` |
| Windows | `%APPDATA%\claude-password-manager\vault.json` |

Override with the `CCPM_VAULT_PATH` env var.

### 2. Register the server with Claude Code

**If you used `pm-cli setup` (OS-protected), there is nothing to configure** — no
password, no env. Just register the server and restart Claude Code:

```bash
claude mcp add passwords -- npx -y -p @mtarikucar/claude-password-manager claude-password-manager
```

For a **master-password** vault (`init`), the password is read from the server's
own environment (`CCPM_MASTER_PASSWORD`). The recommended, config-free approach is
to export it in the shell you launch Claude from:

```bash
# macOS / Linux
export CCPM_MASTER_PASSWORD='your-master-password'
claude mcp add passwords -- npx -y -p @mtarikucar/claude-password-manager claude-password-manager
claude   # launch from this same shell so the server inherits the variable
```

```powershell
# Windows (PowerShell)
$env:CCPM_MASTER_PASSWORD = 'your-master-password'
claude mcp add passwords -- npx -y -p @mtarikucar/claude-password-manager claude-password-manager
claude
```

Prefer not to type it each time? Pull it from your OS keychain:

```bash
# macOS
security add-generic-password -a "$USER" -s ccpm-master -w 'your-master-password'   # once
export CCPM_MASTER_PASSWORD="$(security find-generic-password -a "$USER" -s ccpm-master -w)"

# Linux (libsecret)
secret-tool store --label='ccpm-master' service ccpm-master                          # once
export CCPM_MASTER_PASSWORD="$(secret-tool lookup service ccpm-master)"
```

Or store it in the MCP config's `env` block in `~/.claude.json` (and `chmod 600`
that file):

```jsonc
{
  "mcpServers": {
    "passwords": {
      "command": "npx",
      "args": ["-y", "-p", "@mtarikucar/claude-password-manager", "claude-password-manager"],
      "env": { "CCPM_MASTER_PASSWORD": "your-master-password" }
    }
  }
}
```

### 3. Verify & use

Restart Claude Code, then ask it to call `vault_status` — you should see
`state: unlocked`. Now a prompt like *"log into GitHub — focus the password
field, then fill my GitHub password from the vault"* triggers a `fill_credential`
call: the agent focuses the field and the server **types** the secret into it,
without the password ever being returned to the agent. Review `audit.log` any
time to see what was accessed.

---

## Tools exposed

| Tool | Reveals password? | Mutates? | Purpose |
|------|-------------------|----------|---------|
| `vault_status` | no | no | Lock state, path, entry count |
| `list_credentials` | **no** | no | Browse entries by name/user/url/tag |
| `fill_credential` | **no** — types it into the focused field | no | Auto-type a secret without returning it |
| `get_credential` | **yes** (opt-in `CCPM_ALLOW_REVEAL=1`, logged, needs reason) | no | Return one secret to the client |
| `add_credential` | returns generated pw | yes | Store a new credential |
| `update_credential` | no | yes | Change fields of an entry |
| `delete_credential` | no | yes | Remove an entry |
| `generate_password` | n/a | no | Strong password, not stored |

`pm-cli` mirrors these for terminal use: `init`, `add`, `list`, `get`,
`update`, `rm`, `passwd` (change master password), `gen`, `path`.

**About `fill_credential` (auto-type).** It types the secret into whatever
window currently has focus — like a password manager's auto-type — so focus the
target field first; it never presses Enter. The plaintext is written to the OS
helper on stdin and is **never** returned to the agent or written to the log
(only the entry name + reason are). Windows and macOS use built-in tooling
(`SendKeys` / `osascript`); Linux uses `xdotool` (X11), so `apt install xdotool`
if it is missing.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `CCPM_MASTER_PASSWORD` | Unlocks the vault. Required for all secret access. |
| `CCPM_VAULT_PATH` | Override the vault file location. |
| `CCPM_READONLY=1` | Disable all mutating tools (read-only server). |
| `CCPM_ALLOW_REVEAL=1` | Expose `get_credential`, which **returns** plaintext to the client. Off by default — `fill_credential` (auto-type) is preferred. |

---

## Development

```bash
git clone https://github.com/mtarikucar/claude-password-manager.git
cd claude-password-manager
npm install
npm run build      # compiles to dist/
npm test           # runs the vault + injector test suites
```

Run from source without publishing:

```bash
claude mcp add passwords -- node "$(pwd)/dist/server.js"
```

## Publishing (maintainer)

The package publishes via GitHub Actions (`.github/workflows/publish.yml`):

1. Create an npm **Automation** token, or a **Granular Access Token** with
   read+write to the `@mtarikucar` scope. Either bypasses npm's 2FA-to-publish
   requirement (a classic "Publish" token does not and will fail with E403).
2. Add it as a repo secret named `NPM_TOKEN`
   (Settings → Secrets and variables → Actions).
3. Trigger a release: **Actions → "Publish to npm" → Run workflow**, or push a
   tag like `v1.0.1`. Bump `version` in `package.json` for each new release.

## Security notes & limitations

- The master password gates decryption. Anyone who can read both `vault.json`
  **and** the running server's environment (or your MCP config file) can read
  your secrets — protect that config file and prefer the keychain-exported-env
  approach on shared machines.
- Secrets are decrypted in the server process's memory while it runs; this is a
  convenience tool, not a hardware security module.
- `audit.log` is your record of what the agent accessed — review it periodically.
- Losing the master password means losing the vault. There is no backdoor.
- The vault file and audit log are git-ignored and must never be committed.
