# PaperLens iOS App（Capacitor 壳）

把 [app/](../app/) 的 PWA 原样包成原生 iOS App。**不修改扩展与 PWA 的任何文件**——
`www/` 由 `scripts/build-www.mjs` 从 `app/ + src/lib + src/vendor + icons/` 组装，
以后扩展侧的翻译引擎改进会自动带进 App。

## 没有 Mac 的构建方式（GitHub Actions）

仓库的 [ios-app workflow](../.github/workflows/ios-app.yml) 在 GitHub 的 macOS
runner 上构建**未签名 IPA**：

1. GitHub 仓库页 → Actions → **ios-app** → Run workflow
2. 等待约 10 分钟，下载 artifact `PaperLens-unsigned-ipa`
3. Windows 上用 [Sideloadly](https://sideloadly.io/)（或 AltStore）+ 你的 Apple ID
   把 IPA 装进 iPhone/iPad（免费 Apple ID 签名 7 天有效，到期重新侧载；
   有 $99/年开发者账号则一年有效，并可走 TestFlight）

## 有 Mac 时的本地构建

```bash
cd mobile
npm install
npm run build:www
npx cap add ios      # 首次
npx cap sync ios
npx cap open ios     # Xcode 里选真机 Run（个人免费签名即可）
```

## 说明

- **CORS**：App 内 fetch 仍走 WKWebView（保留流式翻译打字机效果），跨域行为与
  Safari PWA 相同——你已验证可用的服务商在 App 里同样可用。若换了被 CORS 拦的
  中转站，可在 `capacitor.config.json` 加 `"plugins": {"CapacitorHttp": {"enabled": true}}`
  绕过 CORS（代价：响应不再流式，整页译文一次性出现）。
- 配置、译文缓存存放在 App 自己的 WebView 存储里，与 Safari PWA 互不相通。
- `www/`、`ios/`、`node_modules/` 均为构建产物，不入库。
