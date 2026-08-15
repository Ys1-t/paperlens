# PaperLens Desktop 科研工作台 — 50 代迭代清单

> 对应 `DESKTOP_WORKBENCH_STATUS.md`。验证基线：`npm test`（全仓 625+ 通过）+ desktop 模块单测 + `node --check`。
> 版本：Desktop **0.2.0**（2026-08-04）。

## 阅读器体验（1–16）

| 代 | 内容 | 状态 | 验证 |
|---|---|---|---|
| 1 | 左右对照布局（非上下叠译文） | ✅ | UI 阅读视图 |
| 2 | PDF textLayer + 划词翻译 | ✅ | 选词浮层 |
| 3 | 划词「问 AI / 锁术语」 | ✅ | 浮层按钮 |
| 4 | 滚动联动 + Alt 临时解除 | ✅ | 联动开关 |
| 5 | 双击页级定位 | ✅ | 双击闪框 |
| 6 | 块级锚点定位 `anchor-match` | ✅ | `desktop-anchor-match.test` |
| 7 | 懒渲染 IntersectionObserver | ✅ | 大 PDF 仅视口附近渲染 |
| 8 | 译全篇 / 停止 / 自动译 | ✅ | 工具条 |
| 9 | 质量门 + 灾难质量高精度重试 | ✅ | main `assessVisionTranslationQuality` |
| 10 | 框选提问（S） | ✅ | snip → Agent 附图 |
| 11 | 目录大纲 | ✅ | O 键 |
| 12 | 译文搜索 Ctrl+F | ✅ | 阅读工具条 |
| 13 | 缩放适宽 | ✅ | ± 控件 |
| 14 | 双语对照开关 | ✅ | 对照按钮 |
| 15 | 右键菜单（重译/复制/框选） | ✅ | contextmenu |
| 16 | 拖拽 PDF / 粘贴 arXiv | ✅ | drop + paste |

## 工作台 / 文库（17–24）

| 代 | 内容 | 状态 | 验证 |
|---|---|---|---|
| 17 | 7 视图导航壳 | ✅ | nav-rail |
| 18 | 首页仪表盘 | ✅ | 继续读/待读/DDL/周统计 |
| 19 | 文库列表 + 搜索 | ✅ | library 视图 |
| 20 | 标签 / 星标 / 进度 | ✅ | workspace library entries |
| 21 | 文件夹批量导入 | ✅ | `library:import-folder` |
| 22 | 论文元数据抽取 | ✅ | `paper-metadata.mjs` |
| 23 | 暗色主题 | ✅ | btn-theme |
| 24 | 状态栏页码/已译/模型 | ✅ | status-bar |

## 前沿雷达（25–29）

| 代 | 内容 | 状态 | 验证 |
|---|---|---|---|
| 25 | arXiv 抓取 + 分类 | ✅ | `arxiv-radar.mjs` 测试 |
| 26 | 兴趣关键词打分 | ✅ | scoring 单测 |
| 27 | 雷达卡片 UI | ✅ | radar 视图 |
| 28 | 一键下载打开 PDF | ✅ | open-arxiv-pdf IPC |
| 29 | 摘要速览写入 vault | ✅ | digest-to-vault |

## 投稿助手（30–35）

| 代 | 内容 | 状态 | 验证 |
|---|---|---|---|
| 30 | 会议预设表 | ✅ | submission-helper |
| 31 | DDL 倒计时与紧急度 | ✅ | deadlineCountdown 测试 |
| 32 | 投稿看板 UI | ✅ | submit 视图 |
| 33 | 检查清单 | ✅ | checklist |
| 34 | venue-advisor 技能 | ✅ | research-skills |
| 35 | Agent `list_submission_deadlines` | ✅ | workbench-tool-defs |

## 知识库（36–42）

| 代 | 内容 | 状态 | 验证 |
|---|---|---|---|
| 36 | vault 连接 | ✅ | obsidian pick folder |
| 37 | 全文检索 | ✅ | knowledge-base 测试 |
| 38 | Agent KB 工具 | ✅ | search/read/overview |
| 39 | kb-weave 技能 | ✅ | skills |
| 40 | 笔记同步写 vault | ✅ | obsidian:write-note |
| 41 | **术语表管理 UI** | ✅ | 知识库视图增删改 |
| 42 | 术语锁定注入翻译 | ✅ | glossary fingerprint / lock |

## Agent 强化（43–50）

| 代 | 内容 | 状态 | 验证 |
|---|---|---|---|
| 43 | 自有 agent-core 工具循环 | ✅ | desktop-agent 测试 |
| 44 | 科研宪法 + 16 技能 | ✅ | research-skills |
| 45 | Timeline 可观察 | ✅ | chat UI |
| 46 | 副驾驶确认门 | ✅ | copilot 测试 |
| 47 | 课题待办/记忆 | ✅ | memory-tools 测试 |
| 48 | 证据卡回跳 | ✅ | evidence 测试 |
| 49 | 会话持久化 | ✅ | chat-session-store + 历史按钮 |
| 50 | 导出 MD / Overleaf / BibTeX | ✅ | export-tools |

## P2 续作（Desktop 0.2.1）

| 项 | 状态 | 模块 |
|---|---|---|
| 多标签读多篇 | ✅ | `reader-tabs.mjs` + 阅读器标签栏 |
| 持久高亮 | ✅ | `highlights-store.mjs` + 划词「高亮」 |
| 写作工坊 | ✅ | `writing-draft.mjs` + 写作视图 |
| 统计打磨 | ✅ | 周对比 / 图例 / token 费用 |
| 安装包自动更新 | ❌ | 仍 `npm start` |

## 回归命令

```bash
npm test
node --check desktop/ui/app.js desktop/main.cjs
cd desktop && npm start
```
