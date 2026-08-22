# 蓝喵速递服务端

Fastify/TypeScript backend, SQLite storage, encrypted-envelope WebSocket relay, 163 SMTP verification, and a backend-served administration panel.

## Local development

Requires Node.js 24 or newer. From `apps/server`:

```sh
npm install
cp .env.example .env
npm run dev
```

Node does not load `.env` automatically in this project. Export the variables through your shell/service manager, or launch locally with Node's environment file support:

```sh
node --env-file=.env --import tsx src/index.ts
```

Generate secrets without storing plaintext in source control:

```sh
openssl rand -base64 48
printf '%s' 'your-root-key' | sha256sum
```

Set the first output as `JWT_SECRET`. Keep the root key in a password manager and set only its lowercase SHA-256 digest as `ADMIN_ROOT_KEY_HASH`. Configure the 163 account's SMTP authorization code in `SMTP_PASS`, not its login password. The sender address must be authorized by the account; `SMTP_FROM_NAME` defaults to `蓝天科技`.

The admin panel is served at `/admin/`. API and WebSocket contracts are documented in [docs/API.md](docs/API.md).

## Production deployment

Build on a Node 24 Linux host or in CI:

```sh
npm ci
npm run test
npm run build
sudo sh deploy/install.sh "$PWD"
sudoedit /opt/lanmiao/config/server.env
sudo systemctl enable --now lanmiao
```

The installer creates a dedicated `lanmiao` system user and uses only `/opt/lanmiao`, `/etc/systemd/system/lanmiao.service`, and its own systemd unit. It does not inspect, stop, restart, modify, or share files with any existing QQ bot. The service is bound to `127.0.0.1` by default; terminate TLS and proxy WebSocket upgrades using the existing reverse proxy. Set `PUBLIC_ORIGIN` to the public HTTPS origin.

The systemd unit limits memory to 512 MiB, CPU to one core, tasks to 128, makes the application tree read-only, and grants write access only to `/opt/lanmiao/data`. Back up the SQLite database using SQLite's online backup mechanism while the service is running. Restrict `/opt/lanmiao/config/server.env` to root and the `lanmiao` group as installed.

## Security model

- Passwords use salted `scrypt`; JWTs expire after seven days and every authenticated request checks current ban state.
- The server accepts opaque encrypted message envelopes and has no decryption keys. Offline envelopes expire after `OFFLINE_TTL_SECONDS` and are deleted upon recipient acknowledgment.
- Group delivery requires a distinct encrypted envelope for every visible member. Governance stores routing metadata and removal tombstones only; it provides no message-content or chat-history access.
- File transfer and WebRTC signaling use transient WebSocket frames. File bodies are rejected by the HTTP body limit and are never persisted.
- Root admin authorization compares the supplied key hash against `ADMIN_ROOT_KEY_HASH`. Subordinate keys are random, stored as SHA-256 hashes, scoped, shown once, and can only be created or revoked by root.
- Secrets are redacted from request logs. Administrative state changes and VIP operations create audit records.
- Root-only, hash-stored one-use promotion codes grant a visibly governed platform-admin user role. Forced group membership is listed to all members, interventions are attributed as `平台管理员`, peer administrators are protected, and all governance actions are audited.
