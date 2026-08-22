# 蓝喵速递（LanMiao Express）

端到端加密即时通信应用：React + Capacitor Android 客户端、Fastify + SQLite 服务端，内置管理面板与 QQ 插件联动。

## 功能概览

- **端到端加密**：密钥在 Android 设备本地生成，私钥永不上传；每条消息按接收方公钥分别加密（ECDH-P256 / AES-256-GCM）
- **服务端只中转不读取**：仅短期保存无法立即投递的密文队列，送达确认（ack）后即删除
- **私聊 / 群聊 / 好友系统**：好友申请需对方同意（实时推送通知），支持拉黑、置顶、备注
- **VIP 与平台治理**：VIP 兑换码、平台管理员晋升码、强制进群、群治理（禁言/移除/群消息墓碑）、审计日志
- **App 在线更新**：管理面板上传 APK 发布版本，客户端检测更新，支持强制更新
- **QQ 绑定**：163 SMTP 邮箱验证 + QQ 机器人插件联动（QQ 号绑定、VIP 发放、封禁等）

## 目录结构

```
├── apps/
│   ├── server/            # Fastify 后端（TypeScript, node:sqlite）
│   │   ├── src/           # app.ts 路由与 WebSocket、config.ts、db.ts、migrate.ts、domain.ts、security.ts
│   │   ├── migrations/    # SQL 迁移（启动时按文件名顺序自动应用）
│   │   ├── public/        # 管理面板 GUI（index.html / app.js / styles.css）
│   │   ├── deploy/        # install.sh 安装脚本、systemd 单元、QQ 验证插件示例
│   │   ├── test/          # node:test 集成测试（45+ 用例）
│   │   └── dist/          # tsc 构建产物（生产运行的是这个目录）
│   └── client/            # React 客户端（Vite + Capacitor Android）
│       ├── src/           # App.tsx、api/client.ts（REST + WebSocket 封装）、加密、本地存储
│       ├── android/       # Capacitor 生成的 Android 工程（gradle 构建 APK）
│       ├── test/          # vitest 测试
│       └── dist/          # vite 构建产物（cap sync 复制进 APK）
├── docs/                  # 文档（API.md 在 apps/server/docs/API.md）
├── package.json           # npm workspaces 根（apps/*）
└── .env.example           # 根环境变量样例（仅供参考，实际配置见 apps/server/.env.example）
```

服务端管理面板在 `/admin/`（由 `apps/server/public` 提供），客户端构建产物 `apps/client/dist` 打进 Android APK，两者互相独立。

## 快速开始（本地开发）

要求：Node.js >= 24（服务端使用内置 `node:sqlite`）。

```sh
# 安装依赖（workspaces）
npm install

# 服务端开发（默认 127.0.0.1:3210）
cp apps/server/.env.example apps/server/.env
npm run dev:server

# 客户端开发（vite，默认 5173）
npm run dev
```

生成密钥：

```sh
openssl rand -base64 48          # 用作 JWT_SECRET（>=32 字符）
printf '%s' '你的root密钥' | sha256sum   # 用作 ADMIN_ROOT_KEY_HASH（只存哈希）
```

## 构建

| 产物 | 命令 | 说明 |
| --- | --- | --- |
| 服务端 `dist/` | `npm run build -w @lanmiao/server` | TypeScript 编译 |
| 客户端 web | `npm run build -w @lanmiao/client` | vite 产物到 `apps/client/dist` |
| Android APK | `cd apps/client && npm run build && npx cap sync android && cd android && ./gradlew assembleDebug` | APK 在 `android/app/build/outputs/apk/debug/` |

版本号由 `apps/client/version.json`（versionCode / versionName）驱动，Android 工程启动时读取。详见 [docs/BUILDING.md](docs/BUILDING.md)。

## 部署

生产环境建议 Linux（本项目已在 CentOS 验证），流程：

```sh
cd apps/server
npm ci && npm test && npm run build
sudo sh deploy/install.sh "$PWD"     # 创建 lanmiao 用户、安装到 /opt/lanmiao/app
sudoedit /opt/lanmiao/config/server.env   # 配置密钥与 SMTP
sudo systemctl enable --now lanmiao
```

- 服务绑定 `127.0.0.1:3210`，由反向代理（nginx 等）终止 TLS 并代理 `/api`、`/ws`、`/admin`、附件
- 数据库在 `/opt/lanmiao/data/lanmiao.sqlite`（WAL 模式），迁移在启动时自动应用，注意**迁移是单向的**
- systemd 单元限制内存 512 MiB、单核、只读应用树，仅 `/opt/lanmiao/data` 可写

详见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 测试

```sh
npm test                      # 全部（server + client）
npm run test -w @lanmiao/server   # 服务端 node:test
npm run test -w @lanmiao/client   # 客户端 vitest
```

## 安全模型

- 密码 salted scrypt 存储；JWT 7 天过期，每次请求校验当前封禁状态
- 服务端只接收密文信封，无解密密钥；离线信封 TTL 到期或送达确认后删除
- 附件由服务端临时中转（保留期限内可下载），超过保留期限自动清理
- Root 管理密钥只存 SHA-256 哈希；子密钥随机、分作用域、仅显示一次
- 所有管理操作与 VIP 操作写入审计日志

## 文档

- [构建指南 docs/BUILDING.md](docs/BUILDING.md)
- [部署指南 docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- [API 文档 apps/server/docs/API.md](apps/server/docs/API.md)
- [项目结构 docs/STRUCTURE.md](docs/STRUCTURE.md)

## 许可

保留所有权利。本项目当前未选择开源许可协议，仅供个人与团队内部使用。