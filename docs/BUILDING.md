# 构建指南

## 环境要求

| 工具 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | >= 24 | 服务端依赖内置 `node:sqlite` |
| JDK | 17+ | Android 构建 |
| Android SDK | API 34+，含 build-tools | Android 构建 |
| Gradle | `gradlew` 自动下载，不用预装 | Android 构建 |

Windows 下 `npm` 用 `npm.cmd`，Gradle 用 `gradlew.bat`。

## 服务端

```sh
cd apps/server
npm ci
npm test            # 可选，跑集成测试
npm run build       # 编译到 dist/
```

## 客户端 Web

```sh
cd apps/client
npm ci
npm run build       # tsc 检查 + vite 构建
```

构建时读 `.env.production`（复制 `.env.production.example` 再改）：

```
VITE_API_URL=https://你的域名/api
VITE_WS_URL=wss://你的域名/ws
```

这两个值在构建时写死进 APK，改了要重新打包。

## Android APK

```sh
cd apps/client
npm run build
npx cap sync android      # 把 dist/ 同步到 Android 工程
cd android
./gradlew assembleDebug   # 调试包
```

正式包：

```sh
./gradlew assembleRelease
```

### 版本号

版本号在 `apps/client/version.json`：

```json
{
  "packageId": "com.lanmiao.express",
  "versionCode": 61,
  "versionName": "1.1.50"
}
```

- `versionCode`：整数，每次发版递增，Android 靠这个判断升级
- `versionName`：给用户看的版本号

改完重新 `npm run build && npx cap sync android`。

## 常见问题

- **APK 连不上服务器**：检查 `.env.production` 的地址对不对，改完重新打包
- **`cap sync` 报错**：确认 `android/local.properties` 的 `sdk.dir` 指对了 Android SDK
- **`node:sqlite` 报错**：Node 必须 >= 22.5，推荐 24
