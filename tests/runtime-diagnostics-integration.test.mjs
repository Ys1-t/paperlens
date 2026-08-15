import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function optionalSource(relativePath) {
  try { return await readFile(new URL(relativePath, import.meta.url), 'utf8'); }
  catch { return ''; }
}

const viewerSource = await optionalSource('../src/viewer/viewer.js');
const serviceWorkerSource = await optionalSource('../src/background/service-worker.js');
const popupHtml = await optionalSource('../src/popup/popup.html');
const popupSource = await optionalSource('../src/popup/popup.js');
const diagnosticsHtml = await optionalSource('../src/diagnostics/diagnostics.html');
const diagnosticsSource = await optionalSource('../src/diagnostics/diagnostics.js');

test('viewer and service worker install persistent runtime diagnostic capture', () => {
  assert.match(viewerSource, /from ['"]\.\.\/lib\/runtime-diagnostics\.js['"]/);
  assert.match(viewerSource, /installRuntimeDiagnosticCapture\(\{[\s\S]*component:\s*['"]viewer['"]/);
  assert.match(viewerSource, /kind:\s*['"]port\.disconnect['"]/);
  assert.match(serviceWorkerSource, /from ['"]\.\.\/lib\/runtime-diagnostics\.js['"]/);
  assert.match(serviceWorkerSource, /installRuntimeDiagnosticCapture\(\{[\s\S]*component:\s*['"]service-worker['"]/);
});

test('popup opens a standalone diagnostics page that can copy and clear captured errors', () => {
  assert.match(popupHtml, /id=["']open-diagnostics["']/);
  assert.match(popupSource, /src\/diagnostics\/diagnostics\.html/);
  assert.match(diagnosticsHtml, /id=["']diagnostic-report["']/);
  assert.match(diagnosticsHtml, /id=["']copy-diagnostics["']/);
  assert.match(diagnosticsHtml, /id=["']clear-diagnostics["']/);
  assert.match(diagnosticsSource, /loadRuntimeDiagnostics/);
  assert.match(diagnosticsSource, /formatRuntimeDiagnostics/);
  assert.match(diagnosticsSource, /RUNTIME_DIAGNOSTICS_KEY/);
  assert.match(diagnosticsSource, /navigator\.clipboard\.writeText/);
  assert.match(diagnosticsSource, /chrome\.storage\.local\.remove/);
});

