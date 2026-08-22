# 项目结构说明喵~

## 目录总览喵

```
蓝喵速递/
├── apps/
│   ├── server/              # 服务端喵
│   │   ├── src/
│   │   │   ├── index.ts     # 入口：配置 → 开库 → 启动喵
│   │   │   ├── config.ts    # 环境变量读取和校验喵
│   │   │   ├── db.ts        # SQLite + 迁移执行器喵
│   │   │   ├── app.ts       # 全部路由和 WebSocket（核心）喵
│   │   │   ├── domain.ts    # 业务规则：VIP、群组、管理员喵
│   │   │   ├── security.ts  # 哈希、令牌、加密工具喵
│   │   │   └── types.d.ts   # JWT 类型声明喵
│   │   ├── migrations/      # SQL 迁移文件，启动时按文件名排序执行喵
│   │   ├── public/          # 管理面板（纯静态，/admin/ 托管）喵
│   │   ├── deploy/          # 安装脚本、systemd、QQ 插件喵
│   │   ├── test/            # 集成测试（node:test + app.inject）喵
│   │   └── docs/API.md      # API 文档喵
│   └── client/              # 客户端喵
│       ├── src/
│       │   ├── App.tsx      # 全部界面喵
│       │   ├── api/         # REST + WebSocket 封装喵
│       │   ├── lib/         # 加密、存储、通话、校验、偏好喵
│       │   ├── components/  # 动态样式、页面切换过渡喵
│       │   ├── config/      # 主题方案喵
│       │   └── context/     # 背景主题上下文喵
│       ├── android/         # Capacitor Android 工程喵
│       └── version.json     # 版本号（驱动打包）喵
├── docs/                    # 文档喵
└── package.json             # npm workspaces 根喵
```

## 各模块职责喵

| 模块 | 说明喵 | 核心文件喵 |
| --- | --- | --- |
| 认证 | 注册、登录、邮箱验证码、密码重置、设备迁移喵 | `app.ts` 的 `/api/auth/*` 喵 |
| 资料 | 个人信息、头像、公钥、VIP 状态喵 | `/api/profile` 喵 |
| 联系人 | 好友申请、接受/拒绝、拉黑、置顶喵 | `/api/contacts/*` 喵 |
| 群组 | 创建、入群、设置、角色、禁言、解散喵 | `/api/groups/*` 喵 |
| 消息 | 加密信封路由、离线队列、已读、回应、编辑、撤回喵 | WebSocket `/ws` 喵 |
| VIP | 兑换码生成/兑换、时长管理喵 | `domain.ts` + `/api/vip/*` 喵 |
| 管理面板 | 用户管理、封禁、VIP、公告、密钥、审计、APK 发布喵 | `/api/admin/*` 喵 |
| QQ 插件 | 群内绑定、管理命令喵 | `deploy/lanmiao_qq_verify/` 喵 |

## 消息流程喵

1. 发送方用接收方公钥加密消息（ECDH-P256 + AES-256-GCM）喵
2. 通过 WebSocket 发送密文信封喵
3. 服务端校验关系，不解密喵：
   - 在线：直接转发喵
   - 离线：写入 `message_queue`，TTL 到期或 ack 后删除喵
4. 接收方收到后发 ack，服务端删队列喵

## 管理密钥体系喵

| 类型 | 前缀 | 权限喵 |
| --- | --- | --- |
| Root 密钥 | 无 | 全部（环境变量存哈希）喵 |
| 子密钥 | `LTSD-ADM-` | 按作用域（users:read / vip:issue 等）喵 |
| VIP 码 | `LTSD-VIP-` | 仅兑换喵 |
| 晋升码 | `LTSD-MOD-` | 仅兑换（Root 可撤销）喵 |

## 测试喵

- 服务端：`node:test`，覆盖认证、治理、VIP、发布喵
- 客户端：vitest，覆盖校验、加密、附件、API喵
