#!/usr/bin/env bash
# Installs the Grand Hyatt Staff Accommodation Platform on Ubuntu 22.04 or 24.04 (no containers).
# Run as root on a fresh server:
#   sudo DOMAIN=accommodation.example.com ADMIN_EMPLOYEE_ID=E0001 ADMIN_NAME="Full Name" \
#        ADMIN_PASSWORD='a-temporary-password-12+chars' bash deploy/install.sh
# Optional: ENABLE_UFW=1 (also turn on the firewall for SSH, 80, 443), BRANCH (default claude/compassionate-ride-kk4uj8), REPO_URL, APP_DIR (default /opt/gh-platform).
# Safe to re-run: it keeps existing database passwords and does not create a second Super Admin.
set -euo pipefail

: "${DOMAIN:?set DOMAIN}" "${ADMIN_EMPLOYEE_ID:?set ADMIN_EMPLOYEE_ID}" "${ADMIN_NAME:?set ADMIN_NAME}" "${ADMIN_PASSWORD:?set ADMIN_PASSWORD}"
BRANCH="${BRANCH:-claude/compassionate-ride-kk4uj8}"
REPO_URL="${REPO_URL:-https://github.com/AdpediaGitOfficial/hayat.git}"
APP_DIR="${APP_DIR:-/opt/gh-platform}"
ENV_FILE=/etc/gh-platform.env
DB=gh_platform
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)"; exit 1; }
. /etc/os-release; [ "$ID" = ubuntu ] || { echo "Ubuntu only"; exit 1; }

echo "== 1/8 packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg build-essential python3 nginx openssl ufw
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! apt-cache policy postgresql-16 | grep -q 'Candidate: [0-9]'; then   # Ubuntu 22.04 needs the PostgreSQL project repository
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -y
fi
apt-get install -y postgresql-16 postgresql-contrib
systemctl enable --now postgresql

echo "== 2/8 database and roles"
OWNER_PW=""; APP_PW=""
if [ -f "$ENV_FILE" ]; then   # re-run: reuse the passwords already in use
  APP_PW=$(sed -n 's|^DATABASE_URL=postgres://gh_app:\([^@]*\)@.*|\1|p' "$ENV_FILE")
fi
OWNER_FILE=/root/.gh-platform-owner   # root only: the app itself must never be able to connect as the owner
[ -f "$OWNER_FILE" ] && OWNER_PW=$(cat "$OWNER_FILE")
[ -n "$OWNER_PW" ] || OWNER_PW=$(openssl rand -hex 24)
( umask 077; printf '%s' "$OWNER_PW" > "$OWNER_FILE" )
[ -n "$APP_PW" ] || APP_PW=$(openssl rand -hex 24)
psql_su() { sudo -u postgres psql -v ON_ERROR_STOP=1 -qtA "$@"; }
# app_role must exist before the migrations run: the owner login below cannot create roles.
psql_su -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_role') THEN CREATE ROLE app_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END \$\$;"
psql_su -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gh_owner') THEN CREATE ROLE gh_owner LOGIN PASSWORD '${OWNER_PW}'; ELSE ALTER ROLE gh_owner PASSWORD '${OWNER_PW}'; END IF; END \$\$;"
psql_su -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gh_app') THEN CREATE ROLE gh_app LOGIN PASSWORD '${APP_PW}' IN ROLE app_role; ELSE ALTER ROLE gh_app PASSWORD '${APP_PW}'; END IF; END \$\$;"
[ "$(psql_su -c "SELECT 1 FROM pg_database WHERE datname='${DB}'")" = 1 ] || psql_su -c "CREATE DATABASE ${DB} OWNER gh_owner"

echo "== 3/8 app user and code"
id ghapp >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin ghapp
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH" && git -C "$APP_DIR" checkout "$BRANCH" && git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
chown -R ghapp: "$APP_DIR"
install -d -o ghapp -g ghapp /var/lib/gh-platform/attachments

echo "== 4/8 configuration (${ENV_FILE})"
if [ ! -f "$ENV_FILE" ]; then
  umask 027
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://gh_app:${APP_PW}@127.0.0.1:5432/${DB}
ATTACHMENT_DIR=/var/lib/gh-platform/attachments
INTERNAL_JOB_TOKEN=$(openssl rand -hex 24)
ENV
  chown root:ghapp "$ENV_FILE"; chmod 640 "$ENV_FILE"
fi
OWNER_URL="postgres://gh_owner:${OWNER_PW}@127.0.0.1:5432/${DB}"

echo "== 5/8 install, migrate, build"
cd "$APP_DIR/platform"
sudo -u ghapp npm ci
sudo -u ghapp env DATABASE_URL="$OWNER_URL" npm run db:migrate
sudo -u ghapp env NODE_ENV=production npm run build

echo "== 6/8 first Super Admin"
if [ "$(psql_su -d "$DB" -c "SELECT count(*) FROM role_assignment WHERE role='SA'")" = 0 ]; then
  sudo -u ghapp env DATABASE_URL="$OWNER_URL" ADMIN_EMPLOYEE_ID="$ADMIN_EMPLOYEE_ID" ADMIN_NAME="$ADMIN_NAME" ADMIN_PASSWORD="$ADMIN_PASSWORD" npm run db:first-admin
else
  echo "A Super Admin already exists; skipped."
fi

echo "== 7/8 services"
cp "$APP_DIR/deploy/gh-platform.service" "$APP_DIR/deploy/gh-sweeps.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable gh-platform gh-sweeps
systemctl restart gh-platform gh-sweeps

echo "== 8/8 nginx and firewall"
sed "s/__DOMAIN__/${DOMAIN}/g" "$APP_DIR/deploy/nginx-site.conf" > /etc/nginx/sites-available/gh-platform
ln -sf /etc/nginx/sites-available/gh-platform /etc/nginx/sites-enabled/gh-platform
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
if [ "${ENABLE_UFW:-0}" = 1 ]; then   # opt-in: enabling a firewall over SSH can lock you out if SSH is not on the default port
  ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null; ufw --force enable >/dev/null
fi

sleep 5
curl -fsS http://127.0.0.1:3000/api/health && echo
cat <<DONE

Installed. Two things are left, both need you:
  1. Point the DNS A record for ${DOMAIN} at this server, then add HTTPS (sign-in only works over HTTPS):
       apt-get install -y certbot python3-certbot-nginx && certbot --nginx -d ${DOMAIN}
  2. Open https://${DOMAIN}, sign in as ${ADMIN_EMPLOYEE_ID} with the temporary password, and set a new one.
Back up: the database (sudo -u postgres pg_dump -Fc ${DB}) and /var/lib/gh-platform/attachments.
DONE
