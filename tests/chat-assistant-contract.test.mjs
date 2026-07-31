import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ASK_AI_INTENTS,
  CHAT_HISTORY_MAX_MESSAGES,
  buildAskAiQuestion,
  buildChatMessages,
  chatSystemPrompt,
  composeUserMessageWithQuote,
  conversationExportFilename,
  defaultChatStarterPrompts,
  defaultPageImageQuestion,
  exportConversationMarkdown,
  formatSelectionQuotePreview,
  hasSendableChatTurn,
  isAskableSelectionText,
  normalizeChatText,
  toGeminiChatParts,
  toOpenAiChatContent,
} from '../src/lib/chat-assistant.js';
import { DEFAULT_CONFIG } from '../src/lib/config.js';

const viewerSource = readFileSync(new URL('../src/viewer/viewer.js', import.meta.url), 'utf8');
const viewerHtml = readFileSync(new URL('../src/viewer/viewer.html', import.meta.url), 'utf8');
const viewerCss = readFileSync(new URL('../src/viewer/viewer.css', import.meta.url), 'utf8');
const chatPanelSource = readFileSync(new URL('../src/viewer/chat-panel.js', import.meta.url), 'utf8');
const translatorSource = readFileSync(new URL('../src/lib/translator.js', import.meta.url), 'utf8');
const serviceWorkerSource = readFileSync(
  new URL('../src/background/service-worker.js', import.meta.url),
  'utf8',
);
const optionsHtml = readFileSync(new URL('../src/options/options.html', import.meta.url), 'utf8');
const optionsSource = readFileSync(new URL('../src/options/options.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// 纯逻辑：system prompt、消息拼装、选中即问
// ---------------------------------------------------------------------------

test('chat system prompt frames the paper-reading assistant and target language', () => {
  const prompt = chatSystemPrompt('简体中文');
  assert.match(prompt, /科研助手|AI 助手/);
  assert.match(prompt, /学术论文/);
  assert.match(prompt, /始终用简体中文回答/);
  assert.match(prompt, /解释专业术语/);
  const english = chatSystemPrompt('English');
  assert.match(english, /始终用English回答/);
});

test('chat text is normalized and clamped to the message limit', () => {
  assert.equal(normalizeChatText('  hello \r\n world  '), 'hello \n world');
  assert.equal(normalizeChatText(null), '');
  assert.equal(normalizeChatText('x'.repeat(20), { maxChars: 5 }), 'xxxxx');
});

test('buildChatMessages puts system first and drops empty placeholders', () => {
  const messages = buildChatMessages([
    { role: 'user', content: '什么是 Pareto 前沿？' },
    { role: 'assistant', content: '' },
  ], { targetLang: '简体中文' });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /科研助手|AI 助手/);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].role, 'user');
  assert.equal(messages[1].content, '什么是 Pareto 前沿？');
});

test('buildChatMessages keeps only the most recent turns within the cap', () => {
  const history = [];
  for (let i = 0; i < CHAT_HISTORY_MAX_MESSAGES + 6; i += 1) {
    history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` });
  }
  const messages = buildChatMessages(history, { maxMessages: CHAT_HISTORY_MAX_MESSAGES });
  assert.equal(messages[0].role, 'system');
  assert.equal(messages.length, CHAT_HISTORY_MAX_MESSAGES + 1);
  assert.equal(messages.at(-1).content, `m${history.length - 1}`);
});

test('buildChatMessages honors a custom system prompt override', () => {
  const messages = buildChatMessages([{ role: 'user', content: 'hi' }], {
    systemPrompt: '  自定义提示  ',
  });
  assert.equal(messages[0].content, '自定义提示');
});

test('ask-ai question quotes the selection and folds in context', () => {
  const question = buildAskAiQuestion('the Pareto front', { context: 'We study the Pareto front of this problem.' });
  assert.match(question, /^请解释这段内容：/);
  assert.match(question, /“the Pareto front”/);
  assert.match(question, /上下文参考：We study the Pareto front of this problem\./);
});

test('ask-ai question without context stays a single quoted excerpt', () => {
  const question = buildAskAiQuestion('  Pareto\n set  ');
  assert.equal(question, '请解释这段内容：\n\n“Pareto set”');
  assert.equal(buildAskAiQuestion('   '), '');
});

test('ask-ai supports plain/why intents and custom leaves the question empty', () => {
  assert.match(buildAskAiQuestion('x', { intent: ASK_AI_INTENTS.plain }), /通俗白话/);
  assert.match(buildAskAiQuestion('x', { intent: ASK_AI_INTENTS.why }), /论证什么/);
  assert.equal(buildAskAiQuestion('x', { intent: ASK_AI_INTENTS.custom }), '');
  assert.equal(isAskableSelectionText('θ'), true);
  assert.equal(isAskableSelectionText('…'), false);
});

test('composeUserMessageWithQuote attaches selection under a free-form question', () => {
  const text = composeUserMessageWithQuote({
    question: '这和 baseline 差在哪？',
    selection: 'Pareto front',
    context: 'We study the Pareto front.',
  });
  assert.match(text, /关于下面这段内容/);
  assert.match(text, /“Pareto front”/);
  assert.match(text, /这和 baseline 差在哪？/);
  assert.equal(
    composeUserMessageWithQuote({ question: '只有问题' }),
    '只有问题',
  );
});

test('quote preview and starter prompts are user-facing helpers', () => {
  assert.match(formatSelectionQuotePreview('a'.repeat(100)), /…/);
  assert.ok(defaultChatStarterPrompts().length >= 2);
});

test('hasSendableChatTurn requires at least one non-empty user message', () => {
  assert.equal(hasSendableChatTurn([{ role: 'system', content: 'x' }]), false);
  assert.equal(hasSendableChatTurn([{ role: 'user', content: '  ' }]), false);
  assert.equal(hasSendableChatTurn([{ role: 'user', content: 'hi' }]), true);
  assert.equal(hasSendableChatTurn([{
    role: 'user',
    content: '',
    images: ['data:image/jpeg;base64,abc'],
  }]), true);
});

test('buildChatMessages keeps recent page images and drops older ones with a note', () => {
  const img = (n) => `data:image/jpeg;base64,${'A'.repeat(8)}${n}`;
  const messages = buildChatMessages([
    { role: 'user', content: 'page1', images: [img(1)], pageNum: 1 },
    { role: 'assistant', content: 'ok1' },
    { role: 'user', content: 'page2', images: [img(2)], pageNum: 2 },
    { role: 'assistant', content: 'ok2' },
    { role: 'user', content: 'page3', images: [img(3)], pageNum: 3 },
  ], { maxImages: 2 });
  const users = messages.filter((m) => m.role === 'user');
  assert.equal(users.length, 3);
  assert.equal(users[0].images, undefined);
  assert.match(users[0].content, /第 1 页截图/);
  assert.ok(users[1].images?.length === 1);
  assert.ok(users[2].images?.length === 1);
});

test('OpenAI/Gemini serializers emit multimodal parts for page images', () => {
  const message = {
    role: 'user',
    content: '这页在说什么？',
    images: ['data:image/jpeg;base64,QUJD'],
    pageNum: 4,
  };
  const openAi = toOpenAiChatContent(message);
  assert.ok(Array.isArray(openAi));
  assert.equal(openAi[0].type, 'text');
  assert.equal(openAi[1].type, 'image_url');
  const gemini = toGeminiChatParts(message);
  assert.equal(gemini[0].text, '这页在说什么？');
  assert.equal(gemini[1].inlineData.mimeType, 'image/jpeg');
  assert.equal(gemini[1].inlineData.data, 'QUJD');
  assert.match(defaultPageImageQuestion(7), /第 7 页/);
});

test('exportConversationMarkdown writes readable transcript without base64 blobs', () => {
  const md = exportConversationMarkdown([
    { role: 'user', content: '你好', images: ['data:image/jpeg;base64,xx'], pageNum: 2 },
    {
      role: 'assistant',
      content: '这是回答',
      evidence: {
        pages: [2],
        citedPages: [2],
        support: { score: 81, label: '证据支持强' },
        items: [{ page: 2, sourceType: 'source', heading: 'Method', snippet: 'Source evidence.' }],
      },
    },
  ], { docTitle: 'Demo.pdf', exportedAt: new Date('2026-07-21T12:00:00Z') });
  assert.match(md, /# PaperLens 对话导出/);
  assert.match(md, /Demo\.pdf/);
  assert.match(md, /第 2 页/);
  assert.doesNotMatch(md, /base64,xx/);
  assert.match(md, /这是回答/);
  assert.match(md, /证据溯源/);
  assert.match(md, /证据支持度：81%/);
  assert.match(md, /E1 · 第 2 页 · PDF 原文/);
  assert.match(conversationExportFilename({ docTitle: 'A/B:C.pdf', now: new Date('2026-07-21T12:00:00Z') }), /\.md$/);
});

// ---------------------------------------------------------------------------
// 配置与设置页
// ---------------------------------------------------------------------------

test('chatAssistant defaults to enabled', () => {
  assert.equal(DEFAULT_CONFIG.chatAssistant, true);
});

test('options page exposes the chat assistant toggle as a global check', () => {
  assert.match(optionsHtml, /<input type="checkbox" id="chatAssistant"/);
  assert.match(optionsSource, /GLOBAL_CHECKS = \[[^\]]*'chatAssistant'[^\]]*\]/);
});

// ---------------------------------------------------------------------------
// translator 多轮 chat
// ---------------------------------------------------------------------------

test('translator exports a multi-turn chat that reuses the SSE parser', () => {
  assert.match(translatorSource, /export async function chat\(\{ config, messages, onDelta, onStatus, signal \}\)/);
  assert.match(translatorSource, /chat\/completions/);
  assert.match(translatorSource, /serializeOpenAiChatMessage/);
  assert.match(translatorSource, /serializeGeminiChatMessage/);
  assert.match(translatorSource, /image_url/);
  assert.match(translatorSource, /inlineData/);
});

// ---------------------------------------------------------------------------
// service worker：chat 路由，且不碰共享缓存
// ---------------------------------------------------------------------------

test('service worker routes the chat message type to a cache-free handler', () => {
  assert.match(serviceWorkerSource, /if \(msg\.type === 'chat'\) \{[\s\S]*?handleChat\(port, msg, requests\);/);
  assert.match(serviceWorkerSource, /async function handleChat\(port, msg, requests\)/);
  assert.match(serviceWorkerSource, /const full = await chat\(\{/);
  assert.match(serviceWorkerSource, /m\.images/);
  assert.match(serviceWorkerSource, /loadChatConfig/);
  // handleChat 内不得出现缓存读写。
  const handlerStart = serviceWorkerSource.indexOf('async function handleChat(');
  const handlerEnd = serviceWorkerSource.indexOf('function safeError(', handlerStart);
  const handlerBody = serviceWorkerSource.slice(handlerStart, handlerEnd);
  assert.doesNotMatch(handlerBody, /cacheGet|cacheSet/);
});

// ---------------------------------------------------------------------------
// viewer / chat-panel 源码契约
// ---------------------------------------------------------------------------

test('viewer sends chat over the dedicated chat port message', () => {
  assert.match(viewerSource, /this\.port\.postMessage\(\{ type: 'chat', id, messages \}\)/);
  assert.match(viewerSource, /createChatPanel\(\{/);
  assert.match(viewerSource, /els\.btnChat\.addEventListener\('click', \(\) => chatPanel\.toggle\(\)\)/);
});

test('toolbar exposes a chat entry and the panel is default-collapsed markup', () => {
  assert.match(viewerHtml, /id="btn-chat"[^>]*class="text-btn chat-btn"/);
  assert.match(chatPanelSource, /root\.hidden = true;/);
  assert.match(chatPanelSource, /PANEL_OPEN_STORAGE_KEY/);
});

test('selection popover adds an ask-ai button wired to the chat panel', () => {
  assert.match(viewerSource, /askBtn\.className = 'selection-ask-ai'/);
  assert.match(viewerSource, /chatPanel\.askAi\(selected, \{[\s\S]*intent:\s*'explain'/);
  assert.match(viewerSource, /selection-ask-ai-secondary/);
  assert.match(viewerSource, /intent:\s*'custom'/);
});

test('right panel and chat bubbles support select-to-ask', () => {
  assert.match(viewerSource, /syncPanelAskAiListener/);
  assert.match(viewerSource, /maybeShowPanelAskAi/);
  assert.match(viewerSource, /panel-ask-menu/);
  assert.match(chatPanelSource, /handleMessageSelection/);
  assert.match(chatPanelSource, /chat-selection-menu/);
  assert.match(chatPanelSource, /ASK_AI_INTENTS\.custom/);
  assert.match(chatPanelSource, /setQuote/);
  assert.match(chatPanelSource, /composeUserMessageWithQuote/);
});

test('chat panel can attach the visible PDF page and export the transcript as PDF', () => {
  assert.match(viewerSource, /captureVisiblePageImageForChat/);
  assert.match(viewerSource, /capturePageImage:\s*captureVisiblePageImageForChat/);
  assert.match(chatPanelSource, /attachCurrentPageImage/);
  assert.match(chatPanelSource, /exportConversationPdf/);
  assert.match(chatPanelSource, /openPrintHtmlWindow/);
  assert.match(chatPanelSource, /buildChatPrintSections/);
  assert.match(chatPanelSource, /renderContentForPrint/);
  assert.match(chatPanelSource, /loadPrintAssets/);
  assert.match(chatPanelSource, /chat-page-btn/);
  assert.match(chatPanelSource, /chat-export/);
  assert.match(chatPanelSource, /pendingImage/);
});

test('chat panel is a research assistant with skills, notes, and deep-read agent', () => {
  assert.match(chatPanelSource, /data-mode="agent"/);
  assert.match(chatPanelSource, /startAgentRequest/);
  assert.match(chatPanelSource, /researchAgentSystemPrompt/);
  assert.match(chatPanelSource, /executeResearchTool/);
  assert.match(chatPanelSource, /parseAgentResponse/);
  assert.match(chatPanelSource, /RESEARCH_SKILLS/);
  assert.match(chatPanelSource, /runResearchSkill/);
  assert.match(chatPanelSource, /一键导读|briefing/);
  assert.match(chatPanelSource, /appendResearchNote/);
  assert.match(chatPanelSource, /linkifyPageCitationsInElement/);
  assert.match(chatPanelSource, /shouldUseResearchAgent/);
  assert.match(chatPanelSource, /buildAgentBootstrap/);
  assert.match(chatPanelSource, /assembleAgentDialogueTurns/);
  assert.match(chatPanelSource, /RESEARCH_AGENT_MAX_HISTORY_TURNS/);
  assert.match(chatPanelSource, /paperBrief|currentPageBrief/);
  assert.match(chatPanelSource, /renderToolTrail/);
  assert.match(chatPanelSource, /renderFollowUps/);
  assert.match(chatPanelSource, /buildFollowUpActions/);
  assert.match(chatPanelSource, /chat-notes-drawer/);
  assert.match(chatPanelSource, /chat-notes-obsidian|syncNotesToObsidian/);
  assert.match(chatPanelSource, /chat-notes-download/);
  assert.match(chatPanelSource, /downloadResearchNotesMd/);
  assert.match(chatPanelSource, /chat-skills/);
  assert.match(chatPanelSource, /PRIMARY_SKILL_IDS/);
  assert.match(chatPanelSource, /chat-skill-more/);
  assert.match(chatPanelSource, /chat-command-dialog/);
  assert.match(chatPanelSource, /searchResearchSkills/);
  assert.match(chatPanelSource, /toggleCommand/);
  assert.match(chatPanelSource, /aria-autocomplete="list"/);
  assert.match(chatPanelSource, /trapSkillPaletteFocus/);
  assert.match(viewerSource, /chatPanel\.toggleCommand/);
  assert.match(viewerCss, /\.chat-command-option/);
  assert.match(chatPanelSource, /paperlens\.chatPanel\.skillsExpanded/);
  assert.match(viewerCss, /\.chat-skill-more/);
  assert.match(viewerCss, /\.chat-tool-trail/);
  assert.match(viewerCss, /\.chat-followup-chip/);
  assert.match(chatPanelSource, /PANEL_WIDTH_DEFAULT/);
  assert.match(chatPanelSource, /PANEL_GEOM_STORAGE_KEY|setupFloatingWindow/);
  assert.match(chatPanelSource, /applyGeometry/);
  assert.match(chatPanelSource, /chat-resize-se|data-edge/);
  assert.match(viewerCss, /--chat-panel-width/);
  assert.match(viewerCss, /--chat-panel-height/);
  assert.match(viewerCss, /\.chat-resize/);
  assert.match(viewerCss, /\.chat-skill-chip/);
  assert.match(viewerCss, /\.chat-page-cite/);
  assert.match(viewerSource, /paperTools/);
  assert.match(viewerSource, /getPaperMeta\(\)/);
  assert.match(viewerSource, /gotoPage\(/);
  assert.match(viewerSource, /getCurrentPage\(\)/);
  assert.match(viewerSource, /searchPaper\(/);
  assert.match(viewerSource, /listPages\(\)/);
  assert.match(viewerSource, /getOutline\(\)/);
  assert.match(viewerSource, /getMyNotes\(\)/);
  assert.match(viewerSource, /searchMyNotes\(/);
  assert.match(viewerSource, /from '\.\.\/lib\/research-skills\.js'/);
  assert.match(viewerSource, /function chatDocKey\(\)/);
  assert.match(viewerSource, /exportDocumentTranslation/);
  assert.match(viewerSource, /pageExportRenderedHtml/);
  assert.match(viewerSource, /buildDocumentPrintSections/);
  assert.match(viewerSource, /loadPrintAssets/);
  assert.match(viewerHtml, /导出全文译文为 PDF|>导出</);
});

test('research assistant is evidence-first and respects long-answer reading position', () => {
  assert.match(viewerSource, /retrieveEvidence\(query/);
  assert.match(viewerSource, /createPaperSearchIndex/);
  assert.match(chatPanelSource, /buildContextualEvidenceQuery/);
  assert.match(chatPanelSource, /buildAgentBootstrap\(paperTools, \{ query: evidenceQuery \}\)/);
  assert.match(chatPanelSource, /auditAnswerCitations/);
  assert.match(chatPanelSource, /renderEvidenceMeta/);
  assert.match(chatPanelSource, /chat-evidence-meta/);
  assert.match(chatPanelSource, /chat-evidence-details/);
  assert.match(chatPanelSource, /aria-expanded/);
  assert.match(chatPanelSource, /证据支持度/);
  assert.match(chatPanelSource, /contentWithEvidenceProvenance/);
  assert.match(chatPanelSource, /exportConversationMd/);
  assert.match(chatPanelSource, /chat-scroll-bottom/);
  assert.match(chatPanelSource, /autoScrollPaused/);
  assert.match(chatPanelSource, /quickPaperContext/);
  assert.match(viewerCss, /\.chat-evidence-meta/);
  assert.match(viewerCss, /\.chat-evidence-item/);
  assert.match(viewerCss, /\.chat-evidence-toggle/);
  assert.match(viewerCss, /\.chat-scroll-bottom/);
  assert.match(viewerCss, /--chat-paper/);
});

test('glossary term-locking is wired through viewer, background and options', () => {
  // 划词浮层的「锁定术语」按钮
  assert.match(viewerSource, /selection-lock-term/);
  assert.match(viewerSource, /upsertGlossaryTerm/);
  assert.match(viewerCss, /\.selection-lock-term/);
  // 后台把术语表挂到翻译配置：整页视觉注入全表，文本请求按命中过滤
  assert.match(serviceWorkerSource, /loadGlossary\(\)/);
  assert.match(serviceWorkerSource, /glossaryTermsInText\(/);
  assert.match(serviceWorkerSource, /cfg\.glossary/);
  assert.match(translatorSource, /appendGlossaryPrompt/);
  // 设置页术语表管理
  assert.match(optionsHtml, /section-glossary/);
  assert.match(optionsHtml, /glossary-add-btn/);
  assert.match(optionsSource, /renderGlossary/);
  assert.match(optionsSource, /removeGlossaryTerm/);
});

test('usage accounting is wired through background and options', () => {
  // 翻译与对话完成后都累计估算用量；统计失败静默不影响主流程
  assert.match(serviceWorkerSource, /addUsageSample\(/);
  assert.match(serviceWorkerSource, /estimateRequestTokens\(/);
  assert.match(optionsHtml, /section-usage/);
  assert.match(optionsHtml, /usage-reset/);
  assert.match(optionsSource, /renderUsageStats/);
  assert.match(optionsSource, /resetUsageStats/);
  assert.match(optionsSource, /estimateCost/);
});

test('outline sidebar styles ship with the viewer', () => {
  assert.match(viewerCss, /\.outline-panel/);
  assert.match(viewerCss, /\.outline-item\.is-active/);
  assert.match(viewerCss, /\.outline-empty/);
});

test('onboarding card styles ship with the viewer', () => {
  assert.match(viewerCss, /\.onboarding-card/);
  assert.match(viewerCss, /\.onboarding-close/);
});

test('region snip-to-ask is wired: overlay, crop, chat attach', () => {
  // 工具栏「框选」→ 十字光标拖矩形 → 相交页高清重渲裁剪 → 附到助手
  assert.match(viewerSource, /startSnipMode\(/);
  assert.match(viewerSource, /snipToChat\(/);
  assert.match(viewerSource, /snip-overlay/);
  assert.match(viewerSource, /chatPanel\.setPageImage\(/);
  assert.match(viewerCss, /\.snip-rect/);
  assert.match(viewerCss, /\.snip-overlay/);
});

test('chat panel persists sessions and exposes a history drawer', () => {
  assert.match(chatPanelSource, /putChatSession/);
  assert.match(chatPanelSource, /listChatSessions/);
  assert.match(chatPanelSource, /chat-history-drawer/);
  assert.match(chatPanelSource, /startNewConversation/);
  assert.match(chatPanelSource, /openHistorySession/);
  assert.match(viewerSource, /getDocKey:/);
  assert.match(viewerCss, /\.chat-history-item/);
});

test('chat panel supports Enter-to-send with Shift+Enter newline and streaming render', () => {
  assert.match(chatPanelSource, /event\.key === 'Enter' && !event\.shiftKey && !event\.isComposing/);
  assert.match(chatPanelSource, /renderAssistantContent\(bubble\.textEl, streamed\)/);
  assert.match(chatPanelSource, /sendChat\.cancel\?\.\(activeRequestId\)/);
  assert.match(chatPanelSource, /chat-msg-action/);
  assert.match(chatPanelSource, /retryAssistantEntry/);
});

test('disabling chatAssistant hides the entry and collapses the panel', () => {
  assert.match(viewerSource, /syncChatAssistant\(config\?\.chatAssistant !== false\)/);
  assert.match(viewerSource, /els\.btnChat\.hidden = !enabled;/);
  assert.match(viewerSource, /if \(!enabled\) \{[\s\S]*chatPanel\.setOpen\(false\)/);
  assert.match(viewerSource, /syncPanelAskAiListener\(false\)/);
});

// ---------------------------------------------------------------------------
// 样式契约
// ---------------------------------------------------------------------------

test('chat panel is a floating movable/resizable window over the reader', () => {
  // Floating card (not a full-height right dock).
  assert.match(viewerCss, /\.chat-panel \{[\s\S]*?border-radius:\s*18px/);
  assert.match(viewerCss, /\.chat-panel \{[\s\S]*?position:\s*fixed/);
  assert.match(viewerCss, /--chat-panel-height/);
  assert.match(viewerCss, /\.chat-resize-se/);
  assert.match(viewerCss, /\.chat-head \{[\s\S]*?cursor:\s*grab/);
  assert.match(viewerCss, /@media \(prefers-reduced-motion: no-preference\)[\s\S]*?chatFloatIn/);
  assert.doesNotMatch(viewerCss, /transform:\s*translateX\(100%\)/);
  assert.match(chatPanelSource, /setupFloatingWindow/);
  assert.match(chatPanelSource, /is-dragging|chat-panel-dragging/);
  assert.match(chatPanelSource, /writeGeometry|PANEL_GEOM_STORAGE_KEY/);
  assert.match(viewerCss, /\.selection-ask-ai \{/);
  assert.match(viewerCss, /\.chat-selection-menu/);
  assert.match(viewerCss, /\.chat-quote/);
  assert.match(viewerCss, /\.panel-ask-menu/);
  assert.match(viewerCss, /\.chat-starter-chip/);
  assert.match(viewerCss, /\.chat-page-btn/);
  assert.match(viewerCss, /\.chat-page-thumb/);
  assert.match(viewerCss, /\.chat-export|\.chat-tool-btn/);
  assert.match(viewerCss, /\.chat-avatar/);
  assert.match(viewerCss, /\.chat-composer/);
  assert.match(viewerCss, /\.chat-empty-hero/);
  assert.match(chatPanelSource, /chat-empty-hero/);
  assert.match(chatPanelSource, /chat-composer/);
});
