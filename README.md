# 蓝喵速递 BlueMeow Express

端到端加密即时通信应用。Android 客户端基于 React + Capacitor，服务端基于 Fastify + SQLite，无需外部数据库依赖。

> **当前版本 v1.1.50**，理论上兼容 Android 6（API 23）及以上设备。

## 功能

- **端到端加密**：密钥本地生成，私钥不上传，服务端只转发密文
- **私聊 / 群聊**：好友申请、拉黑、置顶、备注，群聊支持多种入群模式
- **语音消息**：录制、发送、气泡内播放
- **语音通话**：一对一 WebRTC 语音通话，带呼叫/响铃/拒绝/超时状态
- **消息编辑与撤回**
- **阅后即焚**：消息自动销毁
- **VIP 系统**：卡密兑换，普通用户和 VIP 用户群组上限不同
- **平台管理员**：晋升码机制，管理员可强制进群、审核入群、禁言
- **管理面板**：网页后台管理用户、发 VIP、发公告、审计日志、APK 发版
- **QQ 绑定**：配合 QQ 机器人插件，在 QQ 群里绑定账号、管理用户
- **App 内更新**：后台上传 APK，客户端检测版本，支持强制更新

## 项目结构

项目分为三部分，互相独立：

### 1. 服务端（apps/server/）

Fastify + TypeScript + SQLite，运行在 Linux 服务器上。

| 文件 | 说明 |
| --- | --- |
| `src/app.ts` | 全部路由和 WebSocket |
| `src/config.ts` | 环境变量读取和校验 |
| `src/db.ts` | SQLite 数据库打开和迁移 |
| `src/domain.ts` | 业务规则：VIP 时长、群组限额、管理员权限 |
| `src/security.ts` | 密码哈希、SHA-256、时序安全比较、随机令牌 |
| `src/types.d.ts` | JWT payload 类型声明 |
| `migrations/*.sql` | SQL 迁移文件，启动时按文件名排序执行 |
| `public/` | 管理面板（纯静态页面） |
| `test/*.test.ts` | 集成测试（node:test） |
| `deploy/install.sh` | 一键部署脚本 |
| `deploy/lanmiao.service` | systemd 单元文件 |

### 2. 客户端（apps/client/）

React 19 + Vite + Capacitor 7，打包成 Android APK。

| 文件 | 说明 |
| --- | --- |
| `src/App.tsx` | 全部界面和状态管理 |
| `src/api/client.ts` | REST + WebSocket 通信封装 |
| `src/lib/crypto.ts` | ECDH/AES 密钥生成和加解密 |
| `src/lib/call.ts` | 语音通话状态机 |
| `src/lib/storage.ts` | IndexedDB 本地存储封装 |
| `src/lib/session.ts` | 登录会话持久化 |
| `src/lib/history.ts` | 聊天记录本地缓存 |
| `src/lib/preferences.ts` | 聊天偏好：气泡颜色、墙纸、通知 |
| `src/lib/attachments.ts` | 附件本地缓存 |
| `src/styles.css` | 全部样式 |
| `src/types.ts` | 客户端与服务端共享的类型定义 |
| `src/components/` | 动态样式注入、页面切换过渡 |
| `src/config/` | 主题方案配置 |
| `src/context/` | 背景主题上下文 |
| `android/` | Capacitor 生成的 Android 工程 |
| `version.json` | 版本号（versionCode / versionName） |

### 3. QQ 机器人插件（apps/server/deploy/lanmiao_qq_verify/）

基于 AstrBot + NapCat 的 Python 插件。AstrBot 是 QQ 机器人框架，NapCat 是 QQ 协议的非官方实现。

| 文件 | 说明 |
| --- | --- |
| `main.py` | 插件主逻辑：登录绑定、管理命令、心跳上报 |
| `metadata.yaml` | 插件元信息 |
| `_conf_schema.json` | 配置项定义 |

QQ 群命令：

```
/login <验证码>          绑定 QQ 并登录
/st                     服务器状态
/find <关键词>           查询用户
/ban <关键词>            封禁用户
/unban <关键词>          解禁用户
/vip <用户> <时长>       发放 VIP（如：永久、7天、1月、1年）
/unvip <关键词>          撤销 VIP
```

## 本地开发

需要 Node.js >= 24（服务端用内置的 `node:sqlite`）。

```sh
npm install

# 启动服务端（默认 127.0.0.1:3210）
cp apps/server/.env.example apps/server/.env
npm run dev:server

# 启动客户端（vite，默认 5173）
npm run dev
```

生成密钥：

```sh
openssl rand -base64 48          # JWT_SECRET
printf '%s' '你的密钥' | sha256sum   # ADMIN_ROOT_KEY_HASH
```

## 打包

### 服务端

```sh
cd apps/server
npm ci
npm test            # 可选，跑集成测试
npm run build       # 编译到 dist/
```

### Android APK

```sh
cd apps/client
npm run build                    # tsc 检查 + vite 构建
npx cap sync android             # 把 dist/ 同步到 Android 工程
cd android
./gradlew assembleDebug          # 调试包
./gradlew assembleRelease        # 正式包（需要配置签名）
```

APK 输出在 `android/app/build/outputs/apk/`。

版本号在 `apps/client/version.json`，改完重新 `npm run build && npx cap sync android`。

### Android 镜像加速（国内环境）

`android/build.gradle` 和 `android/settings.gradle` 已配置阿里云 Maven 镜像。每次 `cap sync` 后需要检查 `android/capacitor-cordova-android-plugins/build.gradle`，把 `google()` / `mavenCentral()` 替换成阿里云源：

```gradle
maven { url 'https://maven.aliyun.com/repository/google' }
maven { url 'https://maven.aliyun.com/repository/central' }
maven { url 'https://maven.aliyun.com/repository/public' }
```

## 部署

建议 Linux 环境，流程：

```sh
cd apps/server
npm ci && npm test && npm run build

# 在服务器上用 root 执行
sudo sh deploy/install.sh /path/to/apps/server

# 配置密钥和 SMTP
sudoedit /opt/lanmiao/config/server.env

# 启动
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
| `SMTP_HOST` | SMTP 服务器（如 `smtp.163.com`） |
| `SMTP_PORT` | SMTP 端口（465） |
| `SMTP_USER` | 发件邮箱 |
| `SMTP_PASS` | 邮箱授权码（不是登录密码） |
| `SMTP_FROM_EMAIL` | 发件地址 |
| `OFFLINE_TTL_SECONDS` | 离线密文保留时长，默认 86400 |
| `QQ_BOT_PLUGIN_TOKEN` | QQ 插件令牌（可选） |
| `IP_GEO_KEY` | IP 定位服务密钥（可选，申请地址: tool.hiofd.com） |
| `IP_GEO_PWD` | IP 定位服务密码（可选） |

### 反向代理

服务只监听 `127.0.0.1:3210`，前面放 nginx 做反向代理：

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

`/ws` 必须支持 WebSocket 升级。附件上传需要调大 `client_max_body_size`。

### Android 证书信任

客户端默认信任系统证书。如果用自签证书，需要把证书放到 `apps/client/android/app/src/main/res/raw/lanmiao_server.pem`，然后重新打包 APK。

### QQ 机器人插件部署

1. 安装 AstrBot 和 NapCat
2. 把 `apps/server/deploy/lanmiao_qq_verify/` 整个目录放到 AstrBot 插件目录
3. 在 AstrBot 管理面板配置 `service_url`、`plugin_token`、`whitelist_groups`、`admin_qq_ids`
4. 重启 AstrBot

### systemd 安全限制

`deploy/lanmiao.service` 的限制：

- 应用目录只读，只有 `/opt/lanmiao/data` 可写
- 内存上限 512M，单核，最多 128 进程
- 禁止提权、禁止访问 home 目录

### 数据库备份

```sh
# 在线备份（服务运行时安全）
sqlite3 /opt/lanmiao/data/lanmiao.sqlite ".backup /opt/lanmiao/backup/lanmiao-$(date +%Y%m%d).sqlite"
```

迁移是单向的，发新版前先在测试环境验证。

## 测试

```sh
npm test                              # 全部
npm run test -w @lanmiao/server       # 服务端
npm run test -w @lanmiao/client       # 客户端
```

## 安全

- 密码 scrypt 加盐存储，JWT 7 天过期
- 服务端不解密消息，离线密文 TTL 到期或 ack 后删除
- 附件临时中转，超期清理
- Root 密钥只存 SHA-256 哈希，子密钥随机生成、分权限
- 所有管理操作记审计日志

## 文档

- [构建指南](docs/BUILDING.md)
- [部署指南](docs/DEPLOYMENT.md)
- [项目结构](docs/STRUCTURE.md)
- [API 文档](apps/server/docs/API.md)

## 许可

本项目基于 GPL-3.0 协议开源，详情见仓库 LICENSE 文件。
