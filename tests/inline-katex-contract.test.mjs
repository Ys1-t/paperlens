import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { normalizeMathForKatex } from '../src/lib/math-normalization.js';

const viewerSource = await readFile(new URL('../src/viewer/viewer.js', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../src/viewer/viewer.css', import.meta.url), 'utf8');

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

class FakeClassList {
  constructor(host) { this.host = host; }
  add(...names) {
    const values = new Set(this.host.className.split(/\s+/).filter(Boolean));
    for (const name of names) values.add(name);
    this.host.className = [...values].join(' ');
  }
  contains(name) { return this.host.className.split(/\s+/).includes(name); }
  toggle(name, force) {
    const values = new Set(this.host.className.split(/\s+/).filter(Boolean));
    const enabled = force === undefined ? !values.has(name) : Boolean(force);
    if (enabled) values.add(name);
    else values.delete(name);
    this.host.className = [...values].join(' ');
    return enabled;
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.className = '';
    this.textContent = '';
    this.dataset = {};
    this.children = [];
    this.attributes = new Map();
    this.classList = new FakeClassList(this);
  }
  replaceChildren(...children) {
    this.children = children;
    this.textContent = '';
  }
  appendChild(child) {
    this.children.push(child);
    child.parentElement = this;
    return child;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}

function executableViewerFunction(name, dependencies) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(...names, `return (${functionBody(name)});`)(...values);
}

test('inline renderer calls KaTeX in inline mode and never writes raw formula text or HTML', () => {
  const body = functionBody('renderInlineMathHost');
  assert.match(body, /window\.katex\.render/);
  assert.match(body, /displayMode:\s*false/);
  assert.match(body, /throwOnError:\s*true/);
  assert.match(body, /strict:\s*['"]ignore['"]/);
  assert.match(body, /trustedRenderableFormulaLatex/);
  assert.match(body, /inline-formula-source/);
  assert.doesNotMatch(body, /host\.textContent\s*=\s*segment\.(?:source_text|sourceText|latex)/);
  assert.doesNotMatch(body, /innerHTML|renderToString/);
});

test('inline renderer mounts KaTeX and falls back to the authoritative crop', () => {
  const calls = [];
  const renderInlineMathHost = executableViewerFunction('renderInlineMathHost', {
    trustedRenderableFormulaLatex: () => 'f_i(x^u)',
    formulaSourceText: () => 'fi(xu)',
    window: { katex: { render: (...args) => calls.push(args) } },
    document: { createElement: (tagName) => new FakeElement(tagName) },
  });
  const host = new FakeElement();
  const segment = { latex: 'f_i(x^u)', source_text: 'fi(xu)' };

  renderInlineMathHost(host, segment);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'f_i(x^u)');
  assert.equal(calls[0][1], host);
  assert.deepEqual(calls[0][2], {
    displayMode: false,
    throwOnError: true,
    strict: 'ignore',
  });

  const failingRenderer = executableViewerFunction('renderInlineMathHost', {
    trustedRenderableFormulaLatex: () => '',
    formulaSourceText: () => 'fi(xu)',
    window: { katex: { render: () => { throw new Error('bad latex'); } } },
    document: { createElement: (tagName) => new FakeElement(tagName) },
  });
  const fallback = new FakeElement();
  failingRenderer(fallback, segment, 'data:image/png;base64,crop');
  assert.equal(fallback.textContent, '');
  assert.equal(fallback.children.length, 1);
  assert.equal(fallback.children[0].className, 'inline-formula-source');
  assert.equal(fallback.children[0].src, 'data:image/png;base64,crop');
  assert.equal(fallback.classList.contains('inline-math-source'), true);
});

test('translated Han text adds spacing only at the touching inline-math edge', () => {
  const hasHanTextBoundary = executableViewerFunction('hasHanTextBoundary', {});
  const syncInlineMathBoundarySpacing = executableViewerFunction(
    'syncInlineMathBoundarySpacing',
    { hasHanTextBoundary },
  );
  const container = new FakeElement();
  const before = new FakeElement('span');
  before.textContent = '任务数量';
  const formula = new FakeElement('span');
  formula.className = 'structured-inline-math';
  const punctuation = new FakeElement('span');
  punctuation.textContent = '；';
  container.appendChild(before);
  container.appendChild(formula);
  container.appendChild(punctuation);

  syncInlineMathBoundarySpacing(container);
  assert.equal(formula.classList.contains('inline-math-space-before'), true);
  assert.equal(formula.classList.contains('inline-math-space-after'), false);

  before.textContent = 'count ';
  punctuation.textContent = '个区域';
  syncInlineMathBoundarySpacing(container);
  assert.equal(formula.classList.contains('inline-math-space-before'), false);
  assert.equal(formula.classList.contains('inline-math-space-after'), true);
});

test('inline formula rerenders preserve computed Han-boundary spacing classes', () => {
  const renderInlineMathHost = executableViewerFunction('renderInlineMathHost', {
    trustedRenderableFormulaLatex: () => 'K',
    formulaSourceText: () => 'K',
    window: { katex: { render: () => {} } },
    document: { createElement: (tagName) => new FakeElement(tagName) },
  });
  const host = new FakeElement();
  host.className = 'structured-inline-math inline-math-space-before';

  renderInlineMathHost(host, { latex: 'K' });

  assert.equal(host.classList.contains('inline-math-space-before'), true);
  assert.equal(host.classList.contains('inline-math-space-after'), false);
});

test('paragraph renderer retains formula IDs and bboxes without mapping formula hosts as text nodes', () => {
  const body = functionBody('appendStructuredParagraphSegment');
  assert.match(body, /trustedRenderableFormulaLatex\(segment\)[\s\S]*inlineFormulaPreview\(p, segment\)/);
  assert.match(body, /renderInlineMathHost\(span, segment, preview\)/);
  assert.match(body, /structuredInlineFormulaHosts\.set\(segment\.id/);
  assert.match(body, /span\.dataset\.irId\s*=\s*segment\.id/);
  assert.match(body, /p\.irBboxes\.set\(segment\.id/);
  assert.doesNotMatch(body, /rememberStructuredText\(p, span, segment\.id,[^\n]*latex/);
});

test('display equations remain KaTeX display mode while inline math uses baseline CSS', () => {
  const body = functionBody('renderStructuredDisplayFormula');
  assert.match(body, /displayMode:\s*true/);
  assert.match(cssSource, /\.structured-inline-math\s*\{[^}]*vertical-align:\s*baseline/s);
  assert.match(cssSource, /\.structured-inline-math\.inline-math-space-before\s*\{[^}]*margin-inline-start:\s*0\.18em/s);
  assert.match(cssSource, /\.structured-inline-math\.inline-math-space-after\s*\{[^}]*margin-inline-end:\s*0\.18em/s);
  assert.match(cssSource, /\.formula-latex[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s);
  assert.match(cssSource, /\.formula-latex \.katex-display[\s\S]*?margin:\s*2px 0/s);
  assert.match(cssSource, /\.formula-number[\s\S]*?justify-self:\s*end/s);
  assert.match(cssSource, /\.inline-formula-source/);
});

test('KaTeX preflight suppresses non-fatal Unicode strict warnings but keeps parse failures', () => {
  const calls = [];
  const isKatexRenderable = executableViewerFunction('isKatexRenderable', {
    normalizeMathForKatex,
    window: { katex: { renderToString: (...args) => calls.push(args) } },
  });
  assert.equal(isKatexRenderable('\u2126 = R'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '\\Omega{} = R');
  assert.deepEqual(calls[0][1], {
    displayMode: true,
    throwOnError: true,
    strict: 'ignore',
  });

  const rejectsInvalidLatex = executableViewerFunction('isKatexRenderable', {
    normalizeMathForKatex,
    window: { katex: { renderToString: () => { throw new Error('parse error'); } } },
  });
  assert.equal(rejectsInvalidLatex('\\frac{a}{'), false);
});

test('legacy and auto-render KaTeX paths also ignore strict Unicode warning noise', () => {
  const legacy = functionBody('renderLayoutBlocks');
  const autoRender = functionBody('renderMathIn');
  assert.match(legacy, /window\.katex\.render[\s\S]*?strict:\s*['"]ignore['"]/);
  assert.match(autoRender, /strict:\s*['"]ignore['"]/);
});

test('viewer installs the global KaTeX guard before initialization', () => {
  assert.match(viewerSource, /import\s*\{[^}]*installKatexGuard[^}]*\}\s*from\s*['"]\.\.\/lib\/katex-guard\.js['"]/s);
  const guardIndex = viewerSource.indexOf('installKatexGuard(window.katex)');
  const initIndex = viewerSource.indexOf('init().catch');
  assert.ok(guardIndex >= 0 && guardIndex < initIndex);
  assert.match(viewerSource, /KG\$\{KATEX_GUARD_VERSION\}/);
});

test('viewer translates stable reading-unit IDs and expands text around immutable math DOM', () => {
  const body = functionBody('translatePageStructured');
  assert.match(body, /createReadingTranslationPlan/);
  assert.match(body, /createNodeTranslationAccumulator/);
  assert.match(body, /expandReadingTranslationChange/);
  assert.match(body, /updateStructuredTextNode/);
  assert.doesNotMatch(body, /@@@BLK@@@|recoveryChanges/);
  assert.doesNotMatch(body, /createStructuredBlock|mountStructuredPage\([^)]*\)[\s\S]*onDelta[\s\S]*replaceChildren/);
});

test('typed display formulas use a labelled sprite and retry only rejected crops individually', () => {
  const render = functionBody('renderStructuredDisplayFormula');
  const transcribe = functionBody('startStructuredFormulaTranscriptions');
  const translate = functionBody('translatePageStructured');
  assert.match(render, /structuredFormulaHosts/);
  assert.match(render, /image_ref|imageRef/);
  assert.match(render, /structured-formula-crop/);
  assert.match(render, /window\.katex\.render/);
  assert.match(transcribe, /createFormulaSpriteBatches/);
  assert.match(transcribe, /client\.transcribeFormulaBatch/);
  assert.doesNotMatch(transcribe, /client\.transcribeFormula\s*\(/);
  assert.match(transcribe, /retryStructuredFormulaTranscription/);
  assert.match(functionBody('retryStructuredFormulaTranscription'), /client\.transcribeFormula\s*\(/);
  assert.match(transcribe, /enqueueFormulaTask/);
  assert.match(transcribe, /renderStructuredDisplayFormula/);
  assert.doesNotMatch(transcribe, /entry\.block\.number\s*=/);
  assert.match(translate, /startStructuredFormulaTranscriptions\(p, generation\)/);
});

test('structured OCR keeps a model number in state without mutating the Page IR source number', async () => {
  const block = {
    id: 'eq', kind: 'display_math', image_ref: 'equation.png', number: '', latex: '',
  };
  const renderedStates = [];
  let queuedTask;
  const p = {
    num: 4,
    documentGeneration: 12,
    renderGeneration: 7,
    pageIr: { blocks: [block] },
    formulaStates: {},
    formulaRequestIds: new Set(),
    layoutImages: { 'equation.png': 'data:image/png;base64,crop' },
  };
  const startStructuredFormulaTranscriptions = executableViewerFunction(
    'startStructuredFormulaTranscriptions',
    {
      state: { documentGeneration: 12, readerMode: 'reading' },
      formulaStateKey: () => 'equation',
      trustedRenderableFormulaLatex: () => '',
      isKatexRenderable: () => true,
      findImageLoose: () => '',
      renderStructuredDisplayFormula: (page) => {
        renderedStates.push(page.formulaStates.equation?.status || '');
      },
      renderStructuredInlineFormula: () => {},
      renderStructuredFormulaEntry: (page) => {
        renderedStates.push(page.formulaStates.equation?.status || '');
      },
      inlineFormulaPreview: () => '',
      enqueueFormulaTask: (task) => {
        queuedTask = Promise.resolve().then(task);
        return queuedTask;
      },
      prepareStructuredFormulaImages: async (_page, entries) => entries,
      createFormulaSpriteBatches: async (entries) => [{
        image: 'data:image/png;base64,sprite',
        entries,
        ids: entries.map((entry) => entry.id),
        formulas: entries.map((entry) => ({ id: entry.id, source_text: '' })),
      }],
      client: {
        transcribeFormulaBatch: () => ({
          id: 'formula-request',
          promise: Promise.resolve({ full: '{"items":[]}' }),
        }),
      },
      parseFormulaBatchTranscription: () => ({
        items: [{ id: 'equation', latex: 'x^2', number: '(99)' }],
      }),
    },
  );

  startStructuredFormulaTranscriptions(p, 7);
  assert.ok(queuedTask);
  await queuedTask;

  assert.equal(block.number, '');
  assert.equal(block.latex, 'x^2');
  assert.equal(p.formulaStates.equation.status, 'done');
  assert.equal(p.formulaStates.equation.number, '(99)');
  assert.deepEqual(renderedStates, ['pending', 'running', 'done']);
  assert.equal(p.formulaRequestIds.size, 0);
});

test('an untrusted inline formula joins the page-level crop batch and becomes KaTeX', async () => {
  const segment = {
    id: 'p5-b11-m0',
    kind: 'inline_math',
    latex: '\\Vert \\nabla_{\\theta}_{k}E_{\\lambda}_{k}_{\\sim}_{\\Lambda}_{k} \\Vert^{2}',
    source_text: '∥∇θkEλk∼Λk∥2',
    bbox: [0.08, 0.63, 0.30, 0.66],
  };
  const p = {
    num: 6,
    documentGeneration: 4,
    renderGeneration: 2,
    pageIr: { blocks: [{ id: 'paragraph', kind: 'paragraph', segments: [segment] }] },
    formulaStates: {},
    formulaRequestIds: new Set(),
    layoutImages: {},
  };
  let queuedTask;
  let preparedEntry;
  let batchFormula;
  const states = [];
  const startStructuredFormulaTranscriptions = executableViewerFunction(
    'startStructuredFormulaTranscriptions',
    {
      state: { documentGeneration: 4, readerMode: 'reading' },
      formulaStateKey: (formula) => formula.id,
      trustedRenderableFormulaLatex: () => '',
      isKatexRenderable: () => true,
      findImageLoose: () => '',
      inlineFormulaPreview: () => 'data:image/png;base64,preview',
      renderStructuredDisplayFormula: () => {},
      renderStructuredInlineFormula: () => states.push(p.formulaStates[segment.id]?.status || ''),
      renderStructuredFormulaEntry: () => states.push(p.formulaStates[segment.id]?.status || ''),
      enqueueFormulaTask: (task) => {
        queuedTask = Promise.resolve().then(task);
        return queuedTask;
      },
      prepareStructuredFormulaImages: async (_page, entries) => {
        preparedEntry = entries[0];
        entries[0].image = 'data:image/png;base64,ocr-crop';
        return entries;
      },
      createFormulaSpriteBatches: async (entries) => {
        batchFormula = {
          id: entries[0].id,
          source_text: entries[0].block.source_text,
        };
        return [{
          image: 'data:image/png;base64,sprite',
          entries,
          formulas: [batchFormula],
        }];
      },
      client: {
        transcribeFormulaBatch: () => ({
          id: 'inline-formula-request',
          promise: Promise.resolve({ full: '{"items":[]}' }),
        }),
      },
      parseFormulaBatchTranscription: () => ({
        items: [{
          id: segment.id,
          latex: '\\lVert \\nabla_{\\theta_k} \\mathbb{E}_{\\lambda_k \\sim \\Lambda_k} \\rVert_2',
          number: '',
        }],
      }),
    },
  );

  startStructuredFormulaTranscriptions(p, 2);
  assert.ok(queuedTask);
  await queuedTask;

  assert.equal(preparedEntry.inline, true);
  assert.equal(preparedEntry.id, segment.id);
  assert.deepEqual(batchFormula, { id: segment.id, source_text: segment.source_text });
  assert.equal(p.formulaStates[segment.id].status, 'done');
  assert.equal(segment.latex, '\\lVert \\nabla_{\\theta_k} \\mathbb{E}_{\\lambda_k \\sim \\Lambda_k} \\rVert_2');
  assert.deepEqual(states, ['pending', 'running', 'done']);
});

test('a rejected batch formula gets one isolated quality-checked OCR retry', async () => {
  const block = {
    id: 'eq20', kind: 'display_math', image_ref: 'eq20.png', number: '(20)',
    source_text: '−η∥∇θkEλk∼Λkg(hθ(t)(λk)|λk)∥2',
  };
  const entry = {
    id: 'eq20', name: 'eq20', block, image: 'data:image/png;base64,crop',
  };
  const p = {
    renderGeneration: 3,
    formulaStates: {},
    formulaRequestIds: new Set(),
  };
  const rendered = [];
  let sourceHint = '';
  const retry = executableViewerFunction('retryStructuredFormulaTranscription', {
    state: { documentGeneration: 9 },
    client: {
      transcribeFormula: () => ({
        id: 'single-retry',
        promise: Promise.resolve({ full: '{"latex":"corrected","number":"(20)"}' }),
      }),
    },
    renderStructuredDisplayFormula: () => rendered.push(p.formulaStates.eq20?.status),
    renderStructuredFormulaEntry: () => rendered.push(p.formulaStates.eq20?.status),
    parseFormulaTranscription: (_raw, options) => {
      sourceHint = options.sourceText;
      return { latex: '\\lVert x \\rVert_2', number: '(20)' };
    },
    isKatexRenderable: () => true,
  });

  assert.equal(await retry(p, entry, 3, 9), true);
  assert.equal(sourceHint, block.source_text);
  assert.equal(block.latex, '\\lVert x \\rVert_2');
  assert.equal(p.formulaStates.eq20.status, 'done');
  assert.equal(p.formulaRequestIds.size, 0);
  assert.deepEqual(rendered, ['retrying', 'done']);
});

test('typed formulas keep the authoritative crop until valid KaTeX is ready', () => {
  const render = functionBody('renderStructuredDisplayFormula');
  assert.match(render, /stateEntry\?\.crop/);
  assert.match(render, /structured-formula-crop/);
  assert.match(render, /公式识别中…/);
  assert.match(render, /retrying/);
  assert.match(render, /查看左侧公式/);
  assert.match(render, /formula-message/);
  assert.match(cssSource, /\.structured-page \.formula-message/);
  assert.match(cssSource, /\.formula-message\.formula-failed/);
});

function createDisplayFormulaHarness({
  block,
  state,
  katexRender = () => {},
  katex = { render: katexRender },
}) {
  const host = new FakeElement();
  const number = new FakeElement('span');
  const p = {
    num: 4,
    formulaStates: { equation: state },
    structuredFormulaHosts: new Map([[block.id, { host, number }]]),
    layoutImages: { 'equation.png': 'data:image/png;base64,crop' },
  };
  const render = executableViewerFunction('renderStructuredDisplayFormula', {
    formulaStateKey: () => 'equation',
    findImageLoose: () => '',
    trustedRenderableFormulaLatex: (formula) => normalizeMathForKatex(formula?.latex),
    window: { katex },
    document: { createElement: (tagName) => new FakeElement(tagName) },
  });
  return { render, p, host, number };
}

test('unnumbered formula state transitions retain the source crop', () => {
  const block = { id: 'eq', kind: 'display_math', image_ref: 'equation.png', number: '' };
  const harness = createDisplayFormulaHarness({ block, state: { status: 'pending' } });

  harness.render(harness.p, block);
  assert.equal(harness.host.textContent, '');
  assert.equal(harness.host.children.length, 1);
  assert.equal(harness.host.children[0].className, 'structured-formula-crop');

  harness.p.formulaStates.equation = { status: 'running' };
  harness.render(harness.p, block);
  assert.equal(harness.host.children.length, 1);

  harness.p.formulaStates.equation = { status: 'failed' };
  harness.render(harness.p, block);
  assert.equal(harness.host.textContent, '');
  assert.equal(harness.host.children.length, 1);
  assert.equal(harness.host.getAttribute('role'), null);
});

test('successful formula OCR replaces pending state with KaTeX and clears status semantics', () => {
  const calls = [];
  const block = { id: 'eq', kind: 'display_math', image_ref: 'equation.png', number: '' };
  const harness = createDisplayFormulaHarness({
    block,
    state: { status: 'pending' },
    katexRender: (...args) => calls.push(args),
  });
  harness.render(harness.p, block);
  harness.p.formulaStates.equation = { status: 'done', latex: '\\sum_{i=1}^n x_i' };
  harness.render(harness.p, block);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '\\sum_{i=1}^n x_i');
  assert.equal(calls[0][1], harness.host);
  assert.equal(calls[0][2].displayMode, true);
  assert.equal(harness.host.className, 'formula-display');
  assert.equal(harness.host.textContent, '');
  assert.equal(harness.host.getAttribute('role'), null);
});

test('numbered formula keeps its crop while OCR is pending', () => {
  const block = { id: 'eq', kind: 'display_math', image_ref: 'equation.png', number: '(3)' };
  const harness = createDisplayFormulaHarness({ block, state: { status: 'pending' } });
  harness.render(harness.p, block);

  assert.equal(harness.number.textContent, '(3)');
  assert.equal(harness.host.children.length, 1);
  assert.equal(harness.host.children[0].tagName, 'img');
  assert.equal(harness.host.children[0].className, 'structured-formula-crop');
});

test('OCR-invented number cannot label an unnumbered failed source crop', () => {
  const block = { id: 'eq', kind: 'display_math', image_ref: 'equation.png', number: '' };
  const harness = createDisplayFormulaHarness({
    block,
    state: { status: 'done', latex: 'invalid', number: '(99)' },
    katexRender: () => { throw new Error('invalid LaTeX'); },
  });
  harness.render(harness.p, block);

  assert.equal(harness.host.textContent, '');
  assert.equal(harness.host.children.length, 1);
  assert.equal(harness.number.textContent, '');
});

test('existing LaTeX with unavailable KaTeX does not get stuck in an OCR-pending state', () => {
  const block = {
    id: 'eq', kind: 'display_math', image_ref: 'equation.png', number: '', latex: 'x^2',
  };
  const harness = createDisplayFormulaHarness({
    block,
    state: undefined,
    katex: null,
  });
  harness.render(harness.p, block);

  assert.equal(harness.host.textContent, '');
  assert.equal(harness.host.children.length, 1);
  assert.equal(harness.host.classList.contains('formula-pending'), false);
});

test('formula table cells render inline KaTeX with readable per-cell fallback', () => {
  const body = functionBody('renderStructuredTableCell');
  assert.match(body, /formula|inline_math|display_math/);
  assert.match(body, /window\.katex\.render/);
  assert.match(body, /displayMode:\s*false/);
  assert.match(body, /source_text/);
  assert.doesNotMatch(body, /innerHTML|renderToString/);
});
