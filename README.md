# 📖 PaperLens — 论文双语对照阅读翻译（浏览器扩展）

[![test](https://github.com/Ys1-t/paperlens/actions/workflows/test.yml/badge.svg)](../../actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Chrome / Edge MV3](https://img.shields.io/badge/Chrome%20%2F%20Edge-MV3-brightgreen.svg)](#-安装开发者模式加载)

[English README → README.en.md](README.en.md)

在浏览器里并排阅读论文 PDF：**左侧原文（完整保留 PDF 排版）**，**右侧实时流式译文**，并支持**鼠标划词即时翻译**。灵感来自 [Moonlight](https://www.themoonlight.io/zh)，但完全本地运行、可自由接入你自己的大模型 API。

完整的当前功能、交互细节与实现说明见 [docs/FEATURES_SUMMARY.md](docs/FEATURES_SUMMARY.md)。

```
┌─────────────────┬──────────────────┐
│  原始 PDF        │  译文（中文）     │
│  (PDF.js 渲染，  │  # 标题           │
│   排版 100% 保留)│  段落正文…        │
│  [图 1]          │  [图1 说明]       │
│  ...             │  ...              │
└─────────────────┴──────────────────┘
        ↕  滚动联动  ↕
```

## ✨ 功能

- **双栏对照**：左边是原汁原味的 PDF（图、公式、排版一字不差），右边是按阅读顺序重排的结构化译文（标题、段落、两栏正文自动识别）。
- **实时流式翻译**：每页位图只发起一次视觉翻译请求，Markdown 译文像打字机一样逐步显示；当前页和相邻页优先。
- **结构化公式、表格、图片与伪代码**：公式由视觉模型转写为 LaTeX 并用 KaTeX 渲染；Algorithm 保留独立行号、嵌套缩进和行内公式；图片和表格主体不复制到译文栏，只保留图注 / 表注和“查看左侧原图 / 原表”的定位入口。
- **视觉质量自动精修**：本地检查残留英文、漏段、重复、拒答、损坏 LaTeX、算法缩进、图表定位及引用/方程编号/关键数值等 PDF 锚点；失败页绕过坏缓存，以低温和更高清页面自动重试。
- **科研助手（深读 Agent）**：内置多轮深读代理，可在本地检索 PDF 原文、译文和科研笔记；回答展示证据支持度、可展开的 E1/E2 真实片段、来源类型和可点击页码。15 个一键技能覆盖导读、TL;DR、方法、实验、批判、审稿、复现、相关工作、引用、组会、写作、思路、术语、符号和本页精讲；常用技能直接展示，按 Ctrl+K 可搜索全部技能。重要回答可收入笔记，并可导出带证据溯源的 Markdown / PDF。
- **划词翻译**：在左侧 PDF 上用鼠标选中任意文字，立即弹出翻译浮层。
- **术语锁定**：划词翻译后一键「锁定术语」（或在设置页手动维护术语表），锁定的译法强制注入之后的整页与划词翻译，保证全文乃至跨论文术语一致。
- **目录侧边栏**：按译文标题自动生成全文大纲，点击跳页、随翻译进度增补、滚动时高亮当前章节。
- **框选提问**：工具栏「框选」→ 在左侧 PDF 上拖选任意图 / 公式 / 段落，高清截图自动附进 AI 助手，直接追问「这张图说明了什么」。
- **键盘流阅读**：`J`/`K` 翻页、`O` 目录、`A` 助手、`S` 框选、Ctrl+K 搜索科研技能、`?` 快捷键帮助。
- **阅读续读 + 最近文库**：自动记住每篇论文读到第几页，重开时一键「继续上次阅读」；扩展弹窗里的「最近阅读」列表可直接重开最近的在线论文。
- **用量统计**：自动累计翻译/对话的估算 token 用量，设置页可按单价折算花费，控制 API 预算心里有数。
- **多服务商**：
  - DeepSeek 官方 API
  - OpenAI 官方
  - **各类「中转站 / 代理」**（OpenAI 兼容）——填 Base URL + 模型名即可用 GPT / Gemini / Claude
  - Gemini 官方（原生协议）
- **多组模型配置**：可保存多组 Base URL、API Key、协议和模型，在阅读器、弹窗和设置页一键切换。
- **本地缓存**：译文缓存在浏览器 IndexedDB，重复段落不再花钱重复请求。
- **PDF 来源**：浏览器正常打开或下载 PDF；仅在你主动点击扩展中的打开按钮、右键菜单时进入双语阅读器。也支持打开本地文件或粘贴链接。
- **滚动联动 + 双击定位**：两栏滚动同步；双击译文块会滚动并高亮左侧对应原文区域，普通单击不触发跳转。

## 🚀 安装（开发者模式加载）

1. **下载代码**（任选其一）：
   - 在 [Releases](https://github.com/Ys1-t/paperlens/releases) 下载最新的 `paperlens-<版本>.zip` 并解压；
   - 或点仓库首页绿色 **Code → Download ZIP**，解压；
   - 或 `git clone https://github.com/Ys1-t/paperlens.git`。
2. 打开 Chrome / Edge，地址栏输入 `chrome://extensions`（Edge 为 `edge://extensions`）。
3. 右上角打开「**开发者模式 / Developer mode**」。
4. 点击「**加载已解压的扩展程序 / Load unpacked**」，选择解压出的文件夹（含 `manifest.json` 的目录）。
5. 扩展出现在工具栏后，点击图标 → 右上角 ⚙ 进入**设置**。

> **v0.9.6 起无需任何本地服务**：翻译统一走整页视觉模型，装好扩展、填好 API Key 即可使用。（历史版本曾附带的本地版面分析服务已移除。）

## ⚙️ 配置模型

在设置页选择服务商预设，填入 **API Key**，点击「测试连接」确认可用，然后「保存设置」。

| 服务商 | Base URL | 模型示例 |
|---|---|---|
| DeepSeek（官方） | `https://api.deepseek.com` | `deepseek-chat` |
| OpenAI（官方） | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 中转站 / 代理 | 中转站给你的地址（通常以 `/v1` 结尾） | `gpt-4o-mini`、`gemini-2.5-flash`… |
| Gemini（官方） | `https://generativelanguage.googleapis.com/v1beta` | `gemini-2.5-flash` |

> 「中转站」协议选 **OpenAI 兼容** 即可，绝大多数中转站都遵循这一格式。

## 📄 使用

- **在线 PDF**：在 arXiv 或任意 `.pdf` 页面点击工具栏图标 → 「翻译当前页面的 PDF」。
  普通 PDF 链接不会被扩展自动接管，因此遇到需要登录或手动下载的链接时，仍可先使用浏览器原生页面完成下载。
- **本地 PDF**：点击图标 → 「打开本地 PDF」，在阅读器里选择文件（也可直接把 PDF 拖进阅读器）。
- **划词**：在左侧 PDF 选中文字，右下角弹出翻译。
- **原文对照**：工具栏勾选「原文对照」，译文下方会显示对应英文。

## 🧩 技术架构

```
manifest.json                 # MV3 清单
src/
  vendor/                     # PDF.js（本地打包，MV3 禁止远程脚本）
  lib/
    config.js                 # 配置 + 多服务商 Profile
    translator.js             # 统一翻译客户端（OpenAI 兼容 / Gemini，SSE 流式）
    page-ir.js                # Typed Page IR 校验与安全上限（历史结构化管线，当前不可达）
    structured-translation.js # Typed Page IR 文本节点计划和表格模型（同上）
    node-translation.js       # 稳定 ID NDJSON、流式回填和逐节点恢复（同上）
    structured-recovery.js    # 未翻译检测、逐段诊断与一次局部重试（同上）
    blocks.js                 # PDF 文本 -> 阅读顺序段落/标题（含两栏检测）
    cache.js                  # IndexedDB 译文缓存
  background/service-worker.js# 并发调度、流式端口、显式打开 PDF、右键菜单
  viewer/                     # 双语阅读器（渲染 + 面板 + 划词 + 联动 + AI 助手）
  options/                    # 设置页
  popup/                      # 工具栏弹窗
```

**当前版本**：扩展 `1.2.6`，翻译管线 `vision-page-v12`，构建标识 `2026.07.30-gen16-v1.2.6`。

1.2 在 1.1 的证据优先基础上加入可展开证据卡、跨轮证据记忆、支持度、证据化导出和 Ctrl+K 技能面板；视觉翻译加入 Algorithm / Figure / Table 结构门、PDF 不可变锚点和提示注入隔离。1.2.1 保证质量检查不清空译文；1.2.2 修复摘要编号误判；1.2.3 排除参考文献英文误报；1.2.4 取消普通质量告警的自动精修并隔离参考文献；1.2.5 恢复算法中文结构词与行内 KaTeX；1.2.6 修复标签页长时间后台后翻译连接失效、无法自动恢复的问题。新增 20 项见 [`docs/AI_ASSISTANT_V3_20_ITERATIONS.md`](docs/AI_ASSISTANT_V3_20_ITERATIONS.md)，上一阶段 40 项见 [`docs/AI_ASSISTANT_V2_40_ITERATIONS.md`](docs/AI_ASSISTANT_V2_40_ITERATIONS.md)。

**翻译数据流（v0.9.6 起视觉唯一主路径）**：每页由 PDF.js 渲染为位图 → 整页发给视觉模型，流式返回带 LaTeX、Algorithm 和媒体定位 token 的 Markdown → 右栏立即用 KaTeX 和阅读排版显示 → 完成后由本地质量门核对结构与 PDF 原生文本锚点。检查失败只会触发后台精修，当前译文始终保持可读；新结果通过后才原子替换。普通页保持 1500px / 4096 输出预算；只有密集页或质量失败页提高预算。图片与表格主体始终留在左侧 PDF。无需上传整份 PDF 到自建服务器，也无需本地服务。

## ⚠️ 已知限制 / 后续可优化

- **译文版式取决于视觉模型**：右栏是 Markdown 结构化重排，不是像素级复刻 PDF 版式；公式/表格质量随所选视觉模型能力变化。
- 需要选用**支持图片输入的视觉模型**（如 gemini-2.5-flash、gpt-4o-mini 等）；纯文本模型无法翻译。
- 大体积 PDF（上百页）整本翻译耗时与费用随页数线性增长；懒加载只翻译滚动到的页面可缓解。
- 目前仅适配 Chrome / Edge（MV3）。

## 🧪 开发

```bash
npm test      # Node 内置测试器，零依赖
npm run pack  # 打包 dist/paperlens-<版本>.zip
```

纯 ES Module，无构建步骤。版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 🔒 隐私

- API Key 仅保存在浏览器本地 `chrome.storage.local`，只发送给你配置的接口地址。
- 除了你选择的模型服务，扩展不向任何第三方发送数据。

## 📜 许可证

[MIT](LICENSE)。内置第三方库遵循各自许可证：[PDF.js](https://github.com/mozilla/pdf.js)（Apache-2.0）、[KaTeX](https://katex.org/)（MIT）、[marked](https://github.com/markedjs/marked)（MIT）。
