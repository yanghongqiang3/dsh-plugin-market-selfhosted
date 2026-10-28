# dsh-plugin-market-selfhosted

**English** | [中文](README.zh.md)

An internal plugin marketplace for DSH: **a private marketplace server plus a DSH client plugin**.

It does not drop plugin archives into a shared directory. It provides a controlled distribution path: admins publish and grant on the server, while users browse, install and update from the **Internal Plugin Market** (「内部插件市场」) entry in the DSH sidebar. Accounts, permissions, artifacts and audit data all live on the server; the local side only writes files into the current profile.

| Part | Location | Responsibility | Authoritative |
|---|---|---|---|
| **Market server** | `server/` | accounts / groups / rules / sessions / catalog / artifact storage / audit / statistics | **yes** |
| **DSH client plugin** | `lib/` + `web/` | installs the plugins, bundles and skills the server **authorized** into the current DSH profile | no |

**Why the split is necessary**: if accounts and permissions lived on every machine, each machine would get its own SQLite file; an account created by an admin would not exist for anyone else, a rule change would only apply to the person who made it, and the audit trail would be scattered across disks. "Central management" would not exist. So authorization decisions, artifact bytes and the ledger live on the server; the local plugin makes no authorization decisions of its own and only fetches what the server allows.

> **Note:** the DSH-side UI (sidebar entry, install page, console) is currently Chinese-only. The README and the marketplace metadata are bilingual.

---

## Contents

- [Installation](#installation)
- [Use cases](#use-cases)
- [Features](#features)
- [Architecture and data flow](#architecture-and-data-flow)
- [Local setup](#local-setup)
- [Day-to-day usage](#day-to-day-usage)
- [Server deployment](#server-deployment)
- [Operations](#operations)
- [Security](#security)
- [Tests](#tests)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)

---

## Installation

Deploy the market server first (local machine, LAN or Docker; see [Local setup](#local-setup)), then install the DSH client plugin:

```bash
# The desktop app uses profile "desktop"; `dsh web` uses "web".
dsh plugin --profile desktop add github:yanghongqiang3/dsh-plugin-market-selfhosted
```

Tags matching `v*` publish a prebuilt tarball through GitHub Releases. You can also download it and install locally:

```bash
dsh plugin --profile desktop add ./dsh-plugin-market-selfhosted.tgz
```

After installation, set `MARKET_SERVICE_URL` and restart DSH; the **Internal Plugin Market** entry appears at the bottom of the sidebar.

---

## Use cases

- **Distribute DSH plugins inside a team**: in-house tools, internal integrations and bundles install from one marketplace instead of being passed around as `.tgz` files.
- **Distribute skills**: a package containing only `SKILL.md` can be published, and it appears in the session skill directory seconds after installation.
- **Controlled publishing**: default deny with group- and glob-based grants; revoke (stop distributing) and recall (ask clients to remove installed copies) are separate actions.
- **Unified upgrades**: clients check for a new version of the marketplace plugin at startup; plugins in the market upgrade by installing again.
- **Install statistics**: the console shows what each account has installed and, per artifact, installers / devices / downloads.
- **Private deployment**: the server has zero runtime dependencies and can run on a laptop, an intranet server or Docker, without any external marketplace.
- **Optional single sign-on**: bind a DSH account to a market account one-to-one and the install page gets a session automatically, with no second password prompt.

**Not a good fit**: a public commercial marketplace, usage-based billing, or multi-tenant SaaS. Those capabilities do not exist here and are not planned.

---

## Features

### Market server

- **Accounts and permissions**
  - Accounts, roles (admin / member), permission groups, and group-level glob plugin rules.
  - **Default deny**: nothing installs without a matching grant (admins included, `E_NO_GROUP`).
  - **Deny wins**: any matching deny rule rejects the install.
  - **Changes take effect immediately**: disabling an account revokes all of its sessions; its old token receives 401 on the next request.
  - Passwords are stored with scrypt and tokens only as hashes; failed-login lockout; 7-day rotating refresh tokens.
- **Catalog**
  - `/dsh-market/catalog` lists every artifact with `canInstall` and the rejection reason — an artifact a user cannot even see is harder to request access to.
  - Server-side search, filters (plugins / skills) and pagination; the install page renders only the current page.
- **Publishing**
  - Upload `.tar.gz` / `.tgz` / `.zip` from the console; `cli.mjs publish --dir` uploads or writes the database directly.
  - `--dry-run` preflight; the upload endpoint is dry-run by default and writes only after confirmation.
  - Publish states `draft` / `review` / `published` / `revoked`; only `published` can be installed.
  - Archives are checked before anything is written: missing `package.json`, invalid JSON, path traversal, symlinks and unknown states are rejected.
  - npm layouts and zip files are **normalized** into a flat tar.gz before storage, so the same tree always produces the same sha256.
  - Skill packages containing only `SKILL.md` also publish; the server synthesizes the manifest.
- **Artifacts and downloads**
  - Deterministic packing (fixed mtime, sorted entries) with the sha256 stored at publish time.
  - On download the server re-hashes the bytes on disk and refuses any mismatch (`E_HASH_MISMATCH`) with an audit entry.
  - The download endpoint **re-checks authorization**; without permission it sends no bytes at all.
- **Revoke and recall**
  - Revoke (`revoked`): stop serving the artifact; installed copies keep working.
  - Recall (`recalled`): ask clients to remove installed copies on their next start; reversible.
  - Recall a single version or "all current versions" (`version: '*'`, an explicit snapshot, not a permanent rule).
  - After removal the client leaves a receipt (`<profile>/.dsh-market-recalled.json`); the install page shows it.
- **Install statistics**
  - Clients report a per-device snapshot of their current installs (`install_devices` + `install_items`).
  - The console shows an "Installed" count per account and installers / devices / downloads per artifact, each expandable to details.
  - The semantics are explicit: a download is not an install; no report does not mean zero.
- **Identity binding and auto-login**
  - One-to-one binding between a DSH account and a market account; established by an explicit click, never silently consuming the quota.
  - After binding, the local plugin holds a binding key and the install page obtains a session automatically; only the hash is stored, and signing out clears the local key.
  - Password login remains the fallback: the binding records ownership, it does not pin the account to one machine.
- **Self-update**
  - The server can carry a new version of the marketplace plugin itself (`publish:self`); clients compare versions at startup and replace the installed copy when different.
  - The update takes effect on the next start; linked installs are never rewritten, so a developer's working tree stays untouched.

### DSH client plugin

- Registers a native entry `sidebar.footer.action` at the bottom of the sidebar; it opens the install page in the system browser and collapses to an icon in the narrow sidebar.
- Install / uninstall / update:
  - Four gates: server authorization → double sha256 verification → archive safety → registration driven by the archive's own `dsh.bundle`.
  - Bundles go into `dsh.profile.bundles`; plain plugins go into a managed block in the profile patch layer.
  - Skills go into `<profile>/.dsh-market-skills/` and are registered through `ctx.skills.register`; install and uninstall take effect within seconds.
- Automatic reconciliation:
  - reports the install snapshot at startup (`MARKET_AUTO_REPORT=0` disables it);
  - checks the recall list and removes recalled versions (`MARKET_AUTO_RECALL=0` disables it);
  - checks for a new version of the marketplace plugin itself (`MARKET_AUTO_UPDATE=0` disables it).
- **Does not** make authorization decisions, store accounts / groups / rules / catalog, or execute install scripts.

### Deployment methods

- Windows: `start-market.bat`
- Linux / macOS / WSL: `start-market.sh`
- Container: `Dockerfile` (health check, non-root user, `/data` volume)

---

## Architecture and data flow

```
Admin ──> console /console or CLI ──> market server (accounts / rules / artifacts / audit)
                                             │
DSH client plugin ── catalog / authorization / downloads ──┘
      │
      └── verify, unpack, write into the current profile (bundle / plugin / skill)
```

- **Two interfaces, two jobs**
  - Install page: `http://127.0.0.1:<DSH port>/market`, where ordinary users see their own catalog and install / uninstall.
  - Console: `http://<server>:8787/console`, where admins manage accounts, groups, rules, publishing, artifacts and statistics.
- **Two archive formats, do not mix them**
  - `tools/pack-dist.mjs`: installs **the marketplace plugin itself** into DSH; every entry lives under `package/`.
  - `server/lib/pack.js`: the **artifacts** registered in the market; flat layout (`package.json` at the archive root). Uploads have any `package/` prefix stripped.
- **Data location**
  - Default `<repo>/.market/`: `market.db` (SQLite, WAL) plus `artifacts/` (artifact bytes).
  - `MARKET_DATA_DIR` / `MARKET_DB` / `MARKET_STORAGE` override it; inside Docker it is always `/data`.
- **Directory layout**

```
server/                 Market server (zero runtime dependencies)
├── index.mjs           Entry point + first-run bootstrap
├── cli.mjs             Operations CLI / publishing client
└── lib/                db, crypto, store, policy, artifacts, http, pack, layout, version
lib/                    DSH client plugin
├── bundle.js           Bare-package-name entry (exports apply)
├── plugin.js           Host row: download, verify, unpack, register, /market and local routes
├── client.js           Browser half: registers the sidebar entry
└── tar.js              Restricted tar reader (rejects symlinks and path escapes)
web/                    The two interfaces + shared assets (no build step)
tools/                  Tests, contract preflight, packing, read-only diagnostics
cordis.patch.yml        Patch layer: host row + client row
start-market.bat        Windows launcher
start-market.sh         Linux / macOS / WSL launcher
Dockerfile              Server image
```

---

## Local setup

The steps below complete the system on one machine: the server listens on `127.0.0.1:8787`, and the DSH client plugin points at it.

### 0. Prerequisites

- **Node ≥ 22.5** (the server uses the built-in `node:sqlite`): `node --version`
- **DSH installed** with the `dsh` CLI available (`dsh --version`)
- Port `8787` free
- Run every command from the repository root

### 1. Start the server

**Windows**

```powershell
.\start-market.bat
```

**Linux / macOS / WSL**

```bash
chmod +x start-market.sh
./start-market.sh
```

**Docker**

```bash
docker build -t dsh-plugin-market-selfhosted .
docker run -d --name dsh-market \
  -p 8787:8787 \
  -v dsh-market-data:/data \
  dsh-plugin-market-selfhosted
docker logs dsh-market
```

The first start creates the database and the initial administrator:

```
username  admin
password  dsh-admin
```

That account must change its password on first login. Health check: `GET /dsh-market/health`.

The Windows and Linux/macOS launchers take the same arguments:

| Argument | Effect |
|---|---|
| `--port 9000` | Use another port |
| `--host 0.0.0.0` | Let other machines on the LAN connect (development; see Docker/reverse proxy for production) |
| `--data /var/lib/dsh-market` | Use another data directory |
| `--check` | Check Node, paths and permissions, then exit |

### 2. Initialize accounts and permissions

Open the console at `http://127.0.0.1:8787/console`, sign in with `admin / dsh-admin`, and change the password when prompted.

Then create permission groups, rules and users. Rules are **glob patterns**, not a "plugin → group" mapping; one `@dsh-internal/*` rule makes every matching plugin published later available to the group automatically.

```bash
node server/cli.mjs group:add  --id billing --description "Billing"
node server/cli.mjs grant:add  --group billing --pattern "@dsh-internal/*"
node server/cli.mjs user:add   --username alice --password "<at least 12 characters>" --groups billing
node server/cli.mjs member:add --user admin --group billing
node server/cli.mjs user:list
```

The same operations are available in the console. Remember **default deny**: with no group and no rule, even admin cannot install anything; the catalog shows `canInstall: false` and the reason.

Publishing requires admin; ordinary members can only browse and install.

### 3. Pack and install the DSH client plugin

```bash
node tools/pack-dist.mjs
```

It prints the output path, normally `dist/dsh-plugin-market-selfhosted-<version>.tgz`. Install it into the profile you actually use:

```bash
dsh plugin --profile desktop add "./dist/dsh-plugin-market-selfhosted-<version>.tgz"
```

(Use the path printed by `node tools/pack-dist.mjs`.)

> **Use the right profile.** The desktop app defaults to `desktop`; `dsh web` defaults to `web`. The two profiles do not share their `node_modules`, patch layer or skill directory — installing into one does not make it appear in the other. Install once per profile you use, or keep using a single profile.

> **To install on a colleague's machine, they do not need the repository**: send them `dist/*.tgz`, have them run `dsh plugin --profile <profile> add <tgz>`, set `MARKET_SERVICE_URL` and restart DSH. Later versions arrive through the marketplace's self-update.

### 4. Configure the service URL and restart DSH

The client plugin reads `MARKET_SERVICE_URL` once at startup, so it **must be a user-level variable** (a DSH launched from the Start menu only inherits user- and system-level variables):

**Windows**

```powershell
[Environment]::SetEnvironmentVariable('MARKET_SERVICE_URL', 'http://127.0.0.1:8787', 'User')
```

**Linux / macOS**

```bash
# Add to ~/.profile or ~/.bashrc.
export MARKET_SERVICE_URL=http://127.0.0.1:8787
```

Then **restart DSH**. The **Internal Plugin Market** button appears at the bottom of the sidebar; clicking it opens the install page in the system browser. You can also open `http://127.0.0.1:<DSH port>/market` directly.

### 5. Verify the installation

- The sidebar entry exists and opens.
- The install page shows the correct service URL.
- `~/.dsh/plugin-marketplace-diag.log` contains `[profile]`, `[register]` and `[skills]` lines.
- DSH stderr does not contain `failed to import`.

If you see `failed to import`, first check whether `node_modules/dsh-plugin-market-selfhosted/lib/plugin.js` really lives under `lib/`. A flat file at the package root means the archive was built without the `package/` prefix; rerun `node tools/pack-dist.mjs`.

### 6. Publish the first plugin

A plugin package needs at minimum a `package.json` (with `name` and `version`). An optional `market.json` supplies marketplace metadata:

```json
{
  "summary": "Billing plugin",
  "owner": "billing",
  "channel": "stable",
  "dsh": ">=0.2.0-rc.2 <0.3",
  "state": "published"
}
```

Sign in as admin, preflight, then publish:

```bash
node server/cli.mjs login --username admin --service http://127.0.0.1:8787
node server/cli.mjs publish --dir ./my-plugin --dry-run
node server/cli.mjs publish --dir ./my-plugin
```

You can also upload `.tar.gz` / `.tgz` / `.zip` from the console's publish form.

Skill packages are simpler: a single `SKILL.md` whose frontmatter contains `name` and `description` is enough. Set `version` in the frontmatter; otherwise the version is fixed at `0.1.0` and a re-publish will never look like an update to installed users.

### 7. Install, update and uninstall in DSH

1. Open **Internal Plugin Market** and sign in with a market account (or bind the DSH account first and use auto-login afterwards).
2. Click **Install** on a catalog entry and wait for it to finish.
3. **Plugins and bundles take effect after a DSH restart**; skills take effect within seconds.
4. To update, publish a higher version and click **Update to X** on the install page. An update replaces the whole directory, so files removed in the new version do not linger.
5. Uninstall from the install page.

---

## Day-to-day usage

### Publishing and versions

- Run `--dry-run` first; the preflight reports the type, package name, version and the normalized sha256.
- **An update must increase the version.** Changing content without changing the version only overwrites the same version, and installed users will not see an update.
- `--state draft` publishes a draft first; switch it to `published` after review. `revoked` stops distribution immediately.
- The CLI and uploads go through the same validation, so "works locally, rejected on upload" cannot happen.

### Revoke vs. recall

| Action | Effect | What it cannot reach |
|---|---|---|
| Revoke (`revoked`) | Stop distributing; the catalog no longer lists it, and even a permitted user cannot download it | Installed copies keep working |
| Recall (`recalled`) | Ask clients to remove installed copies; reversible | Machines that are offline or never start DSH again |

Recall is matched by exact version (`1.0.0` does not remove `1.1.0`); "all versions" is a snapshot of what exists at that moment, and versions published afterwards are unaffected. After removing a copy, the client leaves a receipt on the install page.

### Install statistics

In the console:

- The **Installed** count on an account row is that account's current install count; click the number for details.
- **Installers / downloads** on an artifact row: installers are distinct accounts and can be expanded to a list; downloads come from the server's download audit.

Read the numbers with these caveats: **a download is not an install**; a machine that never reported does not appear in the statistics (`—` or `0` does not mean "not installed"); historical install events are not retained; device rows currently have no TTL.

### DSH account binding

Only clicking **Bind** on the install page creates the one-to-one relationship. After binding you can enable auto-login and stop typing the password. Unbinding is done by the user from the install page; no administrator is required. The binding records ownership, not usage limits: anyone who knows the password can still sign in to that market account elsewhere.

### Upgrading the marketplace plugin itself

On the development machine, after bumping the version:

```bash
node tools/pack-dist.mjs
node server/cli.mjs publish:self --archive dist/dsh-plugin-market-selfhosted-<version>.tgz
```

The server does not need a restart; the next client start picks up the new package (**taking effect after DSH restarts**). If the server does not have this repository, run `publish:self --dir .` there to pack the checkout itself.

---

## Server deployment

### LAN (without Docker)

```bash
./start-market.sh --host 0.0.0.0 --data /var/lib/dsh-market
```

On every other machine, point DSH at it:

```
MARKET_SERVICE_URL=http://<server-ip>:8787
```

`MARKET_CALLBACK_HOST` tells the service and its logs which address clients actually use; set it explicitly behind a reverse proxy or when using an intranet hostname.

### Docker

The image contains **only the market server**, not the DSH client plugin. Install the client plugin with `dsh plugin add` and point it at this service through `MARKET_SERVICE_URL`.

```bash
docker build -t dsh-plugin-market-selfhosted .

docker run -d --name dsh-market \
  -p 8787:8787 \
  -v dsh-market-data:/data \
  -e MARKET_CALLBACK_HOST=market.example.com \
  dsh-plugin-market-selfhosted
```

- All state lives in `/data`: the SQLite database and the artifact bytes. Back it up as one unit; a database backup without the artifacts cannot install the published plugins.
- When using a host directory instead of a named volume, the directory must be writable by the container's `node` user (uid 1000):

  ```bash
  mkdir -p ./market-data && chown -R 1000:1000 ./market-data
  docker run -d -p 8787:8787 -v "$PWD/market-data:/data" dsh-plugin-market-selfhosted
  ```

- If Docker Hub is unreachable, build with a different base-image source:

  ```bash
  docker build \
    --build-arg NODE_IMAGE=<mirror>/library/node:24-alpine \
    -t dsh-plugin-market-selfhosted .
  ```

- The server speaks HTTP only. For internet or enterprise-gateway deployments, put it behind an HTTPS reverse proxy and point `MARKET_SERVICE_URL` at the https address.
- The image has a built-in health check (`/dsh-market/health`); `docker inspect` shows its state.

### How the components find each other

| Component | Where it runs | How the client reaches it |
|---|---|---|
| Market server | Server / laptop / container | `MARKET_SERVICE_URL` |
| DSH client plugin | `node_modules` of each DSH profile | Registered by `dsh plugin add` |
| Install page | The DSH host's `/market` route | Sidebar button or `http://127.0.0.1:<DSH port>/market` |
| Console | The server's `/console` route | Browser pointed directly at the server |

---

## Operations

### Environment variables

**Server**

| Variable | Default | Meaning |
|---|---|---|
| `MARKET_HOST` | `127.0.0.1` | Listen address; `0.0.0.0` inside Docker |
| `MARKET_PORT` | `8787` | Listen port |
| `MARKET_DATA_DIR` | `<repo>/.market` | Data directory; `/data` inside Docker |
| `MARKET_DB` | `<data-dir>/market.db` | Override the database file |
| `MARKET_STORAGE` | `<data-dir>/artifacts` | Override the artifact directory |
| `MARKET_CALLBACK_HOST` | `127.0.0.1` | Address clients actually use (set behind a reverse proxy or for LAN deployments) |
| `MARKET_MAX_UPLOAD_BYTES` | `67108864` (64 MiB) | Maximum publish archive size |

**Client**

| Variable | Default | Meaning |
|---|---|---|
| `MARKET_SERVICE_URL` | none (required) | Market server address; without it the install page says "market server not configured" |
| `MARKET_SERVICE_TIMEOUT_MS` | `30000` | Request timeout |
| `DSH_PROFILE_DIR` | auto-detected | Explicit profile for development / linked installs |
| `MARKET_AUTO_UPDATE` | on | `0` disables marketplace self-update |
| `MARKET_AUTO_REPORT` | on | `0` disables install-snapshot reporting |
| `MARKET_AUTO_RECALL` | on | `0` disables recall reconciliation |

### Common CLI commands

```bash
node server/cli.mjs bootstrap
node server/cli.mjs user:add   --username alice --password '<password>' --groups billing [--admin]
node server/cli.mjs user:list
node server/cli.mjs user:pass   --username alice --password '<new password>' --no-must-change
node server/cli.mjs user:status --username alice --status disabled
node server/cli.mjs group:add  --id billing --description "Billing"
node server/cli.mjs grant:add  --group billing --pattern "@dsh-internal/*" [--deny]
node server/cli.mjs grant:rm   --group billing --pattern "@dsh-internal/*"
node server/cli.mjs member:add --user alice --group billing
node server/cli.mjs bind:list
node server/cli.mjs bind:rm    --user alice
node server/cli.mjs catalog | audit [--limit 50] | installs [--limit 20] | prune
```

### Backup and migration

1. Stop the server (or at least stop writes).
2. Copy `MARKET_DATA_DIR` as a whole (database + `artifacts/`).
3. On the new machine, point `MARKET_DATA_DIR` at the copy; accounts, rules, artifacts and statistics all move with it.

### What needs a restart after a change

| Change | How it takes effect |
|---|---|
| `server/**` | Restart the server |
| `web/console.html`, `web/console.css` | Restart the server (the console is served by the server) |
| `lib/**`, `cordis.patch.yml`, `package.json`, `web/market.*`, `web/shared.js` | Re-run `pack-dist`, reinstall on every client (or wait for self-update), restart DSH |
| Plugin / skill artifacts in the market | No server restart; reinstall or wait for the client update |

### Long-running server

- Windows: run `start-market.bat` from Task Scheduler at logon.
- Linux: use systemd, supervisor, or Docker's `restart` policy.
- Docker: add `--restart unless-stopped` to `docker run`.

---

## Security

- **The server is the only authority**: the client makes no authorization decisions and only applies the server's decisions and bytes.
- **Default deny + deny wins**: nothing installs without a rule; disabling an account revokes its sessions immediately.
- **Artifact trust chain**: deterministic tar.gz + sha256; the server re-hashes before download; the client verifies both the caller's hash and the response header hash.
- **Archive safety**: only regular files and directories are accepted; symlinks/device files and path escapes are rejected; unpacking finishes in a staging directory before anything is moved into place.
- **No install scripts**: the marketplace only writes files and registrations; it never runs package scripts.
- **Same-origin checks on writes**: install, uninstall and binding writes on the local plugin only accept DSH's own Origin, preventing CSRF from other pages in the local browser.
- **Contained paths**: every write/delete target must stay inside the profile or skill directory; package names pass a single shared regular expression.
- **Credentials**: passwords use scrypt; session tokens and binding keys are stored only as hashes; the binding key lives in the profile with mode `0600` and becomes invalid on unbind. Unbind before discarding a machine.
- **Transport**: the server itself speaks HTTP; deploy it behind an HTTPS reverse proxy for cross-machine or internet use.

---

## Tests

```bash
node tools/run-all.mjs                 # every suite
node tools/run-all.mjs server          # only suites whose name matches
node tools/test-host.mjs               # host entry and route contracts
node tools/test-server.mjs             # server: login / permissions / publish / download / hashing / audit
node tools/test-publish.mjs            # publish uploads: preflight / archives / state transitions
node tools/verify-install.mjs "$HOME/.dsh/profiles/desktop"   # contract preflight of an installed profile
```

`run-all.mjs` also treats a suite that produced no `RESULT:` line as a failure — a test that prints nothing is not a passing test.

---

## Known limitations

- **Desktop and web are two profiles**: `desktop` and `web` do not share `node_modules`, patches or skill directories, so each needs its own install. To maintain one copy, run the web UI with `dsh --profile desktop web`.
- **Statistics are client-reported**: machines that never bind or report contribute no data; historical events are not kept; device rows do not expire; a shared device belongs to the account that reported last.
- **Recall cannot reach offline machines**: a pull-based client cannot be forced; this is a limitation of the model.
- **Updates need a restart**: plugin and bundle updates, and marketplace self-updates, take effect on the next start; skills do not.
- **Linked installs do not self-update**: when `node_modules` contains a link, the plugin refuses to rewrite it so a developer's working tree is never modified.
- **Skill `/` suggestions after uninstall**: the DSH client caches the skill list per session, so the `/` menu may keep suggesting an uninstalled skill until a new session or a restart (the model side takes effect immediately).
- **No autostart**: the server is a foreground process; use a service manager, Docker or Task Scheduler.
- **No multi-tenancy**: one deployment is one organization's marketplace.

---

## Troubleshooting

| Symptom | Check first |
|---|---|
| Install page says "market server not configured" | Is `MARKET_SERVICE_URL` a **user-level** variable, and did DSH restart? |
| `E_SERVICE_UNREACHABLE` / `E_SERVICE_TIMEOUT` | Is the server running, is the address/port correct, is the firewall open? |
| `failed to import` | Was the client package built with `tools/pack-dist.mjs`? Entries must live under `package/` |
| The catalog lists a plugin but it cannot be installed | Is the account in a group, and does the group have a matching allow rule? Inspect `reason` (e.g. `E_NO_GROUP`) |
| Login rejected with `E_MUST_CHANGE_PASSWORD` | The initial password has not been changed; change it in the console or with `cli.mjs passwd` |
| Another machine cannot connect | Did the server start with `--host 0.0.0.0`, is the port open, and does `MARKET_CALLBACK_HOST` point at a reachable address? |
| Server changes do not appear | Did you change `server/**` or `web/console.*`? Restart the server. Client-side changes require a repack and a DSH restart |
| Docker cannot write `/data` | With a host bind mount, make sure uid 1000 can write (`chown -R 1000:1000`) |
| No install statistics | Has the client bound and reported? Is `MARKET_AUTO_REPORT` disabled? |

Client-side diagnostic log: `~/.dsh/plugin-marketplace-diag.log`.
