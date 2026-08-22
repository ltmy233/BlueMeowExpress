# 项目结构说明

```
蓝喵速递/
├── apps/                                # npm workspaces
│   ├── server/                          # 服务端（Fastify + TypeScript + node:sqlite）
│   │   ├── src/
│   │   │   ├── index.ts                 # 入口：读配置 → 开库 → 启动监听
│   │   │   ├── config.ts                # 环境变量校验与加载（server.env）
│   │   │   ├── db.ts                    # SQLite 打开 + 迁移执行器（WAL、外键）
│   │   │   ├── migrate.ts               # 独立迁移脚本入口
│   │   │   ├── app.ts                   # 全部路由、WebSocket、业务逻辑（核心，约 1600 行）
│   │   │   ├── domain.ts                # 业务规则（群限额、VIP、平台治理、审计）
│   │   │   ├── security.ts              # 哈希、令牌、密钥工具
│   │   │   └── types.d.ts               # 类型声明
│   │   ├── migrations/                  # SQL 迁移（按文件名顺序自动应用）
│   │   │   ├── 001_initial.sql          # 用户/联系人/群/消息队列/VIP/管理密钥/审计
│   │   │   ├── 002_governance.sql       # 平台治理（晋升码、公告、声明、禁言、元数据）
│   │   │   ├── 003_interoperability_privacy.sql
│   │   │   ├── 003_user_uuid.sql        # 用户 UUID（不可变）
│   │   │   ├── 004_security_settings.sql
│   │   │   ├── 005_password_reset.sql
│   │   │   ├── 006_device_migration.sql
│   │   │   ├── 007_qq_verification.sql  # QQ 绑定
│   │   │   ├── 008_password_plain.sql   # 面板密码明文记录（仅 Root 可见）
│   │   │   ├── 009_app_releases.sql     # APK 发布
│   │   │   ├── 010_social_governance.sql
│   │   │   ├── 011_announcement_reads.sql
│   │   │   ├── 012_user_ip.sql
│   │   │   ├── 013_contact_remark.sql
│   │   │   ├── 014_contact_preferences.sql   # 置顶/拉黑
│   │   │   ├── 015_group_public_numbers_and_request_reasons.sql
│   │   │   ├── 015_media_attachments.sql
│   │   │   ├── 016_message_tombstones.sql
│   │   │   ├── 017_group_profiles.sql
│   │   │   ├── 018_timed_bans.sql
│   │   │   ├── 019_group_description.sql
│   │   │   ├── 020_message_signal_features.sql
│   │   │   ├── 021_status_updates.sql
│   │   │   └── 022_invite_tokens.sql
│   │   ├── public/                      # 管理面板 GUI（纯静态，/admin/ 由服务端托管）
│   │   │   ├── index.html
│   │   │   ├── app.js                   # 面板逻辑（直接改这里，无构建步骤）
│   │   │   └── styles.css
│   │   ├── deploy/
│   │   │   ├── install.sh               # 一键安装（lanmiao 用户 + systemd）
│   │   │   ├── lanmiao.service          # systemd 单元
│   │   │   └── lanmiao_qq_verify/       # QQ 机器人插件（AstrBot）
│   │   ├── test/                        # node:test 集成测试（app.inject 无真实端口）
│   │   └── docs/API.md                  # API 文档
│   └── client/                          # 客户端（React 19 + Vite + Capacitor 7）
│       ├── src/
│       │   ├── main.tsx                 # 入口
│       │   ├── App.tsx                  # 全部界面与状态（约 5200 行）
│       │   ├── styles.css               # 全部样式
│       │   ├── types.ts                 # 共享类型
│       │   ├── api/client.ts            # REST 客户端 + WebSocket（消息通道/心跳/重连）
│       │   ├── lib/                     # 加密（crypto.ts）、IndexedDB 存储、附件、校验、通话、偏好
│       │   └── test/                    # vitest 单元测试
│       ├── android/                     # Capacitor Android 工程（gradle）
│       ├── version.json                 # versionCode / versionName（驱动打包版本）
│       ├── capacitor.config.ts          # Capacitor 配置（appId com.lanmiao.express）
│       ├── vite.config.ts               # 构建配置
│       └── .env.production.example      # 构建期 API 地址模板
├── docs/                                # 本文档目录
│   ├── BUILDING.md                      # 构建指南
│   ├── DEPLOYMENT.md                    # 部署指南
│   └── STRUCTURE.md                     # 本文件
├── package.json                         # workspaces 根
└── .env.example                         # 根环境变量样例
```

## 职责划分

| 部分 | 职责 | 关键文件 |
| --- | --- | --- |
| 服务端 API | 认证、资料、联系人、群组、VIP、公告、管理 | `apps/server/src/app.ts` |
| 服务端 WebSocket | 消息信封路由/离线队列、信令、心跳、管理推送 | `apps/server/src/app.ts`（`/ws`） |
| 迁移 | 表结构与数据升级（启动自动执行） | `apps/server/migrations/` |
| 管理面板 | 管理台界面（静态文件，改完直接上传） | `apps/server/public/` |
| 客户端界面 | 手机端全部界面 | `apps/client/src/App.tsx` |
| 客户端通信 | REST 调用、WS 消息通道、重连心跳 | `apps/client/src/api/client.ts` |
| 客户端加密 | ECDH/AES 信封、身份密钥、IndexedDB 存储 | `apps/client/src/lib/` |

## 消息链路（核心流程）

1. 发送方在设备上生成临时 ECDH 密钥对，用**接收方公钥**加密消息内容（AES-256-GCM），得到密文信封
2. 客户端通过 WebSocket 发送 `{"type":"message","envelope":...}`
3. 服务端校验信封格式与好友关系，**不解密**：
   - 接收方在线：直接转发信封
   - 接收方离线：写入 `message_queue`（TTL 后过期删除）
4. 服务端回复 `accepted`（含是否在线投递）
5. 接收方收到后回复 `ack`，服务端删除队列中的信封

## 管理密钥体系

| 类型 | 前缀 | 用途 | 权限 |
| --- | --- | --- | --- |
| Root 密钥 | 无前缀 | 最高权限（环境变量哈希） | 一切 |
| 子密钥 | `LTMY-ADM-` | 面板登录 | 可选作用域（users:read / vip:issue / 等） |
| VIP 码 | `LTMY-VIP-` | 兑换 VIP | 仅兑换 |
| 晋升码 | `LTMY-MOD-` | 晋升平台管理员 | 仅兑换（Root 可撤销） |

## 测试策略

- 服务端：`node:test` + `app.inject()`（Fastify 内存注入），覆盖认证、治理、VIP、晋升码、发布等 47 例
- 客户端：vitest，覆盖校验、加密、附件、API 客户端 15 例
- 运行：仓库根 `npm test`