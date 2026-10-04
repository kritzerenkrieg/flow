# Deployment

This document describes how to build Vikunja (this repository) from source and
run it in production, plus all deployment-relevant configuration options. It is
based on the actual code in this repo — when in doubt, `config-raw.json`
(source of truth for all config keys) and `pkg/config/config.go` are
authoritative.

## 1. What you are deploying

Vikunja is a **single Go binary**:

- The Vue frontend is compiled to static files and embedded into the binary via
  `//go:embed all:dist` (`frontend/embed.go`), so the binary serves the API, the
  web UI and CalDAV on **one port** (default `:3456`).
- Running the binary without a subcommand is equivalent to `vikunja web`.
- On startup the binary **runs all pending database migrations automatically**
  (`pkg/initialize/init.go` → `migration.Migrate`), then starts an in-process
  cron scheduler and the event system.

Because cron jobs and migrations run **in-process**, run **one instance** of the
server per database. Scaling horizontally is not supported out of the box
(duplicate cron runs, racing migrations); put a reverse proxy in front instead.

## 2. Build from source

This is the only deployment path covered by this document: you build one
self-contained binary and install it wherever it should run.

### 2.1 Prerequisites

- **Go 1.27+** — the version declared in `go.mod`
- **Node.js + pnpm** for the frontend build (`corepack enable pnpm`)
- **mage** as the build driver — install it with
  `go install github.com/magefile/mage@latest`, or skip installing and prefix
  every command with `go tool` (mage is pinned as a tool dependency in
  `go.mod`): `go tool mage build` is equivalent to `mage build`
- **git** (version stamping during the build)

### 2.2 Build

```bash
# 1. Frontend → frontend/dist (embedded into the binary)
cd frontend && pnpm install --frozen-lockfile && pnpm build && cd ..

# 2. API binary → ./vikunja in the repo root
mage build                # or: go tool mage build

# 3. Commented config sample → ./config.yml.sample
#    (never hand-edit it; it is generated from config-raw.json;
#     the positional `1` selects the commented sample — omitting it errors)
mage generate:config-yaml 1
```

`mage -l` lists all targets (tests, lint, code generation). For release-grade
cross-compilation the repo uses `mage release:xgo` (xgo toolchain).

### 2.3 Install and run

1. Install the binary and the config (adjust paths to taste):

   ```bash
   sudo mkdir -p /opt/vikunja
   sudo install -m 755 vikunja /usr/local/bin/vikunja
   sudo install -m 644 config.yml.sample /opt/vikunja/config.yml
   ```

2. Edit `/opt/vikunja/config.yml` and set at least `service.secret` and
   `service.publicurl` (§4.4). Config discovery is described in §4.1 — the
   search path includes the working directory and `/etc/vikunja/`.
3. Start it: `vikunja`. Migrations run automatically at startup;
   `vikunja doctor` sanity-checks the setup afterwards.
4. Keep it running with the service files shipped in this repo:
   - `vikunja.service` (systemd): `WorkingDirectory=/opt/vikunja`,
     `ExecStart=/usr/local/bin/vikunja`, sandboxing hardening already enabled;
     uncomment the `#Requires=…` lines if you use MySQL/MariaDB/PostgreSQL/Redis.
     Copy to `/etc/systemd/system/vikunja.service`, then
     `systemctl enable --now vikunja`.
   - `vikunja.initd` (OpenRC): same paths (`/usr/local/bin/vikunja`,
     `directory=/opt/vikunja`); install as `/etc/init.d/vikunja`, then
     `rc-update add vikunja default && rc-service vikunja start`.
5. To bind ports below 1024 directly, uncomment the `CAP_NET_BIND_SERVICE`
   lines in the unit file.

### 2.4 Development

For day-to-day development use `pnpm dev` in `frontend/` (hot reload on
`:4173`) and the targets from `mage -l` — see `.agents/docs/dev-commands.md`.

## 3. Database options

`database.type` supports exactly three values (`pkg/db/db.go`):

| `database.type` | Requirements | Notes |
|---|---|---|
| `sqlite` (default) | none | File-based, zero setup. Special path value `memory` = ephemeral DB (tests only). |
| `postgres` | PostgreSQL 12+ | TLS via `database.sslmode` / `sslcert` / `sslkey` / `sslrootcert`; schema via `database.schema` (default `public`). If the ParadeDB `pg_search` extension is installed, Vikunja automatically creates BM25 full-text indexes. |
| `mysql` | MySQL 8.0+ or MariaDB 10.2+ | TLS via `database.tls` (`false`, `true`, `skip-verify`, `preferred`). |

Connection pool tuning (MySQL/PostgreSQL only): `database.maxopenconnections`
(default 100), `database.maxidleconnections` (50),
`database.maxconnectionlifetime` (ms, default 1800000).

### SQLite specifics

- `database.path` (default `./vikunja.db`). **Use an absolute path in
  production.** Relative paths fall back to a platform data directory
  (`$XDG_DATA_HOME/vikunja` on Linux) unless `service.rootpath` is set.
- Back up the whole database directory (the file plus `-wal`/`-shm` files if
  present), or use `vikunja dump` (section 8).

### PostgreSQL specifics

```yaml
database:
  type: postgres
  host: localhost:5432
  user: vikunja
  password: <password>      # or password.file: /run/secrets/pg_password
  database: vikunja
  sslmode: disable          # disable|require|verify-ca|verify-full (see lib/pq docs)
  schema: public            # only change if your tables are in another schema
```

### MySQL/MariaDB specifics

```yaml
database:
  type: mysql
  host: localhost:3306
  user: vikunja
  password: <password>
  database: vikunja
  tls: false                # false|true|skip-verify|preferred
```

### Migrations

- Run **automatically on every startup** — no manual step needed on upgrade.
- Manual commands if you need them:
  - `vikunja migrate` — apply pending migrations
  - `vikunja migrate list` — list migrations and their state
  - `vikunja migrate rollback --name <id>` — roll back to a migration
    (irreversible in production; take a backup first)

## 4. Configuration system

### 4.1 Config file search path

Unless `--config <file>` is passed, the binary looks for a file named `config`
(`config.yml`, `config.yaml`, `config.json`, …) in this order
(`pkg/config/config.go`):

1. `service.rootpath` (defaults to the current working directory — under
   systemd that is `WorkingDirectory=`)
2. `/etc/vikunja/`
3. `~/.config/vikunja/`
4. the current directory

`--config /path/to/config.yml` pins a file explicitly (startup fails if it is
unreadable) and anchors `rootpath`/the SQLite default path to that file's
directory. If no config file is found, the binary runs on defaults +
environment variables.

**Never hand-edit `config.yml.sample`** — it is generated from
`config-raw.json` by `mage generate:config-yaml 1` (CI enforces this).

### 4.2 Environment variables

Every config key can be set via env: prefix `VIKUNJA_`, key uppercased, dots
become underscores. Environment overrides the config file.

```
VIKUNJA_SERVICE_PUBLICURL=https://todo.example.com/
VIKUNJA_SERVICE_SECRET=...
VIKUNJA_DATABASE_TYPE=postgres
VIKUNJA_DATABASE_HOST=db:5432
VIKUNJA_LOG_LEVEL=INFO
```

### 4.3 Secrets from files

Any key `<key>` can be read from a file by setting `<key>.file` to its path
(environment variables inside the path are expanded; relative paths resolve
against `service.rootpath`). This keeps secrets out of the config file
(systemd credentials, Kubernetes secrets, …):

```yaml
database:
  password:
    file: /run/secrets/db_password
```

### 4.4 Settings you should always set

| Key | Why |
|---|---|
| `service.secret` | Signs JWTs. If unset, a **random secret is generated on every start**, invalidating all sessions on restart. Set a stable 32+ char random value. |
| `service.publicurl` | Public HTTPS URL of the instance. Used in emails, API↔frontend communication; required when `cors.enable` is on and mandatory for `autotls`. |
| `service.rootpath` | Base directory for database, files, logs, plugins. Defaults to the working directory; pin it to a fixed absolute path such as `/opt/vikunja/`. |

Other frequently used toggles: `service.enableregistration`,
`service.enablelinksharing`, `service.enablecaldav`, `service.timezone`,
`service.trustedproxies` (see below), `log.level`, `log.format` (`text` or
`structured`/JSON).

## 5. Reverse proxy, TLS and client IPs

Options for getting HTTPS in front of Vikunja:

1. **Reverse proxy (recommended)** — nginx/Traefik/Caddy terminates TLS;
   Vikunja keeps listening on `:3456`. Set `service.publicurl` to the external
   `https://…` URL.
2. **Built-in Let's Encrypt** — `autotls.enabled=true` + `autotls.email` +
   `service.publicurl` with a real hostname. Certificates are cached in
   `files.basepath/.certs`, port 80 is used for ACME challenges, and
   `service.interface` should be `:443`.
3. **Unix socket** — `service.unixsocket=/run/vikunja.sock` (plus
   `service.unixsocketmode`, note the `0o` prefix, e.g. `0o660`) for a local
   proxy; `service.interface` is then ignored.

Behind a proxy, client IP extraction must be configured explicitly
(`config-raw.json`):

- `service.ipextractionmethod`: `direct` (default — ignores forwarding headers),
  `xff` (**recommended behind nginx/Traefik/cloud LB**), or `realip`.
- `service.trustedproxies`: comma-separated CIDRs of your proxies, e.g.
  `127.0.0.1/32,::1/128,10.0.0.0/8`.

Rate limiting and audit logs depend on correct client IPs, so do not skip this.

## 6. Optional components

### Redis (optional)

Enabled with `redis.enabled=true` + `redis.host` (`host:port`),
`redis.password`, `redis.db`. Redis is required by:

- `keyvalue.type=redis` — the shared key/value store (startup **fails** if
  `keyvalue.type` is `redis` but `redis.enabled` is false); default is `memory`.
- `ratelimit.store=redis` — distributed rate-limit counters.

Without Redis everything still works; the defaults (`keyvalue.type=memory`,
`ratelimit.store=keyvalue` → in-process store) are fine for a single instance.

### File storage

`files.type`:

- `local` (default) — files under `files.basepath` (default `./files`; keep it
  on persistent storage, e.g. inside `service.rootpath`). `files.maxsize` caps
  upload size (default `20MB`).
- `s3` — S3-compatible object storage (MinIO, Backblaze B2, AWS):
  `files.s3.endpoint`, `files.s3.bucket`, `files.s3.region`,
  `files.s3.accesskey`, `files.s3.secretkey`, plus `files.s3.usepathstyle`
  (self-hosted S3 usually needs `true`) and `files.s3.disablesigning` (for
  providers with broken signature support).

### Mail (SMTP)

`mailer.enabled=true` with `mailer.host`, `mailer.port` (587; try 25 if you only
see `EOF` errors), `mailer.authtype` (`plain`/`login`/`cram-md5`),
`mailer.username`/`mailer.password`, `mailer.fromemail`. Optional
`mailer.forcessl` / `mailer.skiptlsverify`.
Test with `vikunja testmail you@example.com`.
If the mailer is disabled, registrations are approved immediately and password
resets by email do not work.

### Metrics and monitoring

- `metrics.enabled=true` exposes Prometheus metrics at `/api/v1/metrics`;
  protect with `metrics.username`/`metrics.password` (HTTP basic auth).
- `metrics.pprof=true` additionally exposes `/debug/pprof/` (same auth).
- Health endpoints for load balancers/uptime checks (no auth):
  - `GET /health`
  - `GET /api/v2/health`
  - CLI equivalent: `vikunja healthcheck` (exit code 0/1).

### Rate limiting

`ratelimit.enabled`, `ratelimit.kind` (`user`|`ip`), `ratelimit.period`,
`ratelimit.limit`, `ratelimit.store` (`keyvalue`|`memory`|`redis`), plus fixed
caps for unauthenticated routes (`ratelimit.noauthlimit`), token refresh
(`ratelimit.tokenrefreshlimit`) and failed basic-auth attempts
(`ratelimit.basicauthlimit`).

### Audit log

`audit.enabled=true` writes one JSON object per line to the file set in
`audit.logfile` (defaults to a file named `audit.log` in the log path) with
size/age rotation (`audit.rotation.maxsizemb`, `audit.rotation.maxage`).

### Logging

`log.standard` (`stdout`/`stderr`/`file`/`off`), `log.path` (default
`<rootpath>logs`), `log.level`, `log.format` (`text`/`structured` → JSON), plus
per-channel logs: `log.database`, `log.http`, `log.events`, `log.mail`.

## 7. Persistence checklist

Whatever you do, make sure these survive restarts and are included in backups:

| Data | Default location | Config key |
|---|---|---|
| SQLite database | `<rootpath>/vikunja.db` | `database.path` |
| Uploaded files | `<rootpath>/files` | `files.basepath` |
| Config | see search path (§4.1) | `--config` |
| Logs (if file logging) | `<rootpath>/logs` | `log.path` |
| ACME certs (autotls) | `files.basepath/.certs` | — |
| Plugins | `<rootpath>/plugins` | `plugins.dir` |

## 8. Backup, restore and upgrades

```bash
# Full backup: database + files + config → zip
vikunja dump                       # writes to service.rootpath
vikunja dump -p /backups -f my-backup.zip

# Restore on a fresh instance (stop the service first)
vikunja restore /backups/my-backup.zip
vikunja restore /backups/my-backup.zip --preserve-config   # keep current config
```

For PostgreSQL/MySQL you can also use native tools (`pg_dump`, `mysqldump`) —
back up the database and `files.basepath` together.

**Upgrading:**

1. Take a backup.
2. Build the new version (§2.2) and replace the binary.
3. Start the service — migrations run automatically before the web server
   accepts traffic.
4. `vikunja doctor` verifies config, database, storage and optional services
   after the upgrade.

## 9. CLI reference (operations)

| Command | Purpose |
|---|---|
| `vikunja` / `vikunja web` | Run the server |
| `vikunja doctor` | Diagnostics: system, config, DB version, file storage, Redis/mail/LDAP/OpenID (exit 1 on failure) |
| `vikunja healthcheck` | Check a running instance, exit 0/1 |
| `vikunja migrate [list\|rollback]` | Database migration management (runs automatically at startup anyway) |
| `vikunja dump` / `vikunja restore <file>` | Backup / restore everything |
| `vikunja testmail <email>` | Send an SMTP test mail |
| `vikunja user list\|create\|update\|reset-password\|change-status\|delete` | Manage users from the shell |
| `vikunja user set-admin --admin <username-or-id>` | Grant/revoke instance-admin (`--no-admin` revokes) |
| `vikunja repair …` | Fix data-integrity issues (`projects`, `task-positions`, `orphan-positions`, `file-mime-types`) |
| `vikunja version` | Print version |
| `--config <file>` | Global flag: pin the config file |

## 10. Production checklist

- [ ] `service.secret` set to a stable random value (not left to the per-boot default)
- [ ] `service.publicurl` set to the final HTTPS URL
- [ ] Database backed up and covered by `vikunja dump` or native dumps
- [ ] Absolute `database.path` (SQLite) / dedicated DB server (Postgres/MySQL)
- [ ] `files.basepath` on persistent storage
- [ ] TLS terminated (reverse proxy or `autotls`)
- [ ] `service.ipextractionmethod=xff` + `service.trustedproxies` when behind a proxy
- [ ] `service.testingtoken` left **empty** (it enables unauthenticated DB write endpoints)
- [ ] Registration/mail decided deliberately (`service.enableregistration`, `mailer.*`)
- [ ] `metrics.enabled` + basic auth if scraped by Prometheus
- [ ] Log rotation configured if `log.standard=file`
- [ ] Single server instance per database (in-process cron)


