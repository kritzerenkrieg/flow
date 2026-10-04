# Migration runbook — Flow white-label fork → `flow.relow.net`

Purpose: take this repository from its current state (white-labeled, tested, running
locally on `localhost:3456`) to a **new, independent production instance** on a different
server, reachable at **`https://flow.relow.net`** with port 80 redirecting to 443.

## Decisions this runbook is built on

| Topic | Choice |
|---|---|
| Code delivery | Build **on the target server** from `git clone` (origin: `https://github.com/kritzerenkrieg/flow.git`) |
| TLS / redirect | **nginx + certbot** (`certbot --nginx --redirect` → 80 ⇒ 301 ⇒ 443) |
| App listener | `127.0.0.1:3456`, never exposed publicly (nginx proxies to it) |
| Database | **Fresh SQLite** at `/opt/flow/vikunja.db` — the current database is **not** migrated |
| Mail | Same SMTP as today (`shadow.mxrouting.net:465`, `noreply@relow.net`, `forcessl: true`), copied verbatim |
| Public URL | `https://flow.relow.net/` — used in mails, API↔frontend URLs and the mail Message-ID domain |
| Branding | Already in the code: Flow theme (always bright), "Powered by relow", rebranded transactional mail, no custom-API-config login screen |
| Users | None migrated; the first admin is created with the CLI |

[`deployment.md`](./deployment.md) is the generic reference (build, every config key,
database options, reverse proxy/TLS, mailer, CLI, production checklist). This file is the
**fork-specific runbook** — follow it top to bottom.

Assumptions: Debian/Ubuntu target with systemd, sudo/root access, nginx available, and
exactly **one** app instance per database (cron jobs run in-process).

## 0. Preflight

- [ ] DNS: an `A` record (and `AAAA` if you use IPv6) `flow.relow.net` → target server IP.
      Verify from the target: `dig +short flow.relow.net`
- [ ] Ports **80 and 443** open inbound (provider firewall/security group *and* host firewall).
      Port 80 must stay open permanently — Let's Encrypt renewals use it.
- [ ] sudo/root on the target
- [ ] `uname -m` and `ldd --version` noted (arch/libc; only relevant if you ever ship a
      prebuilt binary instead of building on the server)
- [ ] Outbound internet on the target (Go modules, pnpm registry, ACME)

```bash
# on the target
uname -m && ldd --version | head -1 && sudo -v
```

Toolchain versions this repo pins — do not guess:

| Tool | Version | Source of truth |
|---|---|---|
| Go | **1.27.0** | `go.mod` |
| Node.js | **24.21.0** | `frontend/.nvmrc` |
| pnpm | **11.27.0** | `frontend/package.json` → `packageManager` (via corepack) |
| C toolchain | any gcc | required: `mattn/go-sqlite3` is **cgo** |

## 1. Repository hygiene — `.gitignore`

State verified on this machine:

| Path | Status |
|---|---|
| `build/vikunja` (103 MB binary) | ignored **only** by `build/.gitignore` |
| `build/config.yml` (contains the SMTP password) | ignored by the root `config.yml` rule |
| `build/vikunja.db`, `-wal`, `-shm` | ignored by root `*.db`, `*.db-wal`, `*.db-shm` |
| `build/logs/`, `build/files/` | ignored by root `logs/`, `files/` |
| `frontend/dist`, `frontend/node_modules` | ignored by `frontend/.gitignore` |
| `flow-login.jpg` (repo root) | **untracked duplicate** of `frontend/src/assets/flow-login.jpg` (identical md5 `ae591559c2a1057a8eba089be2427eef`) |
| `db/` (repo root, root-owned `vikunja.db*`) | untracked leftovers, matched by `*.db*` |

Changes to make:

1. Append a local-artifacts section to the **root** `.gitignore` and delete the now
   redundant `build/.gitignore` (keep the rule in one place).
2. Delete the byte-identical root duplicate `flow-login.jpg` (the frontend copy is the one
   the login page uses).
3. Delete the stray root `db/` directory.

`.gitignore` diff (appended after the "AI Tools" block):

```diff
  # AI Tools
  /.claude/settings.local.json
  PLAN.md
  plans/
  /.crush/
  /.playwright-mcp
+
+ # Local build/deploy artifacts
+ /build/vikunja
+ /flow-login.jpg
+ build/vikunja.bak*
```

> Keep comments on their **own lines**: `.gitignore` does not support trailing comments
> after a pattern — everything after the pattern would become part of it.

```bash
# from the repository root
rm -f build/.gitignore flow-login.jpg
rm -rf db/
```

Verify:

```bash
git status --porcelain                       # only expected entries
git check-ignore -v build/vikunja build/config.yml build/vikunja.db build/logs/standard.log
```

> `build/config.yml` holds the SMTP password and is intentionally ignored - never commit
> it; transfer it out-of-band (section 3.4).

## 2. Commit plan

The tree currently has ~134 modified/deleted files plus the new docs. Split into six
Conventional Commits. Order matters: commit the auth refactor **before** the catch-all
frontend commit so the pathspecs do not overlap.

| # | Message | Pathspec |
|---|---|---|
| 1 | `feat(auth): remove custom API-config login routing` | `frontend/src/App.vue`, `frontend/src/main.ts`, `frontend/src/components/misc/NoAuthWrapper.vue`, `frontend/src/components/misc/Ready.vue`, `frontend/src/components/misc/ApiConfig.vue` (deleted), `frontend/src/views/user/DesktopLogin.vue` |
| 2 | `feat(email): rebrand outgoing mail as Relow Flow` | `pkg/` |
| 3 | `feat(assets): add Flow login image` | `frontend/src/assets/flow-login.jpg` |
| 4 | `feat(branding): white-label frontend as Flow` | `frontend/` (remainder) |
| 5 | `chore: ignore local build artifacts` | `.gitignore` |
| 6 | `docs: add deployment and migration runbooks` | `deployment.md`, `migration.md`, `.agents/docs/dev-commands.md` |

The index already holds every change (138 files staged), so the first `git commit`
below would sweep **all** of it into commit 1 unless you unstage first. The
`git restore --staged .` is safe here — there is no staged/unstaged drift to lose;
each commit re-adds exactly its pathspec:

```bash
git restore --staged .

git add frontend/src/App.vue frontend/src/main.ts \
        frontend/src/components/misc/NoAuthWrapper.vue \
        frontend/src/components/misc/Ready.vue \
        frontend/src/components/misc/ApiConfig.vue \
        frontend/src/views/user/DesktopLogin.vue
git commit -m "feat(auth): remove custom API-config login routing"

git add pkg/
git commit -m "feat(email): rebrand outgoing mail as Relow Flow"

git add frontend/src/assets/flow-login.jpg
git commit -m "feat(assets): add Flow login image"

git add frontend/
git commit -m "feat(branding): white-label frontend as Flow"

git add .gitignore
git commit -m "chore: ignore local build artifacts"

git add deployment.md migration.md .agents/docs/dev-commands.md
git commit -m "docs: add deployment and migration runbooks"
```

Gates before the first commit (per `AGENTS.md`):

```bash
go build ./...                                   # backend compiles
go tool mage lint:fix                            # backend lint (golangci-lint)
cd frontend && pnpm lint:fix && pnpm lint:styles:fix && cd ..   # styles changed
go test ./pkg/notifications/ -count=1            # mail rendering assertions
git diff --cached --stat                         # review what is staged
git diff --cached | grep -in 'password\|secret'  # must not show config secrets
```

Then `git push origin main` once reviewed (`origin` = `kritzerenkrieg/flow`).

While touching docs, fix this in `deployment.md` section 9: the CLI table lists
`vikunja set-admin <user>`, but v2.7 only has the subcommand —
`vikunja user set-admin --admin <username-or-id>`.

## 3. New server — build, install, serve

### 3.1 Toolchain

```bash
sudo apt update
# build-essential provides gcc, which cgo needs for the SQLite driver
sudo apt install -y git curl ca-certificates build-essential

# Go 1.27.0 (adjust the tarball name for a non-amd64 host)
curl -fsSLO https://go.dev/dl/go1.27.0.linux-amd64.tar.gz
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf go1.27.0.linux-amd64.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin' | sudo tee /etc/profile.d/go.sh
. /etc/profile.d/go.sh && go version          # expect go1.27.0

# Node 24.21.0 via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. ~/.nvm/nvm.sh && nvm install 24.21.0 && nvm alias default 24.21.0
corepack enable && corepack prepare pnpm@11.27.0 --activate
node -v && pnpm -v                            # v24.21.0 / 11.27.0
```

Node is only needed for the build; the running server needs neither Node nor Go.

### 3.2 Clone and build

```bash
sudo mkdir -p /srv && sudo chown "$USER" /srv
git clone https://github.com/kritzerenkrieg/flow.git /srv/flow
cd /srv/flow

# 1) frontend -> frontend/dist  (IMPORTANT: this gets embedded into the binary)
cd frontend && pnpm install --frozen-lockfile && pnpm build && cd ..

# 2) binary -> ./vikunja (mage is pinned in go.mod: `go tool mage` needs no install)
go tool mage build
./vikunja version
```

The frontend **must** be built before `mage build`: the Go build embeds
`frontend/dist` (`frontend/embed.go`), so building in the wrong order ships a stale UI.

If the fork is private, clone with a deploy key or a token URL instead of anonymous HTTPS.

### 3.3 Layout and service user

```bash
sudo useradd --system --home /opt/flow --shell /usr/sbin/nologin flow
sudo mkdir -p /opt/flow/files /opt/flow/logs
sudo install -m 755 /srv/flow/vikunja /opt/flow/vikunja
sudo chown -R flow:flow /opt/flow
sudo chmod 750 /opt/flow
```

### 3.4 `/opt/flow/config.yml`

Keeps the current database type (SQLite) and the current mailer block; only paths and the
public URL change. Mode `600`, owned by `flow`.

```yaml
service:
  # openssl rand -hex 32 — must stay stable, or every restart invalidates all sessions
  secret: "<generated-secret>"
  publicurl: "https://flow.relow.net/"
  rootpath: "/opt/flow"
  interface: "127.0.0.1:3456"        # behind nginx; not reachable from the internet
  ipextractionmethod: "xff"          # real client IPs from nginx (rate limiting, audit)
  trustedproxies: "127.0.0.1/32,::1/128"
  # enableregistration: true         # see section 4 - decide deliberately

database:
  type: "sqlite"
  path: "/opt/flow/vikunja.db"

files:
  basepath: "/opt/flow/files"

log:
  path: "/opt/flow/logs"
  standard: "file"
  http: "file"

mailer:                              # copied verbatim from the current build/config.yml
  enabled: true
  host: "shadow.mxrouting.net"
  port: 465
  authtype: "plain"
  username: "noreply@relow.net"
  password: "<SMTP password - out-of-band only>"
  skiptlsverify: false
  fromemail: "noreply@relow.net"
  queuelength: 100
  queuetimeout: 30
  forcessl: true
```

```bash
# from the current machine: move the existing config (it contains the SMTP password)
scp build/config.yml user@flow.relow.net:/tmp/flow-config.yml
# then on the server
sudo mv /tmp/flow-config.yml /opt/flow/config.yml
sudo chown flow:flow /opt/flow/config.yml && sudo chmod 600 /opt/flow/config.yml
sudo -u flow vi /opt/flow/config.yml     # adjust paths/publicurl per the template
```

Instead of shipping the password inside the config you can use `mailer.password.file`
(`deployment.md` section 4.3) or the `VIKUNJA_MAILER_PASSWORD` environment variable.

Because `service.publicurl` drives mail links *and* the Message-ID/thread domain
(`pkg/mail/domain.go`), mails will reference `flow.relow.net` while still being sent as
`noreply@relow.net` — the existing SPF/DKIM records for `relow.net` keep working unchanged.

### 3.5 systemd unit

Adapted from the repo's `vikunja.service` (hardening kept; user and `--config` added) →
`/etc/systemd/system/flow.service`:

```ini
[Unit]
Description=Flow (Vikunja) API and web UI
After=network.target

[Service]
Type=simple
User=flow
Group=flow
WorkingDirectory=/opt/flow
ExecStart=/opt/flow/vikunja --config /opt/flow/config.yml
Restart=always
RestartSec=2s

# Hardening (from vikunja.service)
NoNewPrivileges=yes
ProtectProc=invisible
ProcSubset=pid
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
PrivateDevices=yes
RestrictNamespaces=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
SystemCallErrorNumber=ENOSYS

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now flow
journalctl -u flow -f
```

No `CAP_NET_BIND_SERVICE` is needed: nginx binds 80/443, the app stays on port 3456.

### 3.6 nginx + certbot

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

`/etc/nginx/sites-available/flow.relow.net`:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 80;
    listen [::]:80;
    server_name flow.relow.net;

    # ACME challenges must be reachable over plain HTTP
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;                            # nginx < 1.25: use `listen 443 ssl http2;`
    server_name flow.relow.net;

    # certbot --nginx writes ssl_certificate / ssl_certificate_key here
    # ssl_certificate     /etc/letsencrypt/live/flow.relow.net/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/flow.relow.net/privkey.pem;

    client_max_body_size 100M;           # attachments, backgrounds, imports

    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;

        # long-lived realtime connections (websocket / server-sent events)
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/flow.relow.net /etc/nginx/sites-enabled/
sudo nginx -t
sudo certbot --nginx -d flow.relow.net --redirect --agree-tos --no-eff-email -m admin@relow.net
sudo systemctl reload nginx
systemctl list-timers | grep certbot      # automatic renewal
```

Alternatives (details in `deployment.md` section 5):

- **Vikunja built-in TLS**: `autotls.enabled: true` + `autotls.email`, `service.interface: ":443"`
  and `CAP_NET_BIND_SERVICE` in the unit; ACME uses port 80, but there is no built-in
  80 => 443 redirect setting, so a minimal vhost would still be required for that.
- **Caddy** instead of nginx: `flow.relow.net { reverse_proxy 127.0.0.1:3456 }` — automatic
  certificates and an automatic HTTPS redirect.

### 3.7 Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable && sudo ufw status
```

The app port 3456 stays bound to loopback and must not be exposed.

## 4. First run and bootstrap

```bash
sudo systemctl start flow
sudo systemctl status flow --no-pager
# migrations run automatically against the empty database on first start
sudo -u flow /opt/flow/vikunja --config /opt/flow/config.yml doctor
/opt/flow/vikunja --config /opt/flow/config.yml healthcheck   # exit 0 = healthy
```

Create the first admin (the fresh database has no users):

```bash
sudo -u flow /opt/flow/vikunja --config /opt/flow/config.yml user create -u flow-admin -e you@relow.net -p
sudo -u flow /opt/flow/vikunja --config /opt/flow/config.yml user set-admin --admin flow-admin
sudo -u flow /opt/flow/vikunja --config /opt/flow/config.yml user list
```

> v2.7 has **no** top-level `set-admin`; the working form is
> `vikunja user set-admin --admin <username-or-id>` (`--no-admin` revokes it).

`service.enableregistration` is currently left at its default (**open**). On a public domain
that attracts spam: either register the accounts you need now and then set
`enableregistration: false`, or keep sign-ups and watch the user list. Accounts can always
be created with `vikunja user create`.

## 5. Verification checklist

- [ ] `curl -I http://flow.relow.net/` → `301` to `https://flow.relow.net/`
- [ ] `curl -sS -o /dev/null -w '%{http_code}\n' https://flow.relow.net/health` → `200`
- [ ] UI loads over HTTPS; API calls go to the same origin (no custom API-URL screen)
- [ ] Login works; the theme is always bright; footer reads "Powered by relow"
- [ ] `sudo -u flow /opt/flow/vikunja --config /opt/flow/config.yml testmail you@relow.net` delivers
- [ ] Registration mail arrives: subject **`Relow Flow Registration`**, sender
      **`Relow Flow <noreply@relow.net>`**, Flow logo in the header, no "Vikunja" anywhere,
      confirmation link pointing at `https://flow.relow.net/...`
- [ ] Forgot-password mail arrives and its link also uses `https://flow.relow.net`
- [ ] `journalctl -u flow --since -15m | grep -iE 'error|panic|fail'` is clean and
      `/opt/flow/logs/standard.log` shows no mail errors (only
      "Closed connection to mail server" after each send)
- [ ] Certificate valid and auto-renewing: `curl -vI https://flow.relow.net 2>&1 | grep -i expire`
- [ ] Real client IPs recorded (rate limiting/audit): check `logs/http.log`

## 6. Operations

### Backups

```bash
sudo mkdir -p /var/backups/flow
echo '0 3 * * * cd /opt/flow && /opt/flow/vikunja --config /opt/flow/config.yml dump -p /var/backups/flow -f flow-$(date +\%F).zip' \
  | sudo tee /etc/cron.d/flow-backup
```

SQLite lives in `/opt/flow` (`vikunja.db` plus `-wal`/`-shm`): copy those files together, or
rely on `vikunja dump`, which bundles config, files and database.

### Upgrade / rollback

```bash
cd /srv/flow && git pull
cd frontend && pnpm install --frozen-lockfile && pnpm build && cd ..
go tool mage build

sudo cp /opt/flow/vikunja "/opt/flow/vikunja.bak-$(date +%F)"
sudo install -m 755 ./vikunja /opt/flow/vikunja
sudo systemctl restart flow
sudo -u flow /opt/flow/vikunja --config /opt/flow/config.yml doctor

# rollback: restore a binary backup plus the matching dump, then restart
sudo install -m 755 /opt/flow/vikunja.bak-<date> /opt/flow/vikunja
sudo systemctl restart flow
```

- Migrations run automatically at startup; never run two instances against one database.
- Logs: `/opt/flow/logs/standard.log` and `http.log`; add logrotate if they grow.
- Keep `/opt/flow` (database + files + config) on persistent storage and in the backup set.

## 7. Appendix

- **Leftover brand item**: `frontend/src/components/misc/Ready.vue:112` still sets
  `background: url('@/assets/llama-nightscape.jpg')`. Swap it for `flow-login.jpg` or drop
  the background to make the UI fully llama-free.
- **Doc fix**: `deployment.md` section 9 lists `vikunja set-admin <user>` — the real command
  is `vikunja user set-admin --admin <user>` (apply in commit 6).
- **Intentionally unchanged identifiers** (technical, not user-visible): the Go module path
  `code.vikunja.io/api`, license/copyright headers, the i18n key name `open_vikunja` (its
  value is already "Open Relow Flow"), API error strings `14009`/`14013`, and the
  `VIKUNJA_OPENAPI_INPUT` environment variable set by the magefile.
- **Not migrated on purpose**: the current SQLite database, users, uploaded files and
  `service.secret`. This deployment starts clean; move data later with `vikunja dump` /
  `vikunja restore` if you ever need it (`deployment.md` section 8).
- **References**: `deployment.md` section 2 (build), 3 (database), 4 (configuration),
  5 (proxy/TLS/client IPs), 6 (mailer, files, metrics), 7 (persistence), 8 (backup),
  9 (CLI), 10 (production checklist).
