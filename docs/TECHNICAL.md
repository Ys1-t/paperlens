# PaperLens 技术设计与故障诊断文档

> 本文件是各功能模块（含各子 agent）的**协作契约**。修改任何模块前先读本文件；
> **端口协议一节是冻结契约**，任何模块不得擅自更改字段名/语义。
>
> ⚠ **纪律**：修 bug 前，先用「无头 Edge 截图工作台」(见 §11) 复现事实、写进本文件，再动手。
> 严禁凭截图猜测就改代码。每次修完必须用工作台截图验证，并把结果记回 §12。

> **术语速查**：文中「**D4L**」指 20 页回归基准论文（arXiv 2010.04104）；`2203.15386.pdf` 指
> arXiv 2203.15386（31 页，同主题另一版本）。两份 PDF 受版权保护、不随仓库分发，
> 相关回归测试在 fixture 缺失时自动跳过。

## 0. 当前架构（2026-07-30，v1.2.6 视觉唯一主路径）

> **⚠️ v0.9.6 重大变更**：本地版面分析服务（`server/`）及其扩展内所有接入点
> （`src/lib/layout.js`、viewer 的 bootstrapLayout/analyzeSessionPage/recreateLayoutSession、
> config 的 useLayoutService/layoutServiceUrl、options 的本地版面卡片）已**全部移除**。
> 唯一翻译路径：`runScheduledPage` → `translatePageVision`——每页 canvas 转 JPEG 发视觉模型，
> 流式返回 Markdown（LaTeX、Algorithm、`@@FIGURE@@` / `@@TABLE@@`），`renderMarkdown` 渲染 +
> `fillFigureSlots` 在默认阅读模式替换为左栏定位入口 + 编号公式行尾对齐 + KaTeX。
> 结构化管线库（page-ir.js、structured-translation.js、node-translation.js、structured-recovery.js
> 及 viewer 的 translatePageLayout/translatePageStructured/mountStructuredPage）暂留为**不可达死代码**
> （唯一数据源已移除），单测仍通过，日后可整体摘除；新功能请勿依赖。
> **§0.1/§0.2 以下内容为历史记录，仅供追溯。**
> 当前版本：manifest 1.2.6，build ID `2026.07.30-gen16-v1.2.6`，翻译管线 `vision-page-v12`。
> Gen10 生产路径：整页图像仍是版面权威；PDF.js 原生文本作为覆盖与不可变锚点提示随同一次视觉请求发送，不单独调用模型。本地质量门增加拒答、围栏、LaTeX 花括号、Algorithm 行号/缩进、Figure/Table token、引用/方程编号/数值/数据集检查。普通页保持 1500px / 4096；密集页自适应提高；仅质量失败页用 2050px、temperature 0 绕过坏缓存复核。`paper-retrieval.js` 在浏览器本地为科研助手建立 BM25 证据索引，回答后做引用页审计、证据支持度和可展开证据片段。旧 Page IR / 节点协议代码只作为不可达历史兼容层保留，不代表当前主路径。
> Gen11 显示契约：质量门只决定是否精修，不决定是否展示。任何非空译文先作为可读底稿渲染；高精度请求在后台缓冲，只有通过检查后才替换 DOM。超时、再次拒绝或用尽重试次数时继续保留底稿，并显示可核对的非阻断警告。
> Gen12 锚点契约：PDF.js 原生文本已压平，裸 `(N)` 具有歧义；只有临近 Eq./Equation/方程/公式、明显数学运算上下文或 LaTeX `\\tag{N}` 才作为方程编号。摘要贡献列表和普通编号不触发整页精修；提示必须列出具体疑似缺失项。
> 1.0.0 新手引导：openPdf 末尾 `maybeShowOnboarding()`（localStorage 键 `paperlens.onboarding.v1`，
> 「知道了」后永不再弹）；popup 增加 `demo-link` 一键打开 arXiv 1706.03762 示例论文。
> 0.9.15 开源就绪：MIT LICENSE、README.en.md（互链 + badges）、CHANGELOG.md、
> `.github/workflows/test.yml`（push/PR 跑 `npm test`）、`npm run pack`（scripts/pack.mjs 只打包
> manifest+src+icons+LICENSE+README 到 dist/）；.gitignore 增补 dist/、node_modules/。
> 0.9.14 新增阅读快捷键：setupPageJumpControls 的全局 keydown 扩展为 J/K 翻页、O 目录、
> A 助手、S 框选、Esc 关目录（输入框聚焦或含修饰键时不生效）；帮助浮层（?）同步列出。
> 0.9.13 新增框选提问：viewer 工具栏「框选」→ `startSnipMode` 在 PDF 栏上铺 `.snip-overlay`
> （crosshair 拖矩形，Esc/再点取消）→ `snipToChat` 找相交面积最大的页，按归一化坐标用
> `pageObj.getViewport` 高清重渲（≤1600px 宽）后裁剪 PNG → `chatPanel.setOpen(true)` + `setPageImage`。
> 0.9.12 新增目录侧边栏：viewer 工具栏「目录」按钮（文档打开后显示）→ `toggleOutlinePanel` 构建
> 浮动 `.outline-panel`，数据复用深读工具 `paperTools.getOutline()`（译文 1–3 级标题，cap 120）；
> `updateProgress` 时随译文增补，`updatePageJumpInput` 时 `updateOutlineActive` 轻量高亮当前章节，点击条目 `goToPage`。
> 0.9.11 新增用量统计：`src/lib/usage-stats.js`（chrome.storage.local 键 `paperlens.usageStats.v1`）；
> SW 在 translate/chat 完成后 `addUsageSample(estimateRequestTokens(...))`（字符启发式 + 图片固定开销，
> 不读 SSE usage 字段以兼容中转站）；设置页展示累计/今日并按 ¥/百万 tok 单价折算。
> 0.9.10 新增阅读续读：`src/lib/reading-history.js`（localStorage 键 `paperlens.readingHistory.v1`，
> viewer/popup 同源共享）；viewer 在 `updatePageJumpInput` 节流记录页码，openPdf 结束时弹「继续上次阅读」横幅；
> popup 渲染「最近阅读」（http(s) 来源可一键重开，本地文件转文件选择）。
> 0.9.9 新增全局术语锁定：`src/lib/glossary.js`（chrome.storage.local，键 `paperlens.glossary.v1`）；
> SW 在 translate 请求时挂 `cfg.glossary`（整页视觉=全表，文本/划词=按命中过滤），
> translator.selectSystemPrompt 经 `appendGlossaryPrompt` 注入；缓存键**不含**术语表（改术语后需重译才生效）。

### 0.1 【历史】v0.8.22 主路径：混合版面检测 + Typed Page IR + 整页有序阅读单元

1. viewer 先探测 `/health` capabilities；同时具备 `document-session-v1` 和 `page-ir-v1` 时，PDF 只上传一次到 `POST /documents`。
2. 当前可见页、相邻页和后续两页按优先级调用 `POST /documents/{id}/pages/{index}/analyze`；服务端按页缓存，关闭或换文档时 `DELETE /documents/{id}`。
3. `server/page_ir.py` 生成稳定 Typed Page IR：paragraph segments、inline_math、display_math、table、figure、caption 和结构化 Algorithm。`page-ir-v1.18` 在基础 PyMuPDF 模式加入 caption 锚定的严格 booktabs 表恢复，并以文本基线而非高字形 bbox 划分编号公式行带；可选 PyMuPDF Layout 仍只在用户显式启用后参与复杂页区域融合。
4. `reading-node-v10` 按阅读顺序接收带稳定 ID 的有界 `{id,text}` NDJSON。行内公式以 `[[PLM:id]]` 不可变占位符提供上下文，响应校验数量/身份/顺序后再映射回本地公式 DOM 两侧；中文紧邻 inline KaTeX 时由 DOM 层确定性增加边界间距。节点 prompt 内置学术语体、批内术语一致、首现括注与明确不译清单；用户自定义 systemPrompt 以追加方式作用于节点协议；公式 slot 局部重译经可选 `nodeSlotRetry` 字段选用专用 prompt（见 §6）。
5. table 只有在 detector 为 `pymupdf-layout` 或 `pymupdf-ruled-text`、置信度至少 0.90 且总量不超过 512 个单元格时，才重建为语义化 HTML table。后者还必须同时满足 TABLE caption、至少三条一致水平规则和严格数值科研表结构。最多 96 个自然语言表头/行标签进入翻译，其他表格保留原表回退。
6. 普通 figure 不复制图像 crop 到译文栏，只呈现译文 caption 与“原图见左栏 · 双击定位”；左侧 PDF 始终是图片的视觉真相。不可信行内公式和 row-band 显示公式仍先显示原 PDF crop，再一起拼成带稳定 ID 的页级 sprite。OCR 结果除 KaTeX 解析外还校验范数、连续上下标、`\\sim`、平方/范数阶后缀和配对结构；失败公式才单图复核，仍失败则保留原公式裁图。
7. 没有可用文字块的扫描页或图片页设置 `needs_ocr: true`，viewer 自动切换整页视觉 OCR；不会再以空 Typed Page IR 结束翻译。响应同时提供 `layout_backend` 与可选 warning，学习型后端不可用或推理失败时安全回退启发式路径。
8. 原文与译文的对应跳转统一由双击触发。译文侧按具体 `data-ir-id` 高亮一个或多个 fragment；原文侧优先命中包含双击点的最小 fragment，有限距离内才允许最近节点，随后用二维块 bbox 回退。事件坐标绑定本次页面，不复用旧 Selection；90/180/270 度页面在 Page IR 与 PDF.js viewport 间显式换算；程序化滚动期间暂停双栏同步。
9. 会话默认 TTL 30 分钟，带页缓存、LRU 式容量约束和上传大小限制；旧 `/analyze` 继续作为兼容回退。

关键实现：
- `server/page_ir.py`：融合启发式与可选学习型区域，输出 `layout_backend`、`needs_ocr` 和 warning；Algorithm 框是结构化文本硬保护区。
- `server/layout_detector.py`：可选 PyMuPDF Layout CPU 适配器、自适应复杂页 gate、区域类别归一化与表格 CellInfo 网格转换。
- `server/session_store.py`：线程安全文档会话、TTL、页缓存与内存上限。
- `src/lib/page-ir.js`：IR 安全上限、重复 ID 与未知块降级。
- `src/lib/reading-link.js`：逐行 fragment 命中、距离上限，以及 Page IR/PDF.js 旋转坐标换算。
- `src/lib/structured-translation.js`：整页有序阅读单元、公式占位符、本地文字 span 映射，以及学习型表格的置信度/规模/可翻译单元门控。
- `src/lib/node-translation.js`：稳定 ID NDJSON、流式段落解析、公式占位符/未翻译质量校验、局部重试和缓存校验。
- `src/lib/inactivity-guard.js`：无活动超时守卫（首字节前 90s 窗口、输出后 45s 空闲窗口、排队 hold 停表 + 450s 兜底），viewer 三条翻译路径共用。
- `src/lib/formula-quality.js`：公式 OCR 规范化与语义结构质量门。
- `src/viewer/viewer.js`：Typed DOM 一次挂载、文本节点局部更新、typed 公式 OCR，以及双击触发的节点级 bbox 定位。

可选学习型检测器不会随基础依赖安装。PyMuPDF Layout 使用 **PolyForm Noncommercial / Artifex 商业双许可证**；必须由用户确认用途符合许可证并显式运行 `.\server\install-layout-ai.ps1 -AcceptLicense`。脚本安装 `requirements-layout-ai.txt`、创建 `.layout-ai-enabled`，启动脚本随后设置自适应后端。仅仅在环境中可导入该包不会自动启用它。

当前完整验证基线（v0.8.22 / `page-ir-v1.18` / `reading-node-v10`，服务端保持 0.8.19）：Node 357/357；服务端未改动（便携 Python 46/46、fallback venv 46/46 基线沿用 v0.8.19）。

真实 D4L 回归（arXiv 2010.04104）：第 4 页约 0.17–0.27 秒，Algorithm 1 保留为一个块并恢复约 48–50 个行内数学段；第 8 页约 1.5–2.4 秒，准确拆为 3 张表，列数 7、8、6。第二次请求命中页缓存。

### 0.2 【历史】Legacy `/analyze` 兼容路径

以下路径仅在服务不声明会话能力时使用（v0.9.6 起服务已移除，本节仅作历史记录）：

1. viewer 打开 PDF → 保留原始字节 → 若开启「本地版面分析」，把整份 PDF POST 给本地服务 `POST /analyze`。
2. 本地服务（`server/app.py`，PyMuPDF）逐页提取**块**：`text` / `image` / `formula`，每块带归一化 bbox。
   - `image`（位图/矢量图）→ 左侧 PDF 保持原样，右侧阅读模式只显示“查看左侧原图”。
   - `formula`（显示公式）→ 裁剪图只作为专用公式 OCR 输入和识别失败回退；识别成功后右栏用 KaTeX 显示 LaTeX。
   - `text` → 纯文字，交给大模型翻译。
3. viewer `translatePageLayout`：把该页所有 `text` 块用 `@@@BLK@@@` 分隔**一次性**发给大模型；
   普通图片按阅读顺序插入左侧引用；公式走独立、全局单并发的 OCR 请求，不阻塞正文完成条件。
4. 译文按分隔符切回每块，与源块 bbox 一一对应 → 支持段落级双向定位高亮。

关键文件：
- `server/app.py`：`/analyze` 返回 `{ok, meta, pages:[{index, markdown, images, blocks}]}`。
  - `blocks[i] = {kind:'text'|'image'|'formula', bbox:[x0,y0,x1,y1](归一化), md, text?, name?}`
  - 后处理管线顺序（**重要，改动需同步此处**）：
    1. `_merge_equation_rows`：同一行被撕开的公式片段合并成一块。
    2. `_merge_adjacent_formulas`：竖直相邻的公式碎片合并成一块。
    3. `_detect_vector_figures`：`get_drawings()` 检测矢量框架图并栅格化。
    4. `_drop_text_inside_figures`：删除落在图/公式框内的零碎文本（图内标签等）。
- `src/viewer/viewer.js`：`renderLayoutBlocks` 按 `blocks` 重建整页；所有流式重绘都从 `p.formulaStates` 派生公式；
  `renderGeneration` 隔离重试旧结果，`src/lib/inactivity-guard.js` 的 `makeInactivityGuard` 负责无活动超时。
- `src/lib/reading-mode.js`：公式 JSON/LaTeX 解析与阅读媒体呈现决策。
- `src/lib/request-handlers.js`：前后端取消状态、页面 generation 生命周期、最终渲染 RAF 门控。
- `src/lib/translation-cache.js`：缓存身份包含 Base URL；空响应不允许写入缓存。

## 1. 目标（当前）

Chrome/Edge (MV3) 扩展：打开论文 PDF → 左侧原样渲染 PDF、右侧**按页懒加载、实时流式**翻译；
支持划词翻译；支持 DeepSeek 官方 / OpenAI / Gemini / OpenAI 兼容中转站。
额外：公式在译文中恢复为 LaTeX / KaTeX；图像和表格主体留在左侧 PDF；当前视觉主路径双击定位到同页，
历史 Typed Page IR 的节点级 bbox 定位不是生产能力。科研助手回答必须能回到真实证据页核对。

## 2. 【历史】最初故障现象

用户导入论文后，译文块显示 loading（闪烁光标），但**长时间无任何输出、也无报错**。

## 3. 【历史】关键判断：为什么"毫无反应"

后台 `handleTranslate` 在以下情况都会**主动回传 error**：读配置失败、无 API Key、fetch 失败/非 2xx、解析异常。
既然用户**连 error 都看不到**，只可能是下面几类，需要用诊断把它们区分开：

| 编号 | 可能原因 | 现象特征 | 诊断手段 |
|---|---|---|---|
| C1 | Service Worker 模块加载失败（import/顶层异常），`onConnect` 未注册 | 端口能连上但永远无任何回包 | **ping/pong 健康检查**：viewer 连上后发 ping，3s 无 pong → 判定 SW 未响应 |
| C2 | 请求真的挂起（网络/流不结束），且**无超时** | loading 永久，无 error | **每请求 90s 超时** → 超时转成可见 error |
| C3 | 模型是**推理模型**（如 deepseek-v4-flash），先输出 `reasoning_content`（思考），`delta.content` 迟迟不来 | loading 很久后才出字，或看似卡死 | 解析 `reasoning_content` → 回传 `status: thinking`，块显示"思考中…" |
| C4 | Key/Base URL/模型名错误 | 应有 error（401/404） | **options 原始自检**：从 options 页直连 API，打印原始状态码与响应体 |
| C5 | 端口断开（SW 休眠）丢消息 | viewer 应收到 disconnect | disconnect 时 reject 待处理请求并在 HUD 标红 |

**结论**：核心不是"再改逻辑"，而是**加可见诊断**，把 C1–C5 变成用户一眼可见、可复制给我的信息。

## 4. 架构与文件职责

```
manifest.json                MV3 清单（权限、host_permissions、WAR）
src/vendor/pdf*.js           PDF.js v3.11.174（本地打包）
src/lib/
  config.js                  配置 + 服务商预设（DEFAULT_CONFIG / PROVIDER_PRESETS）
  translator.js              统一翻译客户端：OpenAI 兼容 / Gemini，SSE 流式
  cache.js                   IndexedDB 译文缓存
  blocks.js                  PDF 文本 → 阅读顺序段落/标题（两栏检测）
src/background/service-worker.js  并发调度、流式端口、缓存、显式 PDF 打开与旧拦截规则清理
src/viewer/                  双语阅读器（渲染 + 面板 + 划词 + 联动 + Debug HUD）
src/options/                 设置页（含"原始自检"）
src/popup/                   工具栏弹窗
```

## 5. 当前数据流

1. viewer 将 PDF 字节交给 PDF.js，建立左侧原版页面和右侧同页译文占位；IntersectionObserver 只调度可见页及邻页。
2. `translatePageVision` 先读取同页原生文本作为覆盖与不可变锚点提示，再按页面密度把 canvas 渲染为 1500–1780px JPEG；质量复核固定为 2050px。
3. `client.translateImage` 经版本化长连接 Port 发给 SW；SW 查管线版本缓存、并发调用当前 Profile 的视觉模型，并把 SSE 分片流回 viewer。
4. viewer 增量渲染 Markdown；完成后运行结构质量门。合格输出经 KaTeX、Algorithm 恢复和图表引用处理落地；不合格页面携带具体原因、temperature 0、`bypassCache` 自动重试。
5. 科研助手在浏览器内检索 PDF 原文/译文/笔记，Agent 工具结果形成有限证据片段；回答、历史、笔记和导出共享同一份证据溯源数据。

## 6. 端口协议（**冻结契约**）

长连接名：`translate:<PAPERLENS_BUILD_ID>`，由 `src/lib/build-info.js` 同时提供给 viewer 与 SW。旧 viewer / 新 SW 或新 viewer / 旧 SW 会断开，不能再静默混跑。

**viewer → SW**
- `{type:'ping', id}`
- `{type:'translate', id, text, priority?}`  // priority=true：立即执行，不排队（划词）。v0.8.22 起 viewer 划词浮层实际使用该既有字段（此前已定义未使用）；行为澄清：SW 对 priority=true 的请求不读也不写共享译文缓存（划词载荷含局部上下文、复用率低，避免污染正文缓存空间）。字段名/语义未变。
- `{type:'translate', id, text, nodeProtocol:true, queuePriority?, bypassCache?}`  // Typed Page IR `{id,text}` NDJSON
- `{type:'translate', id, text, nodeProtocol:true, nodeSlotRetry:true, queuePriority?, bypassCache?}`  // v0.8.20 新增**可选**布尔字段 `nodeSlotRetry`：仅公式 slot 局部重译请求携带；SW 只据此改选专用 slot 重译 system prompt（相邻 prose 片段与两侧公式衔接），载荷、缓存与收尾语义与上一行完全相同，已有字段名/语义不变
- `{type:'translate', id, image, formula:true, priority:false}`  // 单个显示公式裁剪图转写为 `{latex,number}`
- `{type:'chat', id, messages}`  // v0.8.23 新增**独立消息类型**（AI 助手聊天面板）：`messages` 是 `[{role:'system'|'user'|'assistant', content}]` 多轮数组，复用当前 Profile 的 baseUrl/apiKey/model 走 chat/completions（或 Gemini generateContent）。与 `translate` 字段语义完全独立、互不影响。SW 端立即执行、不排队，**不经 cacheGet/cacheSet**（聊天历史仅存内存，不进译文缓存）；流式回传与取消/超时语义同 translate。
- `{type:'cancel', id}`  // 同样可取消 chat 请求

**SW → viewer**
- `{type:'pong', id, ts, buildId}`
- `{type:'status', id, phase}`   // phase ∈ 'queued' | 'connecting' | 'thinking' | 'streaming'
- `{type:'chunk', id, delta}`    // delta 为**译文**增量（不含思考内容）
- `{type:'done', id, full, cached?}`
- `{type:'error', id, message}`
- `{type:'cancelled', id}`

规则：
- 每个 `translate` 最终**必然**以 `done` / `error` / `cancelled` 之一收尾（不允许静默）。
- 公式请求使用 `FORMULA:v6:` / `FORMULA_BATCH:v6:` 独立缓存命名空间；空/纯空白或质量门拒绝的响应不缓存。
- 请求在读取配置、查缓存、排队和网络执行阶段都可取消；排队取消后不得再发起网络请求。
- Typed 节点翻译使用 `page-node-ndjson-v2:`，完整缓存身份还含 `TRANSLATION_PIPELINE_VERSION`；缺失 ID、空译文、连续残留英文或公式占位符损坏均不写入缓存。
- 普通后台翻译最长排队 240s（`NORMAL_QUEUE_TIMEOUT_MS` = 请求硬超时 180s + 60s 缓冲；v0.8.21 前为 60s，会在并发槽位被慢请求合法占满时误杀第 5 个请求）；排队超时错误文案为「排队等待超时…」，必须与模型响应超时（「请求超时/模型响应较慢」）可区分。`queuePriority` 越大越先执行，局部恢复高于预取页。
- `reasoning_content`（OpenAI 兼容）或 Gemini 的 thinking 部分**不得**作为 `chunk` 译文回传；改发 `status: thinking`。v0.8.21 起长思考期约每 15s **重发**一次 thinking 心跳（`thinking` 是既有状态值，重复发送不改变字段名/语义；viewer 展示幂等，守卫据此知道请求活着）。
- SW 端请求实际开始后 180s 无最终结果则 abort，并回超时错误。

## 7. 诊断与日志规范

- 所有 SW 日志前缀 `[PL-SW]`，viewer 日志前缀 `[PL-VIEW]`；关键节点都打点（连接、收发消息、fetch URL+状态码、chunk 计数、done/error）。
- viewer 顶部提供 **Debug HUD**（可折叠）显示：SW 健康（ping/pong）、进行中/完成/失败计数、最后一条错误。
- options 提供**原始自检**按钮：直接从 options 页 `fetch` 目标接口（非流式），展示 HTTP 状态码 + 响应体前若干字符，便于隔离 C4。

## 8. 模块任务与验收标准

### M1 后台管线（src/background/service-worker.js, src/lib/translator.js, src/lib/cache.js）
- [x] 处理 `ping` → 回 `pong`，并返回 build ID。
- [x] 网络执行设置 180s AbortController 硬超时；viewer 另有首字节 90s / 输出空闲 45s 守卫。
- [x] translator 解析 `reasoning_content`：发 `onStatus('thinking')` 且不当作译文；长思考期约每 15s 重发一次心跳。
- [x] 所有请求分支以 done / error / cancelled 收尾，扩展重载时旧 build Port 会明确断开。
- [x] 视觉质量复核使用自适应输出预算、temperature 0 和坏缓存绕过。
- **验收**：请求不会静默悬挂；ping 必有 pong；旧 viewer 不会与新 SW 混跑。

### M2 阅读器（src/viewer/viewer.js, viewer.html, viewer.css）
- [x] 启动即 ping，HUD 显示 SW 是否响应、进行中/完成/失败计数与最后错误。
- [x] `status: thinking` 用文字状态反馈，不使用结构性 emoji。
- [x] 前端无活动守卫区分首字节、输出空闲和排队 hold；失败页显示可执行重试入口。
- [x] 默认阅读模式：图片和表格主体只留左侧；公式以 LaTeX / KaTeX 显示。
- [x] 正文 chunk、公式状态和缓存 done 共享稳定渲染状态；重试不会接受旧 generation 结果。
- [x] 科研助手证据卡、Ctrl+K 技能面板和导出支持键盘与可追溯状态。
- **验收**：无论后台是否响应，用户都能从 HUD 看到明确状态，不再"毫无反应"。

### M3 【历史】段落抽取（src/lib/blocks.js）
- [ ] 对空页/异常 item **绝不抛异常**，返回 []。
- [ ] 保持导出签名 `extractBlocks(items, pageHeight, pageWidth, pageNum)` 不变。
- **验收**：喂入畸形/空 textContent 不崩。

### M4 设置页（src/options/*, src/popup/*）
- [x] "原始自检"直接 fetch 目标接口，展示状态码、响应体片段和可复制诊断。
- [x] 多 Provider Profile 保存 Base URL、Key、协议与模型，并可一键切换；公开配置不泄漏 Key。
- **验收**：用户点一下就能拿到可发给开发者的原始错误。

## 9. 手动测试清单
1. 加载扩展 → 打开 SW 控制台，应无红色加载错误。
2. 打开 `https://arxiv.org/pdf/2401.02051`：左侧出 PDF；HUD 显示"SW 正常"。
3. 未配 Key：块显示 Key 错误（不是无限 loading）。
4. 配好 Key：第 1 页逐字出译文；下滚翻下一页。
5. options "原始自检"：返回 200 + 一段中文译文样例。
6. 图片/表格页：右栏只显示说明和左侧定位入口，不复制媒体主体；公式以 KaTeX 渲染。
7. 科研助手提问：展开证据卡，检查支持度、页码跳转、历史恢复和 Markdown 导出。
8. Ctrl+K：可搜索技能，方向键与 Enter 可执行，Escape 关闭后焦点回到启动按钮。

## 11. 无头 Edge 截图工作台（复现事实的唯一手段）

因无法直接进用户浏览器，用 Edge headless 跑**项目真实渲染代码**并截图，代替猜测。

流程：
1. `POST /analyze` 拿到真实论文的 `_x.json`（每页 blocks + images）。
2. 用 `server/_htmpl.html`（内含 viewer 的 `renderLayoutBlocks` 等函数的同步副本 + 引本地 vendor 库），
   把某页数据内联进去（`window.__PAGE__` 占位替换为 JSON），生成 `_h_<tag>.html`。
3. `msedge.exe --headless=new --screenshot=out.png --virtual-time-budget=5000 file:///.../_h_<tag>.html`。
4. Read 截图，肉眼核对。

注意：
- headless 下 `file://` 的 `fetch` 被 CORS 拦，**必须把数据内联**进 HTML，不能 fetch。
- 用户系统代理在 `127.0.0.1:7897`，本地 `/analyze` 请求要用 `ProxyHandler({})` 绕过。
- 测试产物统一 `server/_*` 前缀，验证完清理。

## 12. 已知问题台账（改前读、改后更新）

### AI 助手聊天面板（轻量版）（2026-07-17）
- 新增右侧可收起的「AI 助手」聊天面板：工具栏 `#btn-chat` 或划词浮层「问 AI」打开；含消息列表（用户/AI 气泡）、输入框、发送/清空/收起。默认收起，开/收起状态记忆到 `localStorage`（`paperlens.chatPanel.open`）；对话历史**仅存内存**（刷新即清空，不落 IndexedDB）。Enter 发送、Shift+Enter 换行；流式打字机显示，请求进行中「发送」变「停止」（复用既有 `cancel`）。
- 对话能力：新增**独立** Port 消息类型 `{type:'chat', id, messages}`（见 §6），携带完整 `messages` 多轮数组，复用当前 Profile 的 baseUrl/apiKey/model。translator 新增 `chat({config, messages, onDelta, onStatus, signal})`，OpenAI 兼容与 Gemini 两条协议都复用既有 fetch/SSE 解析、thinking 心跳与取消/超时语义。SW 端 `handleChat` 立即执行、不排队，**不经 cacheGet/cacheSet**（聊天不写译文缓存）。未改任何既有 `translate` 字段语义；正文缓存身份（`reading-node-v10` / `page-node-ndjson-v2:`）逐字未动。
- 选中即问：左栏原文或右栏译文划词后，浮层除「翻译」外新增「问 AI」按钮，点击把选中文本 + 已收集的两侧语境组织成预填问题（`请解释这段内容：…（上下文参考：…）`），自动展开面板并发送。上下文复用 `collectSelectionContext` 已有结果，零额外收集逻辑。
- system prompt：`chatSystemPrompt`（`src/lib/chat-assistant.js`）说明「帮助理解学术论文、用中文回答、可解释术语/概括段落/答疑」，公式用 LaTeX、方法名/引用不译。
- 代码组织：纯逻辑 `src/lib/chat-assistant.js`（system prompt、messages 拼装、问 AI 问题组织）；面板逻辑 `src/viewer/chat-panel.js`；样式集中在 `viewer.css` 末尾 AI 助手 section（reduced-motion 下 transition 归零）。viewer.js/html 只做最小接入（import、`client.chat`、工具栏按钮、划词浮层「问 AI」按钮）。新增配置 `chatAssistant`（默认 true）+ options 勾选框；关闭时隐藏工具栏入口并收起面板。
- **未改** manifest.json 与 src/lib/build-info.js（版本号由协调方统一 bump）；未碰 page_ir.py、算法渲染、bilingual/src-line、滚动同步。

### v0.8.22 划词即时翻译浮层 + 「原文对照」开关接线（2026-07-17）
- 功能 1（划词）：manifest 与 FEATURES_SUMMARY 早已宣称「鼠标划词即时翻译」，SW 端 priority 免排队通道也一直存在，但 viewer 端从未实现。现左栏 PDF textLayer 拖选（mouseup 且 `event.detail===1`，双击/三击选词 `detail>1` 直接跳过、双击定位逻辑未动）→ 选区附近浮层先显示原文片段+「翻译中…」，译文流式就地更新。请求为端口协议**既有形状** `translate{id,text,priority:true}`，未新增/未改字段。上下文组织在 `src/lib/selection-translate.js`：收集选区两侧相邻 span 文本（每侧 ≤480 字符），按 `Context (for reference only, do not translate):` + `Translate only this excerpt:` 标记组织 user 文本；`defaultSystemPrompt` 增加对应规则（标记常量由该模块单一来源共享，payload 与 prompt 不会漂移），译文只含 excerpt。SW 对 priority 请求不读也不写共享译文缓存；正文缓存身份（`TRANSLATION_PIPELINE_VERSION`=reading-node-v10、`page-node-ndjson-v2:`）逐字未动，正文缓存不失效。关闭（Esc/点浮层外/左栏滚动>48px）与再次选择均发既有 `cancel`；浮层可选中复制；优先上方 bottom 锚定（流式增高向上生长不遮挡选区），空间不足下方；reduced-motion 无动画。新增全局配置 `selectionTranslate`（默认 true）+ options 勾选框；false 时完全移除 mouseup 监听，配置经 storage 刷新链路热更新。
- 功能 2（原文对照）：`config.bilingual`（config.js + options 勾选框）自早期版本存在，但 viewer 全文无一处读取——勾了无任何效果。现结构化路径 `mountStructuredPage` 时为每个 prose 块（段落/标题/plain_text/caption）创建一次 `.src-line`（源文本取渲染层已有数据，零新请求），公式/表格/图片引用/Algorithm 不加；流式回填/局部重试只切换 `src-ready` class，原文行 DOM 永不重建 → 不闪烁不重复；pending/failed 节点保持骨架/错误提示、不显示原文行；citation 等源文本原样保留的节点不重复显示。显隐总开关 `body.bilingual-src` 由 `commitPublicProviderState`→`applyReadingPreferences` 热更新，options 保存后已打开的阅读页即时生效。
- 版本：manifest 0.8.22，build ID `2026.07.17-hybrid-layout-v19`；服务端 0.8.19 未动。全量验证：Node 357/357（新增 23 项：划词纯逻辑与几何 10、defaultSystemPrompt 标记 1、配置默认值/设置页 2、viewer/SW 源码契约 8、样式契约 2）。

### v0.8.21 P1 翻译超时根因修复：守卫窗口语义 + thinking 心跳 + 排队死线（2026-07-17）
- 根因 A（守卫误杀）：`makeInactivityGuard` 承诺「首字节前 90s」，但 SW 在任务启动时立即回 `status: connecting`，viewer `bump()` 把窗口压成 idleMs=45s；推理模型思考期 `thinking` 又只发一次，之后 45s 纯静默守卫就取消了仍在正常思考的请求。修复：守卫提取为可单测模块 `src/lib/inactivity-guard.js`（计时器可注入），新增 `output()`。首字节（第一个 chunk 或 `status: streaming`）前，`connecting`/`thinking`/`queued` 恢复只把 firstMs=90s 完整窗口重新计时；首字节后才进入 idleMs=45s。translator 在 reasoning/thought 增量持续到达期间约每 15s 重发 `thinking` 心跳（`createThinkingStatusHeartbeat`，OpenAI 兼容与 Gemini 两条流式路径都接入）。viewer 对重复 thinking 的展示幂等；legacy 分块路径增加「阶段未变不重建整页 DOM」去抖。
- 根因 B（排队硬拒绝）：正文排队死线固定 60s，但 4 个并发槽位可被慢请求合法占满 180s（REQUEST_TIMEOUT_MS），第 5 个请求排队 60s 必死，且错误文案含「超时」与守卫/模型超时无法区分。修复：死线提为 `NORMAL_QUEUE_TIMEOUT_MS`=240s（=180s+60s，排队最长等完一个完整慢请求周期；在动态死线/降级重排/简单提高三个方案中选择最简单可预测的后者——排队 UX 已由守卫 hold 停表保证，死线只是队列无限增长时的最终保险）；错误文案改为「排队等待超时（240s）：前方翻译任务较多…」，`friendlyReaderError` 增加独立分支保持与「模型响应较慢」可区分。
- 附带修复（hold 永久挂起）：`queued` 停表后，若 Port 瞬断丢掉后续状态消息（SW `post()` 静默吞异常），守卫永不触发、页面永远「排队中…」。现 `hold()` 带 450s 兜底上限（240s 排队死线 + 180s 请求硬超时 + 30s 余量），重复 hold 不重置死线，任何 bump/output 取消兜底。
- 端口协议冻结未破坏：无新增字段；`thinking` 重复发送与排队错误文案变化均不改变既有字段名/语义。`TRANSLATION_PIPELINE_VERSION` 保持 reading-node-v10（译文内容协议未变，缓存不失效）。manifest 0.8.21，build ID `2026.07.17-hybrid-layout-v18`。全量验证：Node 334/334（新增 inactivity-guard 12 项、translator thinking 心跳 3 项、排队死线/文案 2 项）；服务端未改动。

### v0.8.18 混合版面检测、扫描页回退与可信表格（2026-07-15）
- 新增可插拔 `server/layout_detector.py`。基础运行时继续依赖 PyMuPDF 规则；只有 `.layout-ai-enabled` 存在或显式配置后端时，才对复杂/含图/无文字层页面运行 PyMuPDF Layout CPU 检测。依赖缺失、接口不兼容或推理异常均回退启发式结果。
- `page-ir-v1.17` 融合学习型 table/picture/formula/caption 区域；学习型表格优先，学习型 figure 原子化并抑制区域内文字/公式泄漏。扫描页输出 `needs_ocr`，viewer 自动走整页视觉 OCR。
- 学习型检测同时返回复合 figure 与内部 panel 时，按面积保留完整外层图并去掉嵌套/近重复 picture；真实 D4L 第 8 页由 3 个重复 figure 收敛为 1 个完整 figure，Algorithm 结构仍保留。
- 阅读模式不再把普通 figure crop 复制到右栏；只保留译文 caption 和左侧定位引用。可信学习型表格才受控生成 HTML table，并只翻译文字表头/标签；其他表格仍以原表裁图或左侧引用为准。
- manifest/服务为 0.8.18，提取器为 `page-ir-v1.17`，build ID 为 `2026.07.15-hybrid-layout-v15`，翻译管线为 `reading-node-v8`。全量验证：Node 310/310、便携 Python 43/43、fallback venv 43/43。

### v0.8.17 图片原子性、Algorithm 行结构与手动打开 PDF（2026-07-15）
- 带 Fig./Figure caption 的复合视觉区域现在在显示公式分组前完成原子化。D4L 第 7 页由 0 figure/14 display_math 恢复为 1 个完整 MLP figure；第 8 页由 0 figure/21 display_math 恢复为 1 个完整混合矢量/位图 figure。区域内 ReLU、图例和数学标签不再进入正文翻译。
- Algorithm 改为逐逻辑行 Page IR：打印行号只作 metadata，x 坐标恢复嵌套缩进，长语句续行归属上一编号行。viewer 使用行号列 + 内容列渲染；同一行的译文和 KaTeX 共用容器。Algorithm 2 第 5 行的分式、max 上下限和两组内积作为一个视觉 OCR crop，不再拆出孤立的 `1` 与 `1+epsilon`。
- 旧版动态 PDF 重定向规则 1001/1002 会在 service worker 初始化、安装和浏览器启动时清除；普通 PDF 与 arXiv 导航保持浏览器原行为，只有 popup、右键菜单、粘贴 URL、本地文件或显式 `openViewer` 才进入 PaperLens。
- manifest/服务为 0.8.17，提取器为 `page-ir-v1.16`，build ID 为 `2026.07.15-visual-structure-v14`，翻译管线为 `reading-node-v7`，公式缓存仍为 v6。全量验证：Node 306/306，便携 Python 37/37，fallback venv 37/37。

### v0.8.16 数学密集译文恢复与公式 (17) LaTeX（2026-07-15）
- D4L 第 4 页定义段原先按 7/7/5 个公式切分。末段任一 `PLM` token 被模型改变时，严格校验会拒绝整单元，表现为公式已显示但相邻文字持续为紫色骨架。现在句号、`if and only if`、`such that` 等语义边界可提前切分，真实段落变为 7/7/3/2；首轮仍失败时，恢复请求不再携带公式 token，而是逐个翻译 prose slots，再由本地恢复原公式与边界空白。
- citation、数字或纯标点等不会进入供应商请求的节点会立即显示权威源文本，不再永久保持 pending。真实 D4L 回归验证全部 20 个 text segment ID 恰好写入一次，并全部移除 `structured-text-pending`。
- 公式 (17) 的 PDF 文本层把视觉平方范数压平成 `∥…∥2`。旧门禁强制要求 `\\rVert_2`，因此正确 OCR `\\rVert^2` 被误拒。v0.8.16 改为信任视觉恢复的脚本方向，同时按源文本要求每个范数后缀都存在；标准 `O\\!\\left(`、`\\left\\|...\\right\\|` 先规范化后校验。缺第二个范数或缺一个平方后缀的结果仍被拒绝。
- manifest/服务为 0.8.16，build ID 为 `2026.07.15-math-recovery-v13`，翻译管线为 `reading-node-v6`，公式缓存命名空间为 v6。全量验证：Node 297/297、Python 35/35。

### v0.8.12 复杂算法/矢量图与精确双击定位（2026-07-14）
- 提取器升为 `page-ir-v1.14`。算法不再使用“标题后固定 18% 页高”的截断范围，而是从 `page.get_drawings()` 的顶部、标题分隔线和底部框线恢复真实边界；算法专用 baseline 合并避免相邻行号或 bullet 串行，同时不改变二维公式既有合并规则。真实 D4L 第 8/9 页 Algorithm 1/2 均完整到第 10 行，且不吞右栏表格或下方正文。
- 含大量坐标轴文字的矢量图不再被 prose-density 规则误判。高路径复杂度提供更强图表信号；D4L 第 14 页 Rocket Injector 图恢复为完整原子 figure 区域，并将相邻 Fig. 4 caption 绑定到 figure，只翻译 caption。该历史版本曾在右栏显示 crop；v0.8.18 已改为仅保留左侧定位引用。
- text segment 现在同时携带 union bbox 和逐行/连续 span `bboxes`。左到右定位按 fragment 命中，远离所有节点时不再任意跳到“最近正文”；显示公式、表格、figure 都登记自身 bbox。右到左可同时高亮多个源 fragment。
- 双击事件固定使用本次页和本次坐标，旧 Selection 不再造成跨页误跳；旋转页显式执行 Page IR/PDF.js 坐标变换；程序化定位滚动暂时关闭双栏同步，避免跳完又被页级滚动反拉。单击不触发导航。
- manifest/服务升为 0.8.12，build ID 为 `2026.07.14-layout-link-v9`，翻译缓存管线升为 `reading-node-v4`。全量验证：Node 278/278，Python 34/34；本地服务 `/health` 返回 0.8.12，实时文档会话验证第 9 页算法完整、第 14 页 figure/image/caption 均存在。

### v0.8.11 高数学密度段落的流式拆分（2026-07-14）
- D4L 第 4 页共有 63 个行内公式；旧阅读计划把其中 19、8、11、12 个占位符分别塞进四个长段落记录，模型容易改乱占位符并触发整段局部重试，表现为公式已显示、正文骨架长时间不消失。
- 公式数超过 7 的段落现在按稳定文本/公式边界拆成多个有界阅读单元，仍然整页一次 NDJSON 请求；每个记录最多 7 个公式占位符，可以更早流式落地，失败时也只重试更小的单元。
- 公式占位符仍保持原顺序，所有文本节点只映射一次；纯公式行不再因为 `PLM` 占位符中的字母被误判为待翻译文本。翻译缓存管线升为 `reading-node-v3`，避免复用旧的长段落结果。
- 提取器升为 `page-ir-v1.13`：每个 text segment 携带自己的归一化 bbox，`src/lib/page-ir.js` 保留该坐标，viewer 将它与对应 `data-ir-id` 一起登记；因此同一段内的多个译文节点不再全部指向整段框。
- 两侧定位均改为双击触发，单击只保留正常阅读和选词行为。译文到原文优先取具体文本/公式节点 bbox；原文到译文使用双击选词中心的 x/y 选择包含该点且面积最小的节点，无法精确匹配时才回退旧的块级 y 距离。

### v0.8.10 PDF.js 全量 willReadFrequently（2026-07-14）
- 用户仍报告 `genericComposeSMask` 的 Canvas2D 读回警告。v0.8.9 仅给 `smaskGroupAt` / `_smask_` 缓存键开 `willReadFrequently` 不够稳：`genericComposeSMask` 对两端 context 连续 `getImageData`，任一端未标记都会触发 Edge/Chrome 性能警告。
- 改回低风险策略（对齐 v0.8.8 / Moonlight PDF.js 4.x 的 `willReadFrequently: !enableHWA`）：`BaseCanvasFactory`、viewer 注入的 `createReadOptimizedCanvasFactory` 与 `CachedCanvases.getCanvas` 一律对 PDF.js 中间 Canvas 使用 `{ willReadFrequently: true }`。
- 主页面显示 Canvas（viewer 自己 `getContext('2d', { alpha: false })`）不走此工厂，仍保持默认 GPU 绘制路径。
- 验证：相关 Node 单测通过；manifest / build ID / 本地服务升到 0.8.10。

### v0.8.9 PDF.js SMask 定点读回优化（2026-07-14）
- PDF.js 的 `CachedCanvases` 曾只把 `smaskGroupAt...` 与 `groupAt..._smask_...` 两类缓存键标记为高频读回；后被 v0.8.10 的全量策略取代。
- vendored `BaseCanvasFactory` 与 viewer 注入的 CanvasFactory 都接受同一个第三参数，确保默认 PDF.js 路径与 PaperLens 路径行为一致。

### v0.8.8 PDF.js Canvas 读回优化（2026-07-14）
- Edge 报告 `genericComposeSMask` 多次 `getImageData`，但旧 PDF.js 3.11.174 的 `BaseCanvasFactory` 只调用无选项的 `getContext("2d")`，因此被浏览器记录为扩展性能警告。
- Moonlight 的 PDF.js 4.5.136 在 `BaseCanvasFactory` 中使用 `willReadFrequently: !enableHWA`，且新版 SMask 已改为滤镜与 `drawImage` 路径。当前先采用低风险兼容修复：向 PDF.js 3.11 注入完整 CanvasFactory，使所有内部 Canvas 使用 `willReadFrequently: true`。
- 独立工厂行为与 viewer 注入均有红绿回归测试；保留升级 PDF.js 4.5+ 作为后续独立迁移任务，不与本次警告修复捆绑。

### v0.8.7 本地运行时异常捕获（2026-07-14）
- viewer 与 Service Worker 安装统一诊断捕获器，记录 error、unhandledrejection、console warn/error；viewer 额外记录版本化翻译 Port 的断开原因。
- 日志最多保留最近 40 条，附带 build ID、组件、来源和栈；Bearer、API Key 查询参数及 URL userinfo 在写入前脱敏。
- popup 新增“查看 / 复制异常诊断”，独立诊断页可刷新、复制和清空记录。该页面不依赖 Service Worker 消息，因此后台异常时仍可读取已落盘日志。

### v0.8.6 扩展重载与错误页去噪（2026-07-14）
- manifest 与本地服务升级到 0.8.6，build ID 升为 `2026.07.14-reading-formula-v3`，避免磁盘代码已更新但 Edge 仍运行旧扩展上下文时难以辨认。
- viewer 在 Port 断开回调中读取 `chrome.runtime.lastError`，消费浏览器要求处理的错误状态；扩展重载、旧 Port 或旧页面上下文只显示刷新提示，不再制造新的“Unchecked runtime.lastError”记录。
- 旧错误页中的 `viewer.js:1360 isKatexRenderable` 来自早期 bundle；当前同一行已属于会话版面代码。Edge 的扩展错误记录不会随磁盘源码更新自动消失，需在加载 0.8.6 后清除历史记录并重新打开阅读器验证。

### v0.8.5 行内公式、完整译文与运行时一致性（2026-07-14）
- 复杂行内公式不再在 KaTeX 失败后显示斜体 `source_text`。可信简单公式即时渲染；不可信行内公式从 PDF.js 页面 canvas 取得紧致 crop，与本页显示公式合并为一个 OCR sprite，正文翻译并行进行，成功后原位替换为 KaTeX。
- 公式质量门新增连续下标/上标拒绝；未编号显示公式等待或失败时也保留原 crop。工具栏重试会包含公式失败，并取消上一 generation 的公式请求。
- Typed 右栏初始使用译文骨架，不再把英文源文伪装成译文；质量门会拒绝“中文前缀 + 连续英文原句”。Node 协议升为 v2，翻译缓存加入 pipeline namespace。
- viewer 与 service worker 共享版本化 Port 和 build ID；公式缓存升为 v5。manifest 与本地服务为 0.8.5，提取器为 page-ir-v1.12。
- 回退路径的表格 crop 禁止向上拉伸、caption 统一居中；少于 5 行或低可信且无 caption 的表格候选不再吞掉正文。
- 验证：Node 260/260；项目便携 Python 30/30；D4L 第 6 页问题公式与第 11/12/17 页表格回归通过。

### v0.8.4 Moonlight 风格快速阅读与公式质量链（2026-07-13）
- 译文请求改为一页一次、按阅读顺序的段落级 NDJSON；模型获得整页上下文，行内公式占位符由本地严格校验并回填到既有 DOM。
- 显示公式裁剪会排除 `for`、`Since`、`and` 等正文连接词；页边缘小型纯数字 folio 不再进入翻译。公式 batch OCR 携带 source_text 噪声提示，但图像像素是权威来源。
- 公式质量门拒绝可渲染的伪 LaTeX，例如 `//...//2`、扁平 `\\theta{}k`、丢失的 `\\sim`、不配对范数或缺失整项/等号；失败项单图复核一次，仍失败显示原 PDF 裁图。单图与 batch 缓存均升级为 v4，并把 source_text 纳入身份和复用校验。
- 当时的快速阅读模式统一显示原表裁图和译文 caption，不重建单元格；caption 的上/下位置及居中对齐沿用 Page IR。v0.8.18 起，高置信且规模受限的 PyMuPDF Layout 表格可受控重建，其余仍沿用此回退策略。
- 本地页分析和模型请求对严格识别出的瞬时网络错误自动重试一次；模型已产生流式输出后绝不重放。
- 验证：Node 254/254；Python 29/29；隔离 Edge 中 D4L 20/20 页完成、公式 KaTeX 链路和原表裁图链路通过，控制台 0 error。

### v0.8.3 KaTeX 全局防火墙与报错指纹（2026-07-13）
- `katex-guard.js` 在 viewer 初始化前包装 KaTeX 的 `render`、`renderToString`、`__parse`、`__renderToDomTree` 和 `__renderToHTMLTree`。
- 所有入口在库边界再执行一次 Unicode→ASCII LaTeX 规范化，且无条件覆盖为 `strict: ignore`；损坏字符在 KaTeX parser 运行前拒绝。
- 防火墙安装是幂等的，阅读器徽标显示 `v0.8.3 · KG1`，用于区分新运行时与 Edge 历史错误记录。
- 验证：Node 233/233；Python 26/26；真实内置 KaTeX 在调用方故意传入 `strict: warn` 时仍为 0 warning。

### v0.8.2 KaTeX 输入防线与旧实例识别（2026-07-13）
- KaTeX 预检查、typed/legacy 显示公式、行内公式、表格单元格和自动渲染全部统一经过 `math-normalization.js`。
- 欧姆符号、双竖线、数学斜体/粗斜体希腊字母、script L、微分符号、上下标和常用运算符都转为 ASCII LaTeX 命令；未知非 ASCII、U+FFFD 或孤立 surrogate 使整条 LaTeX hint 失效，触发原图/OCR 回退。
- 模型公式提示明确限定只输出 ASCII LaTeX；后端提取器同步收口到 page-ir-v1.10。
- 阅读器顶部显示 manifest 版本；报错栈行号和可见版本不一致时，先关闭旧阅读标签页并清理扩展的历史错误。
- 验证：Node 228/228；Python 26/26；内置 KaTeX 对本次全部报错字符实际渲染 0 warning。

### v0.8.1 KaTeX Unicode 兼容（2026-07-13）
- KaTeX 所有入口统一设置 `strict: ignore`，`throwOnError` 仍负责阻止真正的 LaTeX 解析错误。
- Page IR 先将 U+2126 和希腊大写 Omega 规范化为 `\Omega`，提取器缓存版本为 page-ir-v1.8。

### v0.8.0 稳定文本节点翻译协议与公式 row-band（2026-07-13）
- Typed Page IR 主路径改用 `{id,text}` NDJSON，不再向翻译模型发送 `[[PLM:id]]` 公式占位符或 `@@@BLK@@@` 位置分隔符。
- 公式节点始终保留在本地 Page IR；模型响应按稳定文本 ID 回填，一个节点缺失/未翻译不会回滚同段其他译文。
- 二次失败页标记为 `partial` 并保存 unresolved IDs；工具栏“重译失败”可只重译这些节点。
- 页调度器会等待完整翻译生命周期；局部恢复请求高优先级，普通后台队列有 60 秒有限等待。
- 显示公式从 raw-block 二分类改为 line-level row-band：编号锚点、同栏连通区域和紧致联合裁剪保证多行方程只生成一个 `display_math`；D4L 第 4/5 页的求和上下限、约束、括号和编号不再泄漏成正文。
- 同页复杂显示公式通过带 `FORMULA_ID` 的 sprite 一次转写，响应按 ID 回填；模型漏项只回退对应原公式裁图。
- 未编号公式的 OCR 裁图不进入右栏等待/失败 UI，避免把同一 PDF 行中的邻近英文误显示成译文；模型幻觉编号也不能重新开启裁图回退。
- 自动测试：Node 220/220；Python 24/24；真实 D4L 第 3/4 页 Page IR 翻译载荷已验证为 0 个公式占位符。

### v0.7.0 公式分段 v2 + 段落级质量修复（2026-07-13）
- 真实 D4L 第 4 页根因已确认：PyMuPDF 把整句 `is a preference vector...` 误标为 superscript，旧逻辑又把该 flag 无条件当成数学。
- `page-ir-v1.5` 改为词法 + 基线几何联合分类；长英文强制回退正文，仍保留 `x(λ)`、`∈X`、`hθ(λ)`、`θ` 等真实行内数学；跨块分裂的上下标会在分段前重新合并，LaTeX 控制词跨 PDF span 时会补安全边界，公式边界空格归还正文避免与 KaTeX 粘连。多行表题与表格区域在提取前分离，防止表题进入单元格或下一张表误抓上一张表。
- 行内公式占位符改为 ASCII `[[PLM:id]]`，并容忍全角括号、全角冒号和轻微空格变体。
- 最终校验改为逐段落；单个公式段损坏不再阻断整页。长英文未翻译与占位符失败只合并局部重试一次，且重试绕过坏缓存；未通过 token、分块数或未翻译检查的结果不再写入/命中翻译缓存。
- 二次失败仅在当前段落显示中文检查提示，其他译文保留，页面不再进入整页红色错误。
- 自动测试：Node 195/195；Python 21/21；真实 20 页 D4L 回归已纳入仓库 fixture。

### v0.6.0 结构优先实时阅读（2026-07-12）
- 已修复 Algorithm 横线框被 `_detect_vector_figures` 当图后删除框内文字的问题；legacy 与 Typed 路径均有文本密度硬保护。
- 已修复 `Page.find_tables(strategy='text')` 把整页双栏正文识别成 59×15/69×7 巨型表格的问题；无框表格仅在 TABLE caption 邻近区域检测。
- typed display_math 已接入公式 OCR；复杂公式先显示裁剪图，OCR 完成后只替换对应 KaTeX host，不重建整页 DOM。
- 表格单元格支持行内 KaTeX，caption、列头、行头、数值对齐和读屏语义均由确定性 DOM 生成。
- 自动测试：Node 176/176；Python 10/10；真实 HTTP 会话、缓存、D4L 第 4/8 页已验收。

测试基准文件：主要回归目标是 **D4L 论文 20 页版**（arXiv 2010.04104），
截图显示"第 7/20 页"。另有 `2203.15386.pdf`(31页) 是同主题不同版本，勿混。

### v0.5.0 阅读模式（2026-07-11）
- 默认以左侧 PDF 为视觉真相；右侧只重建译文和可阅读的 LaTeX 公式。
- 普通图片在结构化、整页 Markdown 和视觉回退路径中都不再显示裁剪图，统一显示“查看左侧原图”。
- 公式 OCR 失败显式回退原公式裁剪图；无裁剪时显示“查看左侧公式”，所有状态保留 bbox 点击定位。
- 已用 Node 内置测试覆盖公式解析、呈现决策、取消 Promise、generation、最终 RAF 门控、缓存 Base URL 与空响应策略。

### BUG-1 公式格式仍不对（真根因：正文被误判为公式）
- 现象：公式区混着没翻译的英文；(21)(22) 编号错位；正文 `其中 λk…` 变孤立残句。
- **真根因（工作台 + 原始块数据锁定，2026-07）**：LaTeX 论文正文里的内联符号（λ θ k 等）
  用**数学斜体字体**排版，导致 `_block_math_ratio` 把**整段正文**（如
  `where λk ∈Λk ⊂Rm denotes the m-dimensional preference…`）也算成高数学占比，
  `>=0.30` 阈值将其**误判为显示公式 → 栅格化成图 → 永不翻译**。
  `_merge_adjacent_formulas` 再把这些误判块链式合并成整页大图，是二次伤害。
- **正确修法**：分类器增加「**正文词数**」判据 —— 统计块内连续 ≥3 个 ASCII 字母的"真词"，
  显示公式几乎没有真词（`h1=ReLU(...)` 仅 1 个），正文有很多（`where…denotes…preference` 7+）。
  仅当 `math_ratio>=0.30` **且 prose_words<=3** 才判为公式；否则是正文，正常翻译。
  同时 `_merge_adjacent_formulas` 的 `same_column` 收紧为「两块必须整体落在同一半栏」，防跨栏。
- 验收：工作台截图中，正文段落是可翻译文字（有【译】），只有真正的居中方程组是图片、编号在行内。

- **进度（2026-07，工作台 D4L.pdf 第6页验证）**：
  - ✅ 分类器加 `prose<=3` 门槛 + 阈值降到 0.20：正文不再被误判成公式（`where λk…` 正常翻译）。
  - ✅ `_merge_equation_rows` / `_merge_adjacent_formulas` 加 `same_column` + 不跨页中线 + 面积上限：
    消除"整页变一张图"，/analyze JSON 从 8.3MB 降到 2.6MB。
  - ✅ `_merge_adjacent_formulas` 加 `same_row`（并排片段合并）：(16)(17)(19)(20) 已是完整公式、编号在右。
  - ⚠ **残留**：个别公式（如 (18)）被 PyMuPDF 拆成竖直距离较远的碎片，启发式 gap 阈值跨不过去，
    仍有碎片错位 / 单行公式文本漏进正文。纯启发式难做到 100%，暂接受；如需根治要上版面模型（方案 C Marker），
    但那需要 GPU 显存，用户机器不满足。

### BUG-2 含大量图片的页翻译超时（无响应）
- 现象：带图片的页显示 `✗ 翻译超时（无响应）`。
- **已排除**：不是文本量大 —— 第 8 页发送文本仅 3086 字符（纯文本页有 6000+）。
- **已定位的贡献因素**：/analyze JSON 达 **8.3MB**（BUG-1 的整页大图 + 大量 base64），
  viewer 一次性收下并解析、且每页 blocks 携带大 data URL，前端渲染/内存压力大；
  叠加并发队列，`makeInactivityGuard` firstMs=90s 内首字节可能未到 → 误报超时。
- 方案（待实施）：
  1. 先修 BUG-1（消除整页大图）→ JSON 体积应大幅下降，观察是否即解决。
  2. 若仍超时：图片过大时服务端**限制单图最长边 / 降低 zoom**，压缩 base64 体积。
  3. viewer 侧：含图页首字节超时 firstMs 适当放宽，或让图/公式块**不阻塞**文本翻译先出。
- 验收：含图页能在合理时间出译文，或给出明确非超时错误。

- **进度（2026-07）**：
  - ✅ BUG-1 修复顺带把 JSON 从 8.3MB 降到 2.6MB。
  - ✅ **找到真机制**：`makeInactivityGuard` 中 `queued` 状态调用 `bump()` 把超时重置为 45s，
    而排队中不会再有活动 —— 若前面有多页占满并发，靠后的页（含图页多在文档后半）在队列里
    等待 >45s 就被**误判超时**。这才是"含图页翻译不出来"的根因，与图片本身无关。
  - ✅ **修复**：新增 `guard.hold()`，`queued` 时**暂停计时**（排队不算无响应），
    真正开始（connecting/首 chunk）再 `bump()`。三处 onStatus（layout/whole/vision）均已改。
  - ⏳ 待用户重载扩展后实测确认含图页不再超时。
  - ✅ **v0.8.21 后续**：hold 只覆盖了排队期误杀；`connecting` 后守卫仍被压成 45s、
    思考期 thinking 只发一次导致的误杀，以及排队 60s 硬死线，见 §12 v0.8.21 条目，已一并修复。
