# Deployment (no containers)

**Fastest route on Ubuntu 22.04/24.04:** `deploy/install.sh` does the steps below in one run (see its header for the variables). The steps are listed so you can see, check or do them by hand. Verified here against a real PostgreSQL: a non-superuser owner login, `app_role` created first, migrations, first-admin, and the app running and signing in as `gh_app`. The script itself has only been syntax-checked, not run on a fresh server.

For a Linux server (Ubuntu 22.04/24.04 assumed) running the app directly with Node, PostgreSQL 16, a process manager and a reverse proxy. Verified here: migrations, the first-admin script, `npm run build`, `npm start`, `/api/health` and the login page. **Not verified here:** the systemd unit, nginx and TLS steps below (written from standard practice; run them on a staging server first).

**Status:** Stages 0 to 3 plus the hardening round are built. Stage 4 (operations and security), Stage 5 (email delivery, reports) and Stage 6 (UAT, penetration test) are not, so this is a staging or pilot deployment with test data, not a go-live. Proposed policies P-01 to P-14 are pending client sign-off; leave their defaults.

## 1. Server prerequisites

- Node.js 22 LTS (the app was built and tested on 22), `git`, `build-essential` and `python3` (only if the Argon2 native addon has no prebuilt binary for your CPU).
- PostgreSQL 16 with the `btree_gist` extension (part of `postgresql-contrib`; the bed-overlap constraint needs it).
- nginx (or any reverse proxy) and a TLS certificate. The session cookie is `Secure` in production, so **sign-in only works over HTTPS**.
- A non-root user to run the app, for example `ghapp`.

## 2. Database (once)

As the PostgreSQL superuser:

```sql
CREATE DATABASE gh_platform;
-- Owner: runs migrations only. Never used by the running app.
CREATE ROLE gh_owner LOGIN PASSWORD '<strong-password-1>';
ALTER DATABASE gh_platform OWNER TO gh_owner;
```

`app_role` must exist before the migrations run, because `gh_owner` cannot create roles (migration 0007 fails with "permission denied to create role" otherwise; checked). Create it, then the login the app will use. It has no DELETE rights and cannot change the audit log:

```sql
CREATE ROLE app_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE gh_app LOGIN PASSWORD '<strong-password-2>' IN ROLE app_role;
```

Allow both logins from the app host in `pg_hba.conf` (use `scram-sha-256`), and keep PostgreSQL off the public internet.

## 3. Get the code and configure

```bash
sudo -u ghapp git clone https://github.com/AdpediaGitOfficial/hayat.git /opt/gh-platform
cd /opt/gh-platform
sudo -u ghapp git checkout claude/compassionate-ride-kk4uj8     # or the release branch you agree
cd platform
sudo -u ghapp npm ci
sudo mkdir -p /var/lib/gh-platform/attachments && sudo chown ghapp: /var/lib/gh-platform/attachments
```

Create `/etc/gh-platform.env` (owner root, mode 0640, group `ghapp`; never commit it):

```
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://gh_app:<strong-password-2>@127.0.0.1:5432/gh_platform
ATTACHMENT_DIR=/var/lib/gh-platform/attachments
INTERNAL_JOB_TOKEN=<long random string, optional, only if a scheduler calls the sweeps over HTTP>
```

## 4. Migrate and build

```bash
cd /opt/gh-platform/platform
# privileged (owner) URL, for this command only. Never put this password in /etc/gh-platform.env
sudo -u ghapp env DATABASE_URL=postgres://gh_owner:<strong-password-1>@127.0.0.1:5432/gh_platform npm run db:migrate
sudo -u ghapp npm run build
```

Migrations are forward-only and checksummed; re-running is safe. **Do not run `npm run db:seed`** in production: it creates demo accounts for every role.

## 5. Create the first Super Admin (once)

```bash
sudo -u ghapp env DATABASE_URL=postgres://gh_owner:<strong-password-1>@127.0.0.1:5432/gh_platform \
  ADMIN_EMPLOYEE_ID=<employee id> ADMIN_NAME="<full name>" ADMIN_PASSWORD='<temporary, 12+ characters>' \
  npm run db:first-admin
```

It refuses if a Super Admin already exists, writes an audit entry, and forces a new password at first sign-in. Everything else (sites, buildings, staff, other roles) is then created in the app.

## 6. Run the app (systemd)

`/etc/systemd/system/gh-platform.service`:

```ini
[Unit]
Description=Grand Hyatt Staff Accommodation Platform
After=network.target postgresql.service

[Service]
User=ghapp
WorkingDirectory=/opt/gh-platform/platform
EnvironmentFile=/etc/gh-platform.env
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Alternative to systemd: PM2

`deploy/ecosystem.config.cjs` runs the app and the sweeps under PM2 instead of steps 6 and 7. Tested here: both processes start from that file, the app answers `/api/health`, and the sweeps loop runs. The `pm2 startup` boot step is not tested.

```bash
sudo npm install -g pm2
sudo -u ghapp pm2 start /opt/gh-platform/deploy/ecosystem.config.cjs
sudo -u ghapp pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ghapp --hp /home/ghapp   # prints one command; run it once so PM2 starts on boot
```

Settings come from `/etc/gh-platform.env` through Node's `--env-file`, so the file must be readable by `ghapp` (mode 0640, group `ghapp`). Use `pm2 logs`, `pm2 restart gh-platform gh-sweeps` and `pm2 status`. Run the app as one process: it keeps per-process state, so don't use `-i max` cluster mode. Use either PM2 or the systemd services, not both, or the port is taken twice.

## 7. Run the sweeps (reminders and escalations)

The timers (offer expiry, reminders, escalation; they never approve, reject or move anyone) run in a separate process. Without it nothing escalates. `/etc/systemd/system/gh-sweeps.service`:

```ini
[Unit]
Description=Grand Hyatt platform sweeps
After=network.target postgresql.service

[Service]
User=ghapp
WorkingDirectory=/opt/gh-platform/platform
EnvironmentFile=/etc/gh-platform.env
ExecStart=/usr/bin/npm run sweeps -- --loop 60
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gh-platform gh-sweeps
```

(Alternative: a cron job or timer that calls `POST /api/v1/internal/sweeps` with `Authorization: Bearer $INTERNAL_JOB_TOKEN`.)

## 8. Reverse proxy and TLS (nginx)

```nginx
server {
  listen 443 ssl http2;
  server_name accommodation.example.com;
  ssl_certificate     /etc/letsencrypt/live/accommodation.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/accommodation.example.com/privkey.pem;
  client_max_body_size 30m;                       # attachments are sent base64 (+33%); the setting allows up to 20 MB (default 5)
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
server { listen 80; server_name accommodation.example.com; return 301 https://$host$request_uri; }
```

Certificate: `certbot --nginx -d accommodation.example.com`. Open only ports 80 and 443 on the firewall.

## 9. Check it works

```bash
curl -s https://accommodation.example.com/api/health      # {"status":"ok","db":{"status":"up",...}}
journalctl -u gh-platform -u gh-sweeps -f                 # logs
```

Then sign in as the first Super Admin, set the new password, and create sites, buildings, rooms and beds.

## 10. Backups and updates

- **Back up** the database (`pg_dump -Fc gh_platform`, nightly, copied off the server, restore tested) and `/var/lib/gh-platform/attachments` (uploaded evidence lives only there). The audit log is in the database.
- **Update:** `git pull`, `npm ci`, run `db:migrate` with the owner URL, `npm run build`, `systemctl restart gh-platform gh-sweeps`. Take a database backup first; migrations cannot be rolled back.
- Single server, single app process: do not run several copies pointing at one attachments folder unless it is shared storage.

## 11. Before real users

Open items from `docs/PLAN.md`: email delivery is not wired to a mail service (notifications are in-app only until Stage 5); Next.js 14 advisories (S-7) to be reviewed before the penetration test; session lifetimes and password rules are placeholders (G-11); Grand Hyatt's answers on SOS recipients, contractor access, outage reconciliation and the bed-capacity baseline are still open.
