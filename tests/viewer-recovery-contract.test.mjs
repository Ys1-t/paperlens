import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const viewerSource = await readFile(new URL('../src/viewer/viewer.js', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../src/viewer/viewer.css', import.meta.url), 'utf8');
const serviceWorkerSource = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
const buildInfoSource = await readFile(new URL('../src/lib/build-info.js', import.meta.url), 'utf8');

function functionBody(name) {
  const asyncStart = viewerSource.indexOf(`async function ${name}(`);
  const plainStart = viewerSource.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? plainStart : asyncStart;
  assert.notEqual(start, -1, `missing ${name}()`);
  const brace = viewerSource.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < viewerSource.length; index += 1) {
    if (viewerSource[index] === '{') depth += 1;
    if (viewerSource[index] === '}') depth -= 1;
    if (depth === 0) return viewerSource.slice(start, index + 1);
  }
  assert.fail(`could not parse ${name}()`);
}

test('viewer expands stable reading-unit changes before retrying only unresolved units', () => {
  const body = functionBody('translatePageStructured');
  const inspectIndex = body.indexOf('const inspection = accumulator.finish(finalText)');
  const applyIndex = body.indexOf('applyChanges(inspection.changes)');
  const retryIndex = body.indexOf('retryNodeItemsOnce({');

  assert.match(viewerSource, /from ['"]\.\.\/lib\/node-translation\.js['"]/);
  assert.ok(inspectIndex >= 0 && applyIndex > inspectIndex, 'validated node changes must land before retry');
  assert.ok(retryIndex > inspectIndex, 'only inspected retry items may enter local recovery');
  assert.match(body, /createReadingTranslationPlan/);
  assert.match(body, /expandReadingTranslationChange/);
  assert.match(body, /createNodeTranslationBatches\(firstUnresolvedItems/);
  assert.match(body, /items:\s*batch/);
  assert.doesNotMatch(body, /@@@BLK@@@/);
});

test('viewer runs bounded local-recovery batches and tracks every cancellable request', () => {
  const body = functionBody('translatePageStructured');
  assert.equal((body.match(/retryNodeItemsOnce\s*\(/g) || []).length, 1);
  assert.equal((body.match(/mapNodeTranslationBatches\s*\(/g) || []).length, 2);
  assert.match(body, /isCurrent:\s*isCurrentDocumentPageRequest/);
  assert.match(body, /concurrency:\s*NODE_TRANSLATION_BATCH_CONCURRENCY/);
  assert.match(body, /onRequestId:\s*\(retryId\)\s*=>\s*\{[\s\S]*?trackPageTranslationRequest\(p,\s*retryId\)/);
  assert.match(body, /bypassCache:\s*true/);

  const reset = functionBody('resetDocumentState');
  assert.match(reset, /cancelPageTranslationRequests\(page\)/);
  assert.match(functionBody('cancelPageTranslationRequests'), /translationRequestIds[\s\S]*client\.cancel\(id\)/);
});

test('local retry bypasses damaged cache and only reusable structured results are cached', () => {
  assert.match(viewerSource, /translateNodes\(text, onDelta, onStatus/);
  assert.match(viewerSource, /postMessage\(\{[\s\S]*?bypassCache[\s\S]*?\}\)/);
  // v0.8.22：划词 priority 请求也绕过缓存读取（不读不写），bypassCache 语义不变。
  assert.match(serviceWorkerSource, /if\s*\(!bypassCache\s*&&\s*!msg\.priority\)\s*\{[\s\S]*?cacheGet/);
  assert.match(serviceWorkerSource, /isCacheableNodeTranslation/);
  assert.match(serviceWorkerSource, /cacheSet\(cacheKeyFor\(cfg, payload\), full\)/);
});

test('formula OCR uses the current v6 cache namespace', () => {
  assert.match(serviceWorkerSource, /FORMULA:v6:/);
  assert.match(serviceWorkerSource, /FORMULA_BATCH:v6:/);
  assert.doesNotMatch(serviceWorkerSource, /FORMULA(?:_BATCH)?:v[1-5]:/);
  assert.match(serviceWorkerSource, /parseFormulaTranscription/);
  assert.match(serviceWorkerSource, /parseFormulaBatchTranscription/);
  assert.match(serviceWorkerSource, /parsed\.rejectedIds\.length\s*===\s*0/);
});

test('source-only structured spans leave the loading state without a provider request', () => {
  const settle = functionBody('settleStructuredSourceOnlyNodes');
  const translate = functionBody('translatePageStructured');
  assert.match(settle, /item\.textSlots/);
  assert.match(settle, /p\.sourceTextById/);
  assert.match(settle, /updateStructuredTextNode\(p\.nodeEls,\s*id,\s*sourceText\)/);
  assert.match(translate, /mountStructuredPage\(p,\s*plan\.page\)[\s\S]*settleStructuredSourceOnlyNodes\(p,\s*plan\.items\)/);
});

test('page scheduling is vision-only after the local layout service removal', () => {
  const body = functionBody('runScheduledPage');
  assert.match(body, /await translatePageVision\(page\)/);
  assert.doesNotMatch(body, /layoutSessionMode|layoutBootstrapPromise|pageIr/);
  assert.doesNotMatch(viewerSource, /from ['"]\.\.\/lib\/layout\.js['"]/);
});

test('vision failures retry at higher resolution while ordinary pages stay bounded', () => {
  const translate = functionBody('translatePageVision');
  const render = functionBody('renderPageImage');
  assert.match(translate, /selectVisionRenderWidth\(\{ sourceChars, qualityRetry \}\)/);
  assert.match(translate, /renderPageImage\(p, renderWidth\)/);
  assert.ok(translate.indexOf('sourceTextHint') < translate.indexOf('renderPageImage(p, renderWidth)'));
  assert.match(render, /Math\.min\(3\.5, safeTargetWidth \/ base\.width\)/);
  assert.match(render, /safeTargetWidth >= 1900 \? 0\.9 : 0\.86/);
});

test('vision quality retries never hide an already readable translation draft', () => {
  const translate = functionBody('translatePageVision');
  const presentDraft = functionBody('presentVisionQualityDraft');
  const retainDraft = functionBody('retainVisionQualityDraftAfterRetry');

  assert.match(translate, /const preserveVisibleDraft = Boolean\(preservedDraft\)/);
  assert.match(translate, /if \(!preserveVisibleDraft\) renderGate\.schedule\(\)/);
  assert.match(translate, /presentVisionQualityDraft\(p, preserveVisibleDraft \? preservedDraft : raw/);
  assert.match(translate, /retainVisionQualityDraftAfterRetry\(p,/);
  assert.doesNotMatch(presentDraft, /mdEl\.textContent/);
  assert.match(presentDraft, /if \(!draft\)[\s\S]*failPage\(p, quality\?\.message/);
  assert.match(presentDraft, /p\.translationText = draft/);
  assert.match(presentDraft, /if \(!shouldAutoRefineVisionQuality\(quality\)\)/);
  assert.match(presentDraft, /p\.visionQualityAdvisory = quality/);
  assert.match(presentDraft, /vision-quality-notice/);
  assert.match(presentDraft, /vision-quality-draft/);
  assert.match(presentDraft, /markPageOutcome\(p, 'done'\)/);
  assert.match(presentDraft, /markPageOutcome\(p, 'partial'\)/);
  assert.match(presentDraft, /scheduleSmartPageRetry\(p, retryReason\)/);
  assert.match(retainDraft, /String\(p\?\.translationText/);
  assert.match(retainDraft, /markPageOutcome\(p, 'partial'\)/);
  assert.match(cssSource, /\.vision-quality-notice[\s\S]*\.vision-quality-title/);
});

test('viewer and service worker share a versioned port and build handshake', () => {
  assert.match(buildInfoSource, /PAPERLENS_BUILD_ID/);
  assert.match(buildInfoSource, /TRANSLATION_PORT_NAME/);
  assert.match(viewerSource, /connect\(\{\s*name:\s*TRANSLATION_PORT_NAME\s*\}\)/);
  assert.match(viewerSource, /onDisconnect\.addListener\(\(\)\s*=>\s*\{[\s\S]*?readRuntimeLastErrorMessage\(\)/);
  assert.match(functionBody('readRuntimeLastErrorMessage'), /chrome\.runtime\.lastError/);
  assert.match(functionBody('isExpectedExtensionReloadError'), /extension context invalidated/i);
  assert.match(serviceWorkerSource, /port\.name\s*!==\s*TRANSLATION_PORT_NAME/);
  assert.match(serviceWorkerSource, /type:\s*['"]pong['"][\s\S]*buildId:\s*PAPERLENS_BUILD_ID/);
  assert.match(functionBody('checkBackend'), /message\?\.buildId\s*!==\s*PAPERLENS_BUILD_ID/);
});

// 标签页冻结期间 SW 被回收时 onDisconnect 可能永远不送达：死端口只在下一次
// postMessage 时以同步抛错暴露。守卫必须把它转成统一断开清理 + 重连 + 可
// 自动重试的连接类错误，而不是让原生英文错误直达页面且重试永远失败。
test('dead translation ports recover through the postMessage guard instead of failing forever', () => {
  // 守卫端口：postMessage 同步抛错 → _dropPort 统一清理。
  assert.match(viewerSource, /postMessage:\s*\(message\)\s*=>\s*\{[\s\S]*?raw\.postMessage\(message\);[\s\S]*?\}\s*catch\s*\(error\)\s*\{[\s\S]*?this\._dropPort\(/);
  // 迟到的旧端口 onDisconnect 不得清理新端口状态。
  assert.match(viewerSource, /if\s*\(this\.port\s*!==\s*guarded\)\s*return;/);
  // _dropPort 双路径共用：拒绝在途请求、置空端口、调度重连，并返回连接错误。
  assert.match(viewerSource, /_dropPort\(portRef, rawMessage, source\)\s*\{[\s\S]*?this\.port = null;[\s\S]*?h\.reject\(err\)[\s\S]*?this\._scheduleReconnect\(\);[\s\S]*?return err;/);
  // 死端口的原生错误文本必须归类为「后台刚刚重载」可自动重试错误。
  assert.match(functionBody('extensionConnectionError'), /disconnected port/);
  assert.match(functionBody('isExpectedExtensionReloadError'), /disconnected port/);
  // 回到前台 / 解冻时主动探活，让死端口立即暴露并触发重连 + 自动重试。
  assert.match(viewerSource, /visibilitychange[\s\S]{0,200}?probeBackgroundPort\(\)/);
  assert.match(viewerSource, /addEventListener\('resume',\s*\(\)\s*=>\s*probeBackgroundPort\(\)\)/);
  // 重连失败使用指数退避而不是一次放弃。
  assert.match(viewerSource, /Math\.min\(5000,\s*450\s*\*\s*\(2\s*\*\*\s*attempt\)\)/);
  assert.match(viewerSource, /this\._reconnectAttempts\s*<=\s*8/);
});

test('typed retries cancel stale formula work and global retry includes formula failures', () => {
  const translate = functionBody('translatePageStructured');
  assert.match(translate, /for\s*\(const id of p\.formulaRequestIds\s*\|\|\s*\[\]\)\s*client\.cancel\(id\)/);
  assert.match(translate, /p\.formulaRequestIds\s*=\s*new Set\(\)/);
  const retry = functionBody('retryAllErrors');
  assert.match(retry, /formulaStates/);
  assert.match(retry, /formulaState\?\.status\s*===\s*['"]failed['"]/);
});

test('formula sprite sends source hints through both request and quality validation', () => {
  const client = functionBody('createFormulaSpriteBatches');
  const transcribe = functionBody('startStructuredFormulaTranscriptions');
  assert.match(client, /source_text:\s*String\(entry\.block\?\.source_text/);
  assert.match(transcribe, /transcribeFormulaBatch\([\s\S]*batch\.formulas/);
  assert.match(transcribe, /parseFormulaBatchTranscription\([\s\S]*batch\.formulas/);
});

test('local failures finish as retryable partial pages instead of false done pages', () => {
  const body = functionBody('translatePageStructured');
  assert.match(body, /retryTimedOut[\s\S]*\?\s*batch[\s\S]*completeStructuredPage\(combineUnresolvedItems/);
  assert.match(body, /setStructuredStatus\(p,\s*warningText,\s*false\)/);
  assert.match(body, /markPageOutcome\(p,\s*unresolvedItems\.length\s*\?\s*['"]partial['"]\s*:\s*['"]done['"]\)/);
  assert.match(functionBody('retryAllErrors'), /translationOutcome\s*===\s*['"]partial['"]/);
  assert.doesNotMatch(body, /math_placeholder_validation|行内公式占位符被更改/);
});

test('first-pass batches preserve partial stream output and isolate transport failure recovery', () => {
  const body = functionBody('translatePageStructured');
  assert.match(body, /const requestBatches = createNodeTranslationBatches\(requestItems\)/);
  assert.match(body, /const partial = accumulator\.finish\(accumulator\.raw\)/);
  assert.match(body, /unresolvedItems:\s*unresolvedReadingItems\([\s\S]*?batch/);
  assert.match(body, /queuePriority:[\s\S]*?20 - batchIndex/);
  assert.match(body, /shouldContinueNodeBatches/);
});

test('manual partial-page retry sends only unresolved reading-unit IDs', () => {
  const body = functionBody('translatePageStructured');
  assert.match(body, /translationOutcome\s*===\s*['"]partial['"]/);
  assert.match(body, /new Set\(p\.unresolvedTranslationUnitIds\s*\|\|\s*\[\]\)/);
  assert.match(body, /plan\.items\.filter\(\(item\)\s*=>\s*partialIds\.has\(item\.id\)\)/);
});

test('partial recovery uses one compact page-level status and no per-block warning badges', () => {
  const body = functionBody('readingRecoveryFailureText');
  const completeBody = functionBody('translatePageStructured');
  assert.match(body, /本页有/);
  assert.match(body, /其余译文已保留/);
  assert.match(completeBody, /setStructuredStatus\(p,\s*warningText,\s*false\)/);
  assert.doesNotMatch(viewerSource, /此段译文需检查|dataset\.translationItem/);
  assert.doesNotMatch(cssSource, /\.structured-item-warning\s*\{/);
});

test('slot retries carry the optional nodeSlotRetry flag from planner to prompt selection', async () => {
  const nodeTranslationSource = await readFile(new URL('../src/lib/node-translation.js', import.meta.url), 'utf8');
  const translatorSource = await readFile(new URL('../src/lib/translator.js', import.meta.url), 'utf8');

  // retryNodeItemsOnce 只在重译计划含 formula_slots 时给传输层打标。
  assert.match(nodeTranslationSource, /nodeSlotRetry = retryPlan\.entries\.some\(\(entry\) => entry\.kind === 'formula_slots'\)/);
  assert.match(nodeTranslationSource, /\{ nodeSlotRetry \},\s*\n\s*\);/);

  // viewer 局部重译请求把标志透传给 translateNodes；普通节点请求不携带该字段。
  const body = functionBody('translatePageStructured');
  assert.match(body, /nodeSlotRetry:\s*Boolean\(retryMeta\?\.nodeSlotRetry\)/);
  assert.match(viewerSource, /\.\.\.\(nodeSlotRetry \? \{ nodeSlotRetry: true \} : \{\}\)/);
  assert.equal((viewerSource.match(/nodeSlotRetry/g) || []).length >= 4, true);

  // SW 解构新可选字段并原样转发给 translator，不改任何已有字段。
  assert.match(serviceWorkerSource, /nodeProtocol,\s*nodeSlotRetry\s*=\s*false,/);
  assert.match(serviceWorkerSource, /nodeProtocol,\s*\n\s*nodeSlotRetry,/);

  // translator 中 nodeSlotRetry 优先于 nodeProtocol 选择专用 slot prompt。
  const slotBranch = translatorSource.indexOf('if (nodeSlotRetry) return appendUserSystemPrompt(nodeSlotRetrySystemPrompt');
  const nodeBranch = translatorSource.indexOf('if (nodeProtocol) return appendUserSystemPrompt(nodeTranslationSystemPrompt');
  assert.ok(slotBranch >= 0 && nodeBranch > slotBranch, 'nodeSlotRetry branch must precede nodeProtocol');
});
