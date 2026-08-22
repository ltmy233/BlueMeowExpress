# 蓝喵速递（BlueMeow Express）喵~

自己折腾的端到端加密聊天 App 喵。Android 客户端用 React + Capacitor，服务端用 Fastify + SQLite，不用外部数据库喵。

> **当前是测试版本喵**，语音通话功能还在完善中~ 理论上兼容 Android 6（API 23）及以上设备喵。

## 能干嘛喵~

- **消息端到端加密**：密钥在手机本地生成，私钥不上传，服务端只负责转发密文喵
- **私聊 / 群聊**：好友申请、拉黑、置顶、备注都有，群聊支持多种入群模式喵
- **语音消息**：录制、发送、气泡内直接播放喵
- **语音通话**：一对一 WebRTC 语音通话，带呼叫/响铃/拒绝/超时状态喵
- **消息编辑与撤回**：发出去的消息可以改、可以撤喵
- **阅后即焚**：设置消息自动销毁时间喵
- **VIP 系统**：卡密兑换，普通用户和 VIP 用户群组上限不同喵
- **平台管理员**：晋升码机制，管理员可以强制进群、审核入群、禁言、发群消息墓碑喵
- **管理面板**：网页后台管用户、发 VIP、发公告、看审计日志、上传 APK 发版喵
- **QQ 绑定**：配合 QQ 机器人插件，在 QQ 群里绑定账号、查用户、封禁、发 VIP 喵
- **App 内更新**：后台上传 APK，客户端检测版本，支持强制更新喵

## 项目组成喵~

这个项目分成三部分，互相独立喵：

### 1. 服务端（apps/server/）

Fastify + TypeScript + SQLite，跑在 Linux 服务器上喵。

| 文件 | 干什么喵 |
| --- | --- |
| `src/app.ts` | 全部路由和 WebSocket（约 1800 行）喵 |
| `src/config.ts` | 读取和校验环境变量喵 |
| `src/db.ts` | 打开 SQLite 数据库，执行迁移喵 |
| `src/domain.ts` | 业务规则：VIP 时长、群组限额、管理员权限喵 |
| `src/security.ts` | 密码哈希、SHA-256、时序安全比较、随机令牌喵 |
| `src/types.d.ts` | JWT payload 类型声明喵 |
| `src/migrate.ts` | 独立迁移脚本，可以单独跑喵 |
| `migrations/*.sql` | 22 个 SQL 迁移文件，启动时按文件名排序执行喵 |
| `public/index.html` | 管理面板页面喵 |
| `public/app.js` | 管理面板逻辑喵 |
| `public/styles.css` | 管理面板样式喵 |
| `test/*.test.ts` | 集成测试（47 个用例，node:test）喵 |
| `deploy/install.sh` | 一键部署脚本喵 |
| `deploy/lanmiao.service` | systemd 单元文件喵 |

### 2. 客户端（apps/client/）

React 19 + Vite + Capacitor 7，打包成 Android APK 喵。

| 文件 | 干什么喵 |
| --- | --- |
| `src/App.tsx` | 全部界面和状态管理（约 5200 行）喵 |
| `src/api/client.ts` | REST + WebSocket 通信封装喵 |
| `src/lib/crypto.ts` | ECDH/AES 密钥生成和加解密喵 |
| `src/lib/call.ts` | 语音通话状态机，callId 去重、状态流转喵 |
| `src/lib/storage.ts` | IndexedDB 本地存储封装喵 |
| `src/lib/session.ts` | 登录会话持久化喵 |
| `src/lib/history.ts` | 聊天记录本地缓存喵 |
| `src/lib/preferences.ts` | 聊天偏好：气泡颜色、墙纸、通知喵 |
| `src/lib/attachments.ts` | 附件本地缓存喵 |
| `src/lib/validation.ts` | 文件类型和大小校验喵 |
| `src/styles.css` | 全部样式喵 |
| `src/types.ts` | 客户端与服务端共享的类型定义喵 |
| `src/main.tsx` | React 入口喵 |
| `src/components/` | 动态样式注入、页面切换过渡喵 |
| `src/config/` | 主题方案配置喵 |
| `src/context/` | 背景主题上下文喵 |
| `android/` | Capacitor 生成的 Android 工程喵 |
| `version.json` | 版本号（versionCode / versionName）喵 |

### 3. QQ 机器人插件（apps/server/deploy/lanmiao_qq_verify/）

基于 **AstrBot + NapCat** 的 Python 插件喵。

> AstrBot 是 QQ 机器人框架，NapCat 是 QQ 协议的非官方实现喵。两者配合可以在 QQ 群里做自动回复和管理喵。

| 文件 | 干什么喵 |
| --- | --- |
| `main.py` | 插件主逻辑：登录绑定、管理命令、心跳上报喵 |
| `metadata.yaml` | 插件元信息（名称、版本、依赖）喵 |
| `_conf_schema.json` | 配置项定义（服务地址、令牌、群白名单等）喵 |
| `README.md` | 插件使用说明喵 |

**QQ 群命令：**

```
/login <验证码>          绑定 QQ 并登录喵
/st                     服务器状态喵
/find <关键词>           查询玩家喵
/ban <关键词>            封禁玩家喵
/unban <关键词>          解禁玩家喵
/vip <玩家> <时长>       发放 VIP（如：永久、7天、1月、1年）喵
/unvip <关键词>          撤销 VIP 喵
```

## 本地开发喵~

需要 Node.js >= 24（服务端用内置的 `node:sqlite`）喵。

```sh
npm install

# 启动服务端（默认 127.0.0.1:3210）喵
cp apps/server/.env.example apps/server/.env
npm run dev:server

# 启动客户端（vite，默认 5173）喵
npm run dev
```

生成密钥：

```sh
openssl rand -base64 48          # JWT_SECRET 喵
printf '%s' '你的密钥' | sha256sum   # ADMIN_ROOT_KEY_HASH 喵
```

## 打包喵~

### 服务端

```sh
cd apps/server
npm ci
npm test            # 可选，跑 47 个集成测试喵
npm run build       # 编译到 dist/ 喵
```

### Android APK

```sh
cd apps/client
npm run build                    # tsc 检查 + vite 构建喵
npx cap sync android             # 把 dist/ 同步到 Android 工程喵
cd android
./gradlew assembleDebug          # 调试包喵
./gradlew assembleRelease        # 正式包（需要配置签名）喵
```

APK 输出在 `android/app/build/outputs/apk/` 喵。

版本号在 `apps/client/version.json`，改完重新 `npm run build && npx cap sync android` 喵。

### Android 镜像加速（国内环境）喵

`android/build.gradle` 和 `android/settings.gradle` 已配置阿里云 Maven 镜像喵。每次 `cap sync` 后需要检查 `android/capacitor-cordova-android-plugins/build.gradle`，把 `google()` / `mavenCentral()` 替换成阿里云源喵：

```gradle
maven { url 'https://maven.aliyun.com/repository/google' }
maven { url 'https://maven.aliyun.com/repository/central' }
maven { url 'https://maven.aliyun.com/repository/public' }
```

## 部署喵~

建议 Linux（已在 CentOS 验证），流程喵：

```sh
cd apps/server
npm ci && npm test && npm run build

# 在服务器上用 root 跑喵
sudo sh deploy/install.sh /path/to/apps/server

# 配置密钥和 SMTP 喵
sudoedit /opt/lanmiao/config/server.env

# 启动喵
sudo systemctl enable --now lanmiao
```

### server.env 配置项喵

| 变量 | 说明喵 |
| --- | --- |
| `PORT` | 端口，默认 3210 喵 |
| `DATABASE_PATH` | SQLite 路径喵 |
| `JWT_SECRET` | `openssl rand -base64 48` 生成喵 |
| `ADMIN_ROOT_KEY_HASH` | `printf '%s' '密钥' \| sha256sum` 喵 |
| `PUBLIC_ORIGIN` | 公网 HTTPS 地址喵 |
| `SMTP_HOST` | SMTP 服务器（如 `smtp.163.com`）喵 |
| `SMTP_PORT` | SMTP 端口（465）喵 |
| `SMTP_USER` | 发件邮箱喵 |
| `SMTP_PASS` | 邮箱授权码（不是登录密码）喵 |
| `SMTP_FROM_EMAIL` | 发件地址喵 |
| `OFFLINE_TTL_SECONDS` | 离线密文保留时长，默认 86400 喵 |
| `QQ_BOT_PLUGIN_TOKEN` | QQ 插件令牌（可选）喵 |

### 反向代理喵

服务只监听 `127.0.0.1:3210`，前面放 nginx 做反向代理喵：

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

`/ws` 必须支持 WebSocket 升级喵。附件上传需要调大 `client_max_body_size` 喵。

### Android 证书信任喵

客户端默认信任系统证书喵。如果你用自签证书，需要喵：

1. 把证书放到 `apps/client/android/app/src/main/res/raw/lanmiao_server.pem` 喵
2. 重新打包 APK 喵

### QQ 机器人插件部署喵

1. 安装 AstrBot 和 NapCat 喵
2. 把 `apps/server/deploy/lanmiao_qq_verify/` 整个目录放到 AstrBot 插件目录喵
3. 在 AstrBot 管理面板配置 `service_url`、`plugin_token`、`whitelist_groups`、`admin_qq_ids` 喵
4. 重启 AstrBot 喵

### systemd 安全限制喵

`deploy/lanmiao.service` 限制了喵：

- 应用目录只读，只有 `/opt/lanmiao/data` 可写喵
- 内存上限 512M，单核，最多 128 进程喵
- 禁止提权、禁止访问 home 目录喵

### 数据库备份喵

```sh
# 在线备份（服务运行时安全）喵
sqlite3 /opt/lanmiao/data/lanmiao.sqlite ".backup /opt/lanmiao/backup/lanmiao-$(date +%Y%m%d).sqlite"
```

迁移是单向的，发新版前先在测试环境验证喵。

## 测试喵~

```sh
npm test                              # 全部喵
npm run test -w @lanmiao/server       # 服务端（47 个用例）喵
npm run test -w @lanmiao/client       # 客户端（15 个用例）喵
```

## 安全喵~

- 密码 scrypt 加盐存储，JWT 7 天过期喵
- 服务端不解密消息，离线密文 TTL 到期或 ack 后删除喵
- 附件临时中转，超期清理喵
- Root 密钥只存 SHA-256 哈希，子密钥随机生成、分权限喵
- 所有管理操作记审计日志喵

## 文档喵~

- [构建指南](docs/BUILDING.md)
- [部署指南](docs/DEPLOYMENT.md)
- [项目结构](docs/STRUCTURE.md)
- [API 文档](apps/server/docs/API.md)

## 鸣谢喵~

- DeepSeek V4 pro/Flash
- Chat GPT 5.6sol
- Claude Fable 5
- Mimo V2
- Hy3

## 许可喵~

本项目基于 GPL-3.0 协议开源，详情见仓库 LICENSE 文件喵。
