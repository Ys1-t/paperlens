import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  LEGACY_PDF_REDIRECT_RULE_IDS,
  removeLegacyPdfRedirectRules,
} from '../src/lib/pdf-open-policy.js';

const serviceWorkerSource = await readFile(
  new URL('../src/background/service-worker.js', import.meta.url),
  'utf8',
);
const optionsHtml = await readFile(new URL('../src/options/options.html', import.meta.url), 'utf8');
const optionsSource = await readFile(new URL('../src/options/options.js', import.meta.url), 'utf8');

test('upgrades remove both persistent legacy PDF redirect rules without adding replacements', async () => {
  const updates = [];
  const removed = await removeLegacyPdfRedirectRules({
    async updateDynamicRules(update) { updates.push(structuredClone(update)); },
  });

  assert.equal(removed, true);
  assert.deepEqual(LEGACY_PDF_REDIRECT_RULE_IDS, [1001, 1002]);
  assert.deepEqual(updates, [{ removeRuleIds: [1001, 1002], addRules: [] }]);
});

test('legacy cleanup is safe when Declarative Net Request is unavailable', async () => {
  await assert.doesNotReject(() => removeLegacyPdfRedirectRules(undefined));
  assert.equal(await removeLegacyPdfRedirectRules({}), false);
});

test('service worker never creates an automatic PDF navigation redirect', () => {
  assert.match(serviceWorkerSource, /removeLegacyPdfRedirectRules/);
  assert.match(serviceWorkerSource, /disableAutomaticPdfInterception\(\)/);
  assert.doesNotMatch(serviceWorkerSource, /regexSubstitution/);
  assert.doesNotMatch(serviceWorkerSource, /action:\s*\{\s*type:\s*['"]redirect['"]/);
  assert.doesNotMatch(serviceWorkerSource, /cfg\.autoIntercept/);
});

test('settings no longer offer an automatic interception toggle', () => {
  assert.doesNotMatch(optionsHtml, /id=["']autoIntercept["']/);
  assert.doesNotMatch(optionsSource, /['"]autoIntercept['"]/);
});
