# 项目结构说明

## 目录总览

```
蓝喵速递/
├── apps/
│   ├── server/              # 服务端
│   │   ├── src/
│   │   │   ├── index.ts     # 入口：配置 → 开库 → 启动
│   │   │   ├── config.ts    # 环境变量读取和校验
│   │   │   ├── db.ts        # SQLite + 迁移执行器
│   │   │   ├── app.ts       # 全部路由和 WebSocket（核心）
│   │   │   ├── domain.ts    # 业务规则：VIP、群组、管理员
│   │   │   ├── security.ts  # 哈希、令牌、加密工具
│   │   │   └── types.d.ts   # JWT 类型声明
│   │   ├── migrations/      # SQL 迁移文件，启动时按文件名排序执行
│   │   ├── public/          # 管理面板（纯静态，/admin/ 托管）
│   │   ├── deploy/          # 安装脚本、systemd、QQ 插件
│   │   ├── test/            # 集成测试（node:test + app.inject）
│   │   └── docs/API.md      # API 文档
│   └── client/              # 客户端
│       ├── src/
│       │   ├── App.tsx      # 全部界面和状态管理
│       │   ├── api/         # REST + WebSocket 封装
│       │   ├── lib/         # 加密、存储、通话、校验、偏好
│       │   ├── components/  # 动态样式、页面切换过渡
│       │   ├── config/      # 主题方案
│       │   └── context/     # 背景主题上下文
│       ├── android/         # Capacitor Android 工程
│       └── version.json     # 版本号（驱动打包）
├── docs/                    # 文档
└── package.json             # npm workspaces 根
```

## 各模块职责

| 模块 | 说明 | 核心文件 |
| --- | --- | --- |
| 认证 | 注册、登录、邮箱验证码、密码重置、设备迁移 | `app.ts` 的 `/api/auth/*` |
| 资料 | 个人信息、头像、公钥、VIP 状态 | `/api/profile` |
| 联系人 | 好友申请、接受/拒绝、拉黑、置顶 | `/api/contacts/*` |
| 群组 | 创建、入群、设置、角色、禁言、解散 | `/api/groups/*` |
| 消息 | 加密信封路由、离线队列、已读、回应、编辑、撤回 | WebSocket `/ws` |
| VIP | 兑换码生成/兑换、时长管理 | `domain.ts` + `/api/vip/*` |
| 管理面板 | 用户管理、封禁、VIP、公告、密钥、审计、APK 发布 | `/api/admin/*` |
| QQ 插件 | 群内绑定、管理命令 | `deploy/lanmiao_qq_verify/` |

## 消息流程

1. 发送方用接收方公钥加密消息（ECDH-P256 + AES-256-GCM）
2. 通过 WebSocket 发送密文信封
3. 服务端校验关系，不解密：
   - 在线：直接转发
   - 离线：写入 `message_queue`，TTL 到期或 ack 后删除
4. 接收方收到后发 ack，服务端删队列

## 管理密钥体系

| 类型 | 前缀 | 权限 |
| --- | --- | --- |
| Root 密钥 | 无 | 全部（环境变量存哈希） |
| 子密钥 | `LTSD-ADM-` | 按作用域（users:read / vip:issue 等） |
| VIP 码 | `LTSD-VIP-` | 仅兑换 |
| 晋升码 | `LTSD-MOD-` | 仅兑换（Root 可撤销） |

## 测试

- 服务端：`node:test`，覆盖认证、治理、VIP、发布
- 客户端：vitest，覆盖校验、加密、附件、API
