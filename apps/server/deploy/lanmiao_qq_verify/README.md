# 蓝喵速递 QQ 插件

AstrBot 插件，用于 QQ 群内的账号绑定和管理操作。

## 安装

把整个 `lanmiao_qq_verify` 目录放到 AstrBot 的插件目录下，重启 AstrBot 即可加载。

## 配置项

| 字段 | 说明 | 默认值 |
| --- | --- | --- |
| `service_url` | 服务端公网地址，格式 `https://你的域名或IP:HTTPS端口` | `https://your-server.example:443` |
| `plugin_token` | 与服务端 `QQ_BOT_PLUGIN_TOKEN` 保持一致的插件令牌 | 空（不工作） |
| `whitelist_groups` | 允许使用命令的 QQ 群号列表，空列表 = 全部禁止 | `[]` |
| `admin_qq_ids` | 允许使用管理命令的管理员 QQ 号列表 | `[]` |
| `bot_id` | 心跳上报的 Bot 标识 | `astrbot-main` |
| `heartbeat_seconds` | 心跳间隔（秒） | `30` |

## 命令

验证命令（需要群和发送者都在白名单内）：

```
/login <7位验证码>
```

管理员命令（需要群和 QQ 号都在白名单内）：

```
/st                                    服务器状态
/find <关键词>                         查询玩家（邮箱/VIP/QQ）
/ban <关键词>                          封禁玩家
/unban <关键词>                        解禁玩家
/vip <玩家> <时长>                     发放 VIP（如：永久、7天、1月、1年）
/unvip <关键词>                        撤销 VIP
```

## 注意事项

- 群白名单为空时所有命令不可用，必须先配置群号
- 管理员 QQ 号必须在 `admin_qq_ids` 里才能执行管理命令
- 心跳超 90 秒未上报，服务端会认为 Bot 离线，管理命令会被拒绝
