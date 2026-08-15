import test from 'node:test';
import assert from 'node:assert/strict';

import { maskApiKey, redactSecrets } from '../src/lib/secrets.js';

test('masks API keys without exposing the full credential', () => {
  assert.equal(maskApiKey(''), '(空)');
  assert.equal(maskApiKey('short'), '****');
  assert.equal(maskApiKey('abcd1234secretxy'), 'abcd****xy');
});

test('redacts bearer tokens, query keys, userinfo, and known keys', () => {
  const key = 'abcdef123456';
  const out = redactSecrets(
    `Bearer ${key} https://u:p@example.test/v1?token=${key}&api_key=second-secret ${key}`,
    [key, 'second-secret'],
  );

  assert.equal(out.includes(key), false);
  assert.equal(out.includes('second-secret'), false);
  assert.equal(out.includes('u:p@'), false);
  assert.match(out, /Bearer \*\*\*/);
  assert.match(out, /token=\*\*\*/);
  assert.match(out, /api_key=\*\*\*/);
});

test('redacts every canonical API key query parameter spelling', () => {
  const out = redactSecrets(
    'https://x.test/v1?apikey=one&api-key=two&x-api-key=three&key=four',
  );
  for (const secret of ['one', 'two', 'three', 'four']) assert.equal(out.includes(secret), false);
  assert.match(out, /apikey=\*\*\*/);
  assert.match(out, /api-key=\*\*\*/);
  assert.match(out, /x-api-key=\*\*\*/);
});

test('fully redacts RFC 6750 bearer credentials with plus, slash, tilde, and padding', () => {
  const key = 'abc+def/ghi~jkl==';
  const out = redactSecrets(`Bearer ${key} raw=${key}`, [key]);

  assert.equal(out, 'Bearer *** raw=***');
  assert.equal(out.includes('def/ghi'), false);
});

test('redaction handles empty and non-string values', () => {
  assert.equal(redactSecrets(null), '');
  assert.equal(redactSecrets(42), '42');
});
