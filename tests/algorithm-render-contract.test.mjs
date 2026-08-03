import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const viewerSource = await readFile(new URL('../src/viewer/viewer.js', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../src/viewer/viewer.css', import.meta.url), 'utf8');

function functionBody(name) {
  const start = viewerSource.indexOf(`function ${name}(`);
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
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.className = '';
    this.textContent = '';
    this.styleValues = new Map();
    this.style = { setProperty: (name, value) => this.styleValues.set(name, String(value)) };
    this.classList = new FakeClassList(this);
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  appendChild(child) {
    this.children.push(child);
    child.parentElement = this;
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
}

function executableViewerFunction(name, dependencies) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(...names, `return (${functionBody(name)});`)(...values);
}

const document = { createElement: (tagName) => new FakeElement(tagName) };
const normalizedAlgorithmIndent = executableViewerFunction('normalizedAlgorithmIndent', {
  MAX_ALGORITHM_RENDER_INDENT: 8,
});
const normalizedAlgorithmRole = executableViewerFunction('normalizedAlgorithmRole', {
  STRUCTURED_ALGORITHM_ROLES: new Set(['title', 'input', 'output', 'bullet', 'code']),
});

test('structured algorithm keeps every source line atomic with an independent number column', () => {
  const renderedSegments = [];
  const appendStructuredParagraphSegment = (container, segment) => {
    const span = document.createElement('span');
    span.dataset.segmentId = segment.id;
    span.className = segment.kind === 'inline_math' ? 'structured-inline-math' : 'structured-text';
    container.appendChild(span);
    renderedSegments.push(segment.id);
  };
  const createStructuredAlgorithmBlock = executableViewerFunction('createStructuredAlgorithmBlock', {
    document,
    normalizedAlgorithmIndent,
    normalizedAlgorithmRole,
    appendStructuredParagraphSegment,
  });
  const block = {
    id: 'p8-alg0',
    layout: 'algorithm',
    segments: [
      { id: 'title', kind: 'text', algorithm_line: 0, algorithm_indent: 0, algorithm_role: 'title' },
      { id: 'line2-text', kind: 'text', algorithm_line: 2, algorithm_indent: 3, algorithm_role: 'code', algorithm_number: '2:' },
      { id: 'line1-text', kind: 'text', algorithm_line: 1, algorithm_indent: 1, algorithm_role: 'input', algorithm_number: '1:' },
      { id: 'line2-math', kind: 'inline_math', algorithm_line: 2, algorithm_indent: 3, algorithm_role: 'code', algorithm_number: '2:' },
      { id: 'line2-tail', kind: 'text', algorithm_line: 2, algorithm_indent: 3, algorithm_role: 'code', algorithm_number: '2:' },
    ],
  };

  const algorithm = createStructuredAlgorithmBlock(block, {});

  assert.equal(algorithm.tagName, 'DIV');
  assert.match(algorithm.className, /structured-algorithm-lines/);
  assert.equal(algorithm.children.length, 3);
  assert.deepEqual(algorithm.children.map((line) => line.dataset.algorithmLine), ['0', '1', '2']);
  const codeLine = algorithm.children[2];
  assert.equal(codeLine.children[0].className, 'algorithm-line-number');
  assert.equal(codeLine.children[0].textContent, '2:');
  assert.equal(codeLine.children[1].className, 'algorithm-line-content');
  assert.deepEqual(
    codeLine.children[1].children.map((span) => span.dataset.segmentId),
    ['line2-text', 'line2-math', 'line2-tail'],
  );
  assert.match(codeLine.children[1].children[1].className, /structured-inline-math/);
  assert.deepEqual(renderedSegments, ['title', 'line1-text', 'line2-text', 'line2-math', 'line2-tail']);
});

test('algorithm indent and role metadata are normalized before reaching layout CSS', () => {
  assert.equal(normalizedAlgorithmIndent(-3), 0);
  assert.equal(normalizedAlgorithmIndent(4.9), 4);
  assert.equal(normalizedAlgorithmIndent(99), 8);
  assert.equal(normalizedAlgorithmIndent('bad'), 0);
  assert.equal(normalizedAlgorithmRole('OUTPUT'), 'output');
  assert.equal(normalizedAlgorithmRole('unknown'), 'code');

  const createStructuredAlgorithmBlock = executableViewerFunction('createStructuredAlgorithmBlock', {
    document,
    normalizedAlgorithmIndent,
    normalizedAlgorithmRole,
    appendStructuredParagraphSegment: () => {},
  });
  const rendered = createStructuredAlgorithmBlock({
    segments: [{
      id: 'deep', kind: 'text', algorithm_line: 4, algorithm_indent: 42,
      algorithm_role: 'unknown', algorithm_number: '4:',
    }],
  }, {});
  const line = rendered.children[0];
  assert.equal(line.dataset.algorithmIndent, '8');
  assert.equal(line.dataset.algorithmRole, 'code');
  assert.equal(line.styleValues.get('--algorithm-indent-offset'), '9.6rem');
});

test('new Page IR uses line rendering while old algorithms retain the legacy paragraph fallback', () => {
  const body = functionBody('createStructuredBlock');
  assert.match(body, /hasAlgorithmLines[\s\S]*createStructuredAlgorithmBlock\(block, p\)/);
  assert.match(body, /structured-algorithm-legacy/);
  assert.match(body, /Number\.isInteger\(segment\?\.algorithm_line\)/);
});

test('algorithm CSS defines grid columns, bounded-indent offset, hanging bullets, and role treatments', () => {
  assert.match(cssSource, /\.algorithm-line\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:/s);
  assert.match(cssSource, /\.algorithm-line-number\s*\{[^}]*text-align:\s*end/s);
  assert.match(cssSource, /\.algorithm-line-content\s*\{[^}]*padding-inline-start:\s*var\(--algorithm-indent-offset/s);
  assert.match(cssSource, /\.algorithm-role-bullet \.algorithm-line-content\s*\{[^}]*text-indent:\s*-0\.9rem/s);
  for (const role of ['title', 'input', 'output', 'bullet', 'code']) {
    assert.match(cssSource, new RegExp(`\\.algorithm-role-${role}`));
  }
});

// --- 行内公式间距 / 标点收缩契约 ---------------------------------------
// 翻译回填会把多 span slot 的译文并入首个 span、其余置空
// （expandReadingTranslationChange），因此公式的间距 class 必须跳过零宽
// span 取最近可见兄弟；算法行是 pre-wrap，标点前的字面空白要在渲染层收缩。

const hasHanTextBoundary = executableViewerFunction('hasHanTextBoundary', {});
const syncInlineMathBoundarySpacing = executableViewerFunction(
  'syncInlineMathBoundarySpacing',
  { hasHanTextBoundary },
);

function textSpan(text, className = '') {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function algorithmLineContent(children) {
  const content = document.createElement('div');
  content.className = 'algorithm-line-content';
  for (const child of children) content.appendChild(child);
  return content;
}

test('algorithm inline math takes Han spacing from the nearest visible sibling across emptied slot spans', () => {
  const math = textSpan('', 'structured-inline-math');
  math.textContent = 'K';
  const content = algorithmLineContent([
    textSpan('任务数量'),
    textSpan(''), // 翻译并入首 span 后被置空的 slot 残留
    math,
    textSpan(';'),
  ]);

  syncInlineMathBoundarySpacing(content);

  assert.equal(math.classList.contains('inline-math-space-before'), true);
  assert.equal(math.classList.contains('inline-math-space-after'), false);
});

test('algorithm line content collapses stray whitespace before punctuation without touching math-side spaces', () => {
  const math = textSpan('g', 'structured-inline-math');
  const head = textSpan('一个标量化函数 ');
  const tail = textSpan(' ;');
  syncInlineMathBoundarySpacing(algorithmLineContent([head, math, tail]));
  assert.equal(head.textContent, '一个标量化函数 ', 'space before inline math is meaningful and must survive');
  assert.equal(tail.textContent, ';', 'punctuation hugs the preceding formula');

  const first = textSpan('一个 MOP ');
  const semicolon = textSpan(';');
  syncInlineMathBoundarySpacing(algorithmLineContent([first, textSpan(''), semicolon]));
  assert.equal(first.textContent, '一个 MOP', 'trailing space is collapsed when punctuation follows');
  assert.equal(semicolon.textContent, ';');
});

test('paragraph containers keep translated text verbatim while still skipping zero-width spans', () => {
  const paragraph = document.createElement('p');
  const math = textSpan('K', 'structured-inline-math');
  const tail = textSpan(' ;');
  for (const child of [textSpan('任务数量'), textSpan(''), math, tail]) paragraph.appendChild(child);

  syncInlineMathBoundarySpacing(paragraph);

  assert.equal(math.classList.contains('inline-math-space-before'), true);
  assert.equal(tail.textContent, ' ;', 'non-algorithm containers are never rewritten');
});

test('punctuation collapse stays a display-only concern scoped to algorithm line content', () => {
  const body = functionBody('syncInlineMathBoundarySpacing');
  assert.match(body, /algorithm-line-content/);
  assert.doesNotMatch(body, /sourceTextById|irBboxes|segment\.text/);
});

