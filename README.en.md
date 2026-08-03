# 📖 PaperLens — Side-by-side Bilingual Paper Reader (Browser Extension)

[![test](https://github.com/Ys1-t/paperlens/actions/workflows/test.yml/badge.svg)](../../actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Chrome / Edge MV3](https://img.shields.io/badge/Chrome%20%2F%20Edge-MV3-brightgreen.svg)](#install)

[中文说明 → README.md](README.md)

Read research papers side by side in your browser: **original PDF on the left (layout 100% preserved)**, **live streaming translation on the right**, plus instant translation for any text you select. Runs fully locally — bring your own LLM API (OpenAI / DeepSeek / Gemini / any OpenAI-compatible proxy).

```
┌─────────────────┬──────────────────┐
│  Original PDF    │  Translation      │
│  (PDF.js render, │  # Heading        │
│   exact layout)  │  paragraphs…      │
│  [Figure 1]      │  [Fig.1 caption]  │
│  ...             │  ...              │
└─────────────────┴──────────────────┘
        ↕  linked scrolling  ↕
```

## ✨ Features

- **Two-pane reading** — pristine PDF on the left, structured translation (headings, paragraphs, two-column detection) on the right.
- **Streaming vision translation** — each page is rendered to a bitmap and sent to a vision LLM; Markdown + LaTeX stream back in real time. No server, no PDF upload.
- **Formulas, tables, algorithms** — inline math stays KaTeX; trusted tables are rebuilt as semantic HTML; algorithm blocks keep line numbers and nesting.
- **Research assistant (deep-read agent)** — a multi-turn agent that consults page translations, searches the full text, extracts the outline, and reads your saved notes across papers. Answers cite clickable "page N" evidence. 15 one-click skills: TL;DR, method breakdown, experiments, critical reading, reviewer view, reproduction checklist, related work, BibTeX / GB/T 7714 / APA citations, lab-meeting script, glossary, notation table, and more.
- **Snip-to-ask** — drag a rectangle over any figure / formula / paragraph on the PDF and ask the assistant about that exact crop.
- **Outline sidebar** — auto-generated from translated headings; click to jump; highlights the current section as you scroll.
- **Select-to-translate** — select any text on the PDF for an instant translation popover.
- **Terminology lock** — pin a translation for a term once; it is enforced across the whole paper and future papers.
- **Reading resume + recent library** — remembers where you left off in every paper; reopen recent papers from the toolbar popup.
- **Usage stats** — estimated token usage and cost tracking with your own per-million prices.
- **Keyboard-first** — `J`/`K` pages, `O` outline, `A` assistant, `S` snip, `?` help.
- **Multi-provider profiles** — save multiple Base URL / API key / model combos and switch anywhere; translations are cached locally in IndexedDB.

## 🚀 Install

1. **Get the code** — grab the latest `paperlens-<version>.zip` from [Releases](https://github.com/Ys1-t/paperlens/releases) and unzip it; or **Code → Download ZIP**; or `git clone https://github.com/Ys1-t/paperlens.git`.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).
5. Click the toolbar icon → ⚙ Settings → pick a provider preset, paste your **API key**, hit **Test connection**, then **Save**.

> Requires a **vision-capable model** (e.g. `gemini-2.5-flash`, `gpt-4o-mini`). Text-only models cannot translate pages.

| Provider | Base URL | Example model |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| OpenAI-compatible proxy | your proxy URL (usually ends with `/v1`) | `gpt-4o-mini`, `gemini-2.5-flash`… |
| Gemini (native) | `https://generativelanguage.googleapis.com/v1beta` | `gemini-2.5-flash` |

## 📄 Usage

- **Online PDF**: on arXiv or any `.pdf` page, click the extension icon → "Translate this PDF".
- **Local PDF**: icon → "Open local PDF", or drag a file into the reader.
- **Ask about a region**: toolbar "框选" (snip) or press `S`, drag over the PDF, type your question.
- Double-click a translated block to locate the original on the left; `?` shows all shortcuts.

## 🧪 Development

```bash
npm test    # Node built-in test runner, no dependencies
npm run pack  # build dist/paperlens-<version>.zip
```

Plain ES modules, no build step. See [docs/TECHNICAL.md](docs/TECHNICAL.md) (中文) for architecture notes.

## 🔒 Privacy

Your API key lives in `chrome.storage.local` and is sent only to the endpoint you configure. Nothing else leaves your browser.

## 📜 License

[MIT](LICENSE). Bundled vendor libraries keep their own licenses: [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0), [KaTeX](https://katex.org/) (MIT), [marked](https://github.com/markedjs/marked) (MIT).
