# 部署指南

## 架构总览

```
Android 客户端 (Capacitor + HTTPS)
        │  /api/*        REST（登录、资料、联系人、群组、VIP、管理接口）
        │  /ws           WebSocket（实时消息信封、信令、心跳）
        ▼
反向代理 (nginx / caddy，终止 TLS)
        ▼
Fastify 服务 (127.0.0.1:3210, systemd: lanmiao)
        ├── /opt/lanmiao/app         应用树（只读：dist/public/migrations/node_modules）
        ├── /opt/lanmiao/data        SQLite 数据库（可写，WAL 模式）
        └── /opt/lanmiao/config      server.env 环境配置（仅 root/lanmiao 组可读）
```

## 首次部署

```sh
# 在构建机（Node 24+ Linux）上
cd apps/server
npm ci
npm test
npm run build

# 在服务器上以 root 执行
sudo sh deploy/install.sh /path/to/apps/server
```

`install.sh` 会：

1. 创建系统用户 `lanmiao`（nologin）
2. 复制 `dist/`、`public/`、`migrations/`、`package.json`、`package-lock.json` 到 `/opt/lanmiao/app`
3. 在 `/opt/lanmiao/app` 执行 `npm ci --omit=dev`
4. 若 `/opt/lanmiao/config/server.env` 不存在，从 `.env.example` 生成
5. 安装 systemd 单元 `/etc/systemd/system/lanmiao.service`

随后配置并启动：

```sh
sudoedit /opt/lanmiao/config/server.env
sudo systemctl enable --now lanmiao
systemctl status lanmiao
```

### server.env 关键配置

| 变量 | 说明 |
| --- | --- |
| `PORT` | 监听端口，默认 3210（仅本机） |
| `DATABASE_PATH` | SQLite 路径，默认 `/opt/lanmiao/data/lanmiao.sqlite` |
| `JWT_SECRET` | >= 32 字符随机串（`openssl rand -base64 48`） |
| `ADMIN_ROOT_KEY_HASH` | Root 管理密钥的 SHA-256 十六进制（`printf '%s' '密钥' \| sha256sum`），只存哈希 |
| `PUBLIC_ORIGIN` | 公网 HTTPS 源，用于 CORS 与链接生成 |
| `SMTP_*` | 163 邮箱验证码发送（授权码，不是登录密码） |
| `OFFLINE_TTL_SECONDS` | 离线密文队列保留时长，默认 86400（1 天） |
| `EMAIL_CODE_TTL_SECONDS` | 邮箱验证码有效期，默认 600 秒 |
| `QQ_BOT_PLUGIN_TOKEN` | QQ 机器人插件鉴权令牌（可选，配置后启用 QQ 管理端点） |

## 反向代理

服务仅监听 `127.0.0.1`，必须由反向代理终止 TLS 并提供公网域名（Android 要求受信任证书）。

nginx 关键配置：

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl;
    server_name your-domain.example;
    ssl_certificate     /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;

    client_max_body_size 40m;

    location / {
        proxy_pass http://127.0.0.1:3210;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 90s;
    }
}
```

注意：

- `/ws` 必须支持 WebSocket 升级（`Upgrade` / `Connection` 头）
- 附件上传允许 36 MiB（APK 发布接口的 bodyLimit），`client_max_body_size` 需相应调大
- 按公网域名设置 `PUBLIC_ORIGIN`，否则 CORS 会拒绝客户端请求

## 数据库与备份

- SQLite 数据库：`/opt/lanmiao/data/lanmiao.sqlite`（WAL 模式，伴随 `-wal` / `-shm` 文件）
- 迁移：`migrations/` 下 SQL 文件按文件名排序，启动时自动应用未执行项，记录在 `schema_migrations` 表
- **迁移是单向的**：发布新版本前先在测试环境验证迁移，生产库不可回滚

在线备份（服务运行中安全）：

```sh
# 在服务器上
sqlite3 /opt/lanmiao/data/lanmiao.sqlite ".backup /opt/lanmiao/backup/lanmiao-$(date +%Y%m%d).sqlite"
```

恢复：停服后替换数据库文件并重启。

## 升级部署

```sh
cd apps/server
npm ci && npm test && npm run build

# 上传构建产物（替换 dist/ 与 migrations/ 后重启）
rsync -a dist/ root@server:/opt/lanmiao/app/dist/
rsync -a migrations/ root@server:/opt/lanmiao/app/migrations/
ssh root@server 'chown -R root:lanmiao /opt/lanmiao/app && systemctl restart lanmiao'
```

管理面板 GUI（`apps/server/public/`）改动同样上传到 `/opt/lanmiao/app/public/`。升级前建议先备份数据库。

## systemd 单元说明

`deploy/lanmiao.service` 的防护措施：

- `ProtectSystem=strict` + `ReadWritePaths=/opt/lanmiao/data`：应用树只读
- `NoNewPrivileges`、`PrivateTmp`、`ProtectHome`
- `MemoryMax=512M`、`CPUQuota=100%`、`TasksMax=128`
- 以 `lanmiao` 无登录用户运行

## QQ 机器人插件（可选）

服务端提供 `deploy/lanmiao_qq_verify` 插件目录（NoneBot / 独立进程），用于：

- 接收 QQ 用户绑定请求（输入邮箱验证码完成 QQ 号 ↔ 账号绑定）
- 上报机器人心跳（面板显示在线状态）
- 按面板策略执行封禁 / 解封 / VIP 发放等管理命令

启用方式：配置 `QQ_BOT_PLUGIN_TOKEN` 并运行插件进程，插件通过 HTTP 回调服务端 `/api/qq/*` 端点。

## 管理面板

- 地址：`https://your-domain.example/admin/`
- 登录：输入 Root 管理密钥（或已创建的 `LTMY-ADM-` 子密钥）
- 功能：用户管理、封禁、VIP 发放、晋升码、平台管理员、公告、审计日志、APK 发布

## 常见问题

- **服务起不来**：`journalctl -u lanmiao -e` 查看日志；多数是 `server.env` 密钥长度/格式问题
- **客户端收不到消息**：确认反向代理的 WebSocket 升级头与 `PUBLIC_ORIGIN`
- **邮箱验证码发不出**：检查 `SMTP_PASS` 是否为 163 授权码，发件地址是否已在 163 后台授权