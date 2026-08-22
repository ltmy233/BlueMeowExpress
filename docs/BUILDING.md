# 构建指南

## 环境要求

| 工具 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | >= 24（服务端依赖内置 `node:sqlite`） | 全部构建 |
| JDK | 17+ | Android 构建 |
| Android SDK | API 34+，含 build-tools、platform-tools | Android 构建 |
| Gradle | 由 `gradlew` 自动下载，无需预装 | Android 构建 |

Windows 下 `npm` 请使用 `npm.cmd`，Gradle 使用 `gradlew.bat`。

## 服务端构建

```sh
cd apps/server
npm ci              # 或 npm install
npm test            # 可选，跑 47 个集成测试
npm run build       # tsc 编译到 dist/
```

产物：`apps/server/dist/`（含 `index.js`、`app.js`、`migrations/` 的引用路径按相对位置解析）。

## 客户端构建（Web）

```sh
cd apps/client
npm ci
npm run build       # tsc 检查 + vite 构建
```

产物：`apps/client/dist/`。构建时读取 `apps/client/.env.production`（示例见 `.env.production.example`）：

```
VITE_API_URL=https://your-domain.example/api
VITE_WS_URL=wss://your-domain.example/ws
```

这两个值在构建期注入，决定 APK 连接的服务器地址。

## Android APK 构建

```sh
cd apps/client
npm run build
npx cap sync android      # 把 dist/ 复制进 android 工程并同步插件
cd android
./gradlew assembleDebug   # 调试签名 APK（Windows: gradlew.bat）
```

产物：`apps/client/android/app/build/outputs/apk/debug/app-debug.apk`

发布正式包请配置签名并使用 `assembleRelease`：

```sh
./gradlew assembleRelease
```

产物：`apps/client/android/app/build/outputs/apk/release/app-release.apk`

### 版本号

版本号由 `apps/client/version.json` 驱动（Android 工程构建时读取）：

```json
{
  "packageId": "com.lanmiao.express",
  "versionCode": 31,
  "versionName": "1.1.20"
}
```

- `versionCode`：整数，每次发布递增，Android 系统据此判断升级
- `versionName`：展示给用户的版本号

修改后重新执行 `npm run build && npx cap sync android` 再打包。

## 常见问题

- **APK 连不上服务器**：检查 `.env.production` 的 `VITE_API_URL` / `VITE_WS_URL` 是否指向正确域名，重新构建
- **`cap sync` 报错**：确认 `apps/client/android/local.properties` 的 `sdk.dir` 指向 Android SDK
- **`node:sqlite` 报错**：Node 必须 >= 22.5（推荐 24），Node 24 内置 sqlite 无需编译