import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let factoryModule = {};
try {
  factoryModule = await import('../src/lib/pdf-canvas-factory.js');
} catch {
  // RED phase: the read-optimized PDF canvas factory does not exist yet.
}

test('PDF canvas factory always enables willReadFrequently for PDF.js intermediate canvases', () => {
  assert.equal(typeof factoryModule.createReadOptimizedCanvasFactory, 'function');

  const calls = [];
  const context = { marker: '2d-context' };
  const ownerDocument = {
    createElement(tagName) {
      assert.equal(tagName, 'canvas');
      return {
        width: 0,
        height: 0,
        getContext(type, options) {
          calls.push({ type, options });
          return context;
        },
      };
    },
  };
  const factory = factoryModule.createReadOptimizedCanvasFactory(ownerDocument);
  const created = factory.create(320, 180);

  assert.equal(created.canvas.width, 320);
  assert.equal(created.canvas.height, 180);
  assert.equal(created.context, context);
  assert.deepEqual(calls, [{ type: '2d', options: { willReadFrequently: true } }]);

  // Third arg is ignored; intermediate canvases always opt into frequent readback.
  const again = factory.create(64, 64, false);
  assert.equal(again.context, context);
  assert.deepEqual(calls, [
    { type: '2d', options: { willReadFrequently: true } },
    { type: '2d', options: { willReadFrequently: true } },
  ]);

  factory.reset(created, 640, 360);
  assert.equal(created.canvas.width, 640);
  assert.equal(created.canvas.height, 360);
  factory.destroy(created);
  assert.equal(created.canvas, null);
  assert.equal(created.context, null);
  factory.destroy(again);
});

test('every viewer render target forces a read-optimized 2D context', async () => {
  assert.equal(typeof factoryModule.getReadOptimized2dContext, 'function');
  const calls = [];
  const context = {};
  const canvas = {
    getContext(type, options) {
      calls.push({ type, options });
      return context;
    },
  };

  assert.equal(
    factoryModule.getReadOptimized2dContext(canvas, { alpha: false, willReadFrequently: false }),
    context,
  );
  assert.deepEqual(calls, [{
    type: '2d',
    options: { alpha: false, willReadFrequently: true },
  }]);

  const viewerSource = await readFile(new URL('../src/viewer/viewer.js', import.meta.url), 'utf8');
  assert.match(viewerSource, /getReadOptimized2dContext\(canvas, \{ alpha: false \}\)/);
  assert.doesNotMatch(viewerSource, /\.getContext\(['"]2d['"]/);
});

test('viewer supplies the read-optimized factory to PDF.js document loading', async () => {
  const viewerSource = await readFile(new URL('../src/viewer/viewer.js', import.meta.url), 'utf8');
  assert.match(viewerSource, /from ['"]\.\.\/lib\/pdf-canvas-factory\.js['"]/);
  assert.match(viewerSource, /pdfjsLib\.getDocument\(\{[\s\S]*canvasFactory:\s*createReadOptimizedCanvasFactory\(document\)/);
});

test('vendored PDF.js always marks intermediate canvases for frequent readback', async () => {
  const vendorSource = await readFile(new URL('../src/vendor/pdf.min.js', import.meta.url), 'utf8');
  const baseFactorySignature = 'create(t,e,i=!1){if(t<=0||e<=0)throw new Error("Invalid canvas size")';
  const alwaysContext = 'getContext("2d",{willReadFrequently:!0})';
  const alwaysCreate = 'this.canvasFactory.create(e,i,!0)';

  assert.equal(vendorSource.split(baseFactorySignature).length - 1, 1);
  assert.equal(vendorSource.split(alwaysContext).length - 1, 1);
  assert.equal(vendorSource.split(alwaysCreate).length - 1, 1);
  assert.equal(vendorSource.includes('i?{willReadFrequently:!0}:void 0'), false);
  assert.equal(vendorSource.includes('context:i.getContext("2d")'), false);
  assert.equal(
    vendorSource.includes('this.canvasFactory.create(e,i,t.startsWith("smaskGroupAt")||t.includes("_smask_"))'),
    false,
  );
});
