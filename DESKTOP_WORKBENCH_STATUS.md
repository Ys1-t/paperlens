# 桌面版「科研工作台」50 代改造 — 进度与未完成任务

> 更新时间：2026-08-04（P2 续作后刷新）。
> Desktop 版本：**0.2.1**。
> 详细代数表见 [`docs/DESKTOP_WORKBENCH_50_ITERATIONS.md`](docs/DESKTOP_WORKBENCH_50_ITERATIONS.md)。

---

## 1. 六大板块总览

| 板块 | 代数 | 状态 |
|---|---|---|
| 阅读器体验 | 1–16 | ✅ 完成（含懒渲染、块级锚点、质量门、右键菜单） |
| 工作台 / 文库 | 17–24 | ✅ 完成（含批量导入、元数据） |
| 前沿论文雷达 | 25–29 | ✅ 完成 |
| 投稿助手 | 30–35 | ✅ 完成 |
| 知识库（Obsidian） | 36–42 | ✅ 完成（含术语表管理 UI） |
| Agent 强化 | 43–50 | ✅ 完成（含会话持久化、导出/Overleaf/BibTeX） |

## 2. 已完成且已验证

### 2.1 数据层 `desktop/lib/`
- `workspace-store.mjs` v3：文库/兴趣/会议/待读/档案/统计/UI 偏好 + 待办/记忆/agentMode/overleaf/glossary
- `arxiv-radar` · `reading-stats` · `submission-helper` · `knowledge-base` · `workbench-tool-defs`
- `anchor-match` · `chat-session-store` · `paper-metadata` · `evidence` · `export-tools` · `memory-tools` · `research-skills`（16 技能）· `agent-core`

### 2.2 主进程 / preload / UI
- 7 视图工作台 + Agent 抽屉（Timeline、确认门、历史会话、技能条）
- 阅读：对照、懒渲染、联动、框选、块级定位、质量门重试、划词、右键
- 文库批量导入、雷达、投稿、知识库检索、**术语表管理**、统计热力图与费用估算

### 2.3 测试
- 全仓 `npm test`：**625 pass / 1 skip / 0 fail**（历史 Page IR 跳过）
- desktop 专项：`desktop-workbench-libs` / `desktop-research-*` / `desktop-anchor-match` / `desktop-chat-sessions` 等

## 3. 本次复核相对旧版 STATUS 的修正

旧 STATUS 写于「验证中断」时点，下列项**代码里其实已完成**，文档已更正：

| 旧文档写「未做」 | 实际 |
|---|---|
| 6 个新库无测试 | ✅ `desktop-workbench-libs.test.mjs` 等已覆盖 |
| anchor-match 模块未创建 | ✅ 已有 + 测试 + UI 接线 |
| 懒渲染 | ✅ IntersectionObserver |
| 质量门 | ✅ main 调 `assessVisionTranslationQuality` |
| 会话持久化 | ✅ sessions.json + 历史按钮 |
| 右键菜单 | ✅ pdf/trans contextmenu |
| 批量导入 | ✅ `library:import-folder` |
| BibTeX | ✅ `export_bibtex_stub` |
| 术语表管理 UI | ✅ 知识库视图（本轮补齐删除/列表/表单） |

## 4. P2 进度

| 项 | 状态 |
|---|---|
| 多标签页同时读多篇 | ✅ 0.2.1（标签切换按 path 重开，最多 8） |
| 持久高亮标注 | ✅ 0.2.1（划词「高亮」+ textLayer 恢复） |
| 独立写作视图 | ✅ 0.2.1（写作导航 + 草稿/生成/润色） |
| 统计页打磨 | ✅ 0.2.1（周对比、图例、token/费用） |
| 发布安装包 / 自动更新 | ❌ 仍开发态 `npm start`（可选后续 electron-builder） |

## 5. 验证命令

```bash
npm test
node --check desktop/ui/app.js
cd desktop && npm start
```

冒烟：启动无 console error；首页继续阅读打开 PDF；知识库术语表可增删；Agent 写笔记时副驾驶弹出确认。
