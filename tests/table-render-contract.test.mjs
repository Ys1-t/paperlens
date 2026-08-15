import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const viewerSource = await readFile(new URL('../src/viewer/viewer.js', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../src/viewer/viewer.css', import.meta.url), 'utf8');

function functionBody(name) {
  const asyncStart = viewerSource.indexOf(`async function ${name}(`);
  const plainStart = viewerSource.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? plainStart : asyncStart;
  assert.notEqual(start, -1, `missing ${name}()`);
  const brace = viewerSource.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < viewerSource.length; index++) {
    if (viewerSource[index] === '{') depth += 1;
    if (viewerSource[index] === '}') depth -= 1;
    if (depth === 0) return viewerSource.slice(start, index + 1);
  }
  assert.fail(`could not parse ${name}()`);
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.clickCount = 0;
    this.classList = {
      add: (...names) => {
        const current = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const name of names) current.add(name);
        this.className = [...current].join(' ');
      },
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
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

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  click() {
    this.clickCount += 1;
  }

  dispatchKey(key) {
    const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.listeners.get('keydown')?.(event);
    return event;
  }
}

function fakeDocument() {
  const counts = new Map();
  return {
    counts,
    createElement(tagName) {
      counts.set(tagName, (counts.get(tagName) || 0) + 1);
      return new FakeElement(tagName);
    },
  };
}

function executableViewerFunction(name, dependencies) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(...names, `return (${functionBody(name)});`)(...values);
}

function findElement(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children || []) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

test('viewer imports typed translation and table helpers', () => {
  assert.match(viewerSource, /from ['"]\.\.\/lib\/structured-translation\.js['"]/);
  assert.match(viewerSource, /createReadingTranslationPlan/);
  assert.match(viewerSource, /expandReadingTranslationChange/);
  assert.match(viewerSource, /createNodeTranslationAccumulator/);
  assert.match(viewerSource, /updateStructuredTextNode/);
});

test('reading mode never rebuilds table grids — only caption + source crop/ref', () => {
  const body = functionBody('createTableBlock');
  for (const tag of ['figure', 'figcaption', 'img', 'button']) {
    assert.match(body, new RegExp(`createElement\\(['"]${tag}['"]\\)`));
  }
  // No semantic HTML table rebuild in the translation column.
  assert.doesNotMatch(body, /createElement\(['"]table['"]\)/);
  assert.doesNotMatch(body, /createElement\(['"]thead['"]\)/);
  assert.match(body, /table-source-image/);
  assert.match(body, /model\.imageRef/);
  assert.match(body, /查看左侧原表/);
  assert.doesNotMatch(body, /innerHTML|mdToHtml|wrapTables|\|---|join\(['"]\|/);
});

test('trusted tables still show caption + PDF crop, not translated cell DOM', () => {
  const document = fakeDocument();
  const block = {
    id: 'p0-t-trusted',
    kind: 'table',
    detector: 'pymupdf-layout',
    confidence: 0.96,
    bbox: [0.1, 0.2, 0.9, 0.8],
    columns: 3,
    header_rows: 1,
    image_ref: 'table-crop.png',
    caption: { id: 'cap', text: 'TABLE I. Results', position: 'above' },
    rows: [[{ id: 'h-method', text: 'Method', role: 'header' }]],
  };
  const createTableBlock = executableViewerFunction('createTableBlock', {
    document,
    rememberStructuredText: (page, element, id, _text, bbox) => {
      element.dataset.irId = id;
      page.nodeEls.set(id, element);
      page.irBboxes.set(id, bbox);
      return element;
    },
    findImageLoose: () => '',
  });
  const page = {
    nodeEls: new Map(),
    irBboxes: new Map(),
    layoutImages: { 'table-crop.png': 'data:image/png;base64,abc' },
  };

  const figure = createTableBlock(block, page);

  assert.equal(document.counts.get('table') || 0, 0);
  assert.equal(document.counts.get('img'), 1);
  assert.deepEqual([...page.nodeEls.keys()], ['cap']);
  assert.equal(figure.className, 'structured-table');
  const img = findElement(figure, (element) => element.tagName === 'IMG');
  assert.equal(img?.className, 'table-source-image');
  assert.equal(img?.src, 'data:image/png;base64,abc');
});

test('reading mode keeps figure captions and a source locator without duplicating figure pixels', () => {
  const body = functionBody('createStructuredBlock');
  assert.match(body, /block\.kind === 'figure'/);
  assert.doesNotMatch(body, /figure-source-image/);
  assert.doesNotMatch(body, /createElement\(['"]img['"]\)/);
  assert.match(body, /source-ref-image/);
  assert.match(body, /block\.caption/);
  assert.match(body, /rememberStructuredText/);
  assert.match(body, /p\.irBboxes\.set\(block\.id, block\.bbox\)/);
  assert.match(cssSource, /\.structured-figure/);
  assert.match(cssSource, /\.figure-caption-center/);
});

test('even a 20k-row table never creates cell DOM in fast reading mode', () => {
  const document = fakeDocument();
  const block = {
    id: 'p0-t0',
    bbox: [0.1, 0.2, 0.9, 0.8],
    caption: { id: 'p0-t0-caption', text: 'TABLE I', alignment: 'center', position: 'above' },
    rows: Array.from({ length: 20000 }, (_, row) => [
      { id: `p0-t0-r${row}-c0`, text: 'Hidden cell', role: 'data', numeric: false },
    ]),
  };
  const createTableBlock = executableViewerFunction('createTableBlock', {
    document,
    findImageLoose: () => '',
    rememberStructuredText: (page, element, id, _text, bbox) => {
      element.dataset.irId = id;
      page.nodeEls.set(id, element);
      page.irBboxes.set(id, bbox);
      return element;
    },
  });
  const page = { nodeEls: new Map(), irBboxes: new Map() };

  const figure = createTableBlock(block, page);

  assert.equal(document.counts.get('table') || 0, 0);
  assert.equal(document.counts.get('tr') || 0, 0);
  assert.equal(document.counts.get('th') || 0, 0);
  assert.equal(document.counts.get('td') || 0, 0);
  assert.deepEqual([...page.nodeEls.keys()], ['p0-t0-caption']);
  assert.equal(findElement(figure, (element) => element.tagName === 'BUTTON')?.textContent, '查看左侧原表');
});

test('table crop preserves caption alignment and below-caption placement', () => {
  const document = fakeDocument();
  const block = {
    id: 'p0-t1', bbox: [0, 0, 1, 1], image_ref: 'table.png',
    caption: { id: 'p0-t1-caption', text: 'TABLE II', alignment: 'center', position: 'below' },
  };
  const createTableBlock = executableViewerFunction('createTableBlock', {
    document,
    findImageLoose: () => '',
    rememberStructuredText: (page, element, id, _text, bbox) => {
      element.dataset.irId = id;
      page.nodeEls.set(id, element);
      page.irBboxes.set(id, bbox);
      return element;
    },
  });
  const page = {
    nodeEls: new Map(), irBboxes: new Map(),
    layoutImages: { 'table.png': 'data:image/png;base64,abc' },
  };
  const figure = createTableBlock(block, page);
  const caption = findElement(figure, (element) => element.tagName === 'FIGCAPTION');
  const image = findElement(figure, (element) => element.tagName === 'IMG');
  assert.equal(image.src, 'data:image/png;base64,abc');
  assert.equal(image.alt, 'TABLE II');
  assert.match(caption.className, /table-caption-center/);
  assert.equal(figure.children.at(-1), caption);
  assert.equal(page.irBboxes.get('p0-t1'), block.bbox);
});

test('typed Page IR mounts once, retains node IDs, and updates nodes locally', () => {
  const mount = functionBody('mountStructuredPage');
  const translate = functionBody('translatePageStructured');
  assert.match(mount, /structuredMounted/);
  assert.match(mount, /new Map\(/);
  assert.match(mount, /nodeEls/);
  assert.match(mount, /replaceChildren\(/);
  assert.match(translate, /createReadingTranslationPlan/);
  assert.match(translate, /updateStructuredTextNode/);
  assert.match(translate, /nodeEls/);
  assert.doesNotMatch(translate, /innerHTML|replaceChildren\(|renderLayoutBlocks|renderLayoutMarkdown/);
});

test('structured streaming batches changed nodes through one cancellable animation frame', () => {
  const translate = functionBody('translatePageStructured');
  assert.match(translate, /createNodeTranslationAccumulator/);
  assert.match(translate, /createRenderFrameGate/);
  assert.match(translate, /requestAnimationFrame/);
  assert.match(translate, /cancelAnimationFrame/);
  assert.match(translate, /renderGate\.cancel\(\)/);
  assert.match(translate, /changed|pendingChanges/);
});

test('typed Page IR keeps structured rendering while legacy Markdown remains fallback only', () => {
  const layout = functionBody('translatePageLayout');
  assert.match(layout, /p\.pageIr[\s\S]*translatePageStructured\(/);
  assert.match(layout, /layoutMd|legacyLayoutPromise/);
});

test('typed blocks preserve bbox navigation and coherent plain text', () => {
  const mount = functionBody('mountStructuredPage');
  const block = functionBody('createStructuredBlock');
  assert.match(block, /plain_text/);
  assert.match(block, /structured-plain-text/);
  assert.match(mount, /data-blk|dataset\.blk/);
  assert.match(mount, /blkMeta/);
  assert.match(mount, /bbox/);
});

test('typed table CSS supports aligned captions and readable source crops', () => {
  assert.match(cssSource, /\.structured-table/);
  assert.match(cssSource, /\.table-caption-center/);
  assert.match(cssSource, /\.table-source-image\s*\{[^}]*object-fit:\s*contain/s);
  assert.match(cssSource, /\.table-source-ref/);
  assert.match(cssSource, /\.structured-plain-text\s*\{[^}]*white-space:\s*pre-wrap/s);
});
