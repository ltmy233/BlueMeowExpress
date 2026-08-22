#!/bin/sh
set -eu

APP_SOURCE=${1:-$(pwd)}
if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo deploy/install.sh /path/to/apps/server" >&2
  exit 1
fi

id lanmiao >/dev/null 2>&1 || useradd --system --home-dir /opt/lanmiao --shell /usr/sbin/nologin lanmiao
install -d -o root -g lanmiao -m 0750 /opt/lanmiao /opt/lanmiao/config
install -d -o lanmiao -g lanmiao -m 0750 /opt/lanmiao/app /opt/lanmiao/data

rm -rf /opt/lanmiao/app/dist /opt/lanmiao/app/public /opt/lanmiao/app/migrations /opt/lanmiao/app/node_modules
cp -R "$APP_SOURCE/dist" "$APP_SOURCE/public" "$APP_SOURCE/migrations" /opt/lanmiao/app/
cp "$APP_SOURCE/package.json" "$APP_SOURCE/package-lock.json" /opt/lanmiao/app/
(cd /opt/lanmiao/app && npm ci --omit=dev --ignore-scripts)
chown -R root:lanmiao /opt/lanmiao/app
chmod -R o-rwx /opt/lanmiao/app

if [ ! -f /opt/lanmiao/config/server.env ]; then
  install -o root -g lanmiao -m 0640 "$APP_SOURCE/.env.example" /opt/lanmiao/config/server.env
  echo "Created /opt/lanmiao/config/server.env; configure secrets before starting." >&2
fi

install -o root -g root -m 0644 "$APP_SOURCE/deploy/lanmiao.service" /etc/systemd/system/lanmiao.service
systemctl daemon-reload
echo "Deployment staged. Review server.env, then run: systemctl enable --now lanmiao"
