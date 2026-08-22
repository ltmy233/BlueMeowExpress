# 部署指南

## 架构

```
Android 客户端
    │  /api/*    REST
    │  /ws       WebSocket
    ▼
nginx（终止 TLS）
    ▼
Fastify（127.0.0.1:3210，systemd 管理）
    ├── /opt/lanmiao/app         应用文件（只读）
    ├── /opt/lanmiao/data        SQLite 数据库（可写）
    └── /opt/lanmiao/config      server.env 配置
```

## 首次部署

```sh
cd apps/server
npm ci && npm test && npm run build

# 在服务器上用 root 执行
sudo sh deploy/install.sh /path/to/apps/server
```

`install.sh` 执行的操作：

1. 创建 `lanmiao` 系统用户
2. 复制 `dist/`、`public/`、`migrations/`、`package*.json` 到 `/opt/lanmiao/app`
3. 在应用目录 `npm ci --omit=dev`
4. 如果没有 `server.env` 就从 `.env.example` 复制一份
5. 安装 systemd 单元

然后配置启动：

```sh
sudoedit /opt/lanmiao/config/server.env
sudo systemctl enable --now lanmiao
```

### server.env 配置项

| 变量 | 说明 |
| --- | --- |
| `PORT` | 端口，默认 3210 |
| `DATABASE_PATH` | SQLite 路径 |
| `JWT_SECRET` | `openssl rand -base64 48` 生成 |
| `ADMIN_ROOT_KEY_HASH` | `printf '%s' '密钥' \| sha256sum` |
| `PUBLIC_ORIGIN` | 公网 HTTPS 地址 |
| `SMTP_*` | 163 邮箱验证码（授权码不是登录密码） |
| `OFFLINE_TTL_SECONDS` | 离线密文保留时长，默认 86400 |
| `QQ_BOT_PLUGIN_TOKEN` | QQ 插件令牌（可选） |
| `IP_GEO_KEY` | IP 定位服务密钥（可选，申请地址: tool.hiofd.com） |
| `IP_GEO_PWD` | IP 定位服务密码（可选） |

## 反向代理

nginx 参考配置：

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl;
    server_name 你的域名;
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

注意：`/ws` 必须支持 WebSocket 升级，附件上传需要调大 `client_max_body_size`。

## 数据库备份

在线备份（服务运行时安全）：

```sh
sqlite3 /opt/lanmiao/data/lanmiao.sqlite ".backup /opt/lanmiao/backup/lanmiao-$(date +%Y%m%d).sqlite"
```

恢复：停服后替换文件重启。

迁移是单向的，发新版前先在测试环境验证。

## 升级

```sh
cd apps/server
npm ci && npm test && npm run build

rsync -a dist/ root@server:/opt/lanmiao/app/dist/
rsync -a migrations/ root@server:/opt/lanmiao/app/migrations/
ssh root@server 'chown -R root:lanmiao /opt/lanmiao/app && systemctl restart lanmiao'
```

## systemd

`deploy/lanmiao.service` 的安全限制：

- 应用目录只读，只有 `/opt/lanmiao/data` 可写
- 内存上限 512M，单核，最多 128 进程
- 禁止提权、禁止访问 home 目录

## QQ 插件（可选）

`deploy/lanmiao_qq_verify/` 是 AstrBot 插件，功能：

- QQ 群内绑定账号（`/login`）
- 管理命令：查用户、封禁、解封、发 VIP、撤销 VIP
- 心跳上报到服务端

配置 `QQ_BOT_PLUGIN_TOKEN` 后启用。

## 管理面板

- 地址：`https://你的域名/admin/`
- 登录：Root 管理密钥或 `LTSD-ADM-` 子密钥
- 功能：用户管理、封禁、VIP、晋升码、公告、审计日志、APK 发布
