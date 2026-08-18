import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../src/errors.js';

test('429 → quota（不重试）', () => {
  const c = classifyError(429, 'too many requests');
  assert.equal(c.type, 'quota');
  assert.equal(c.retryable, false);
});

test('401 + invalid api key → invalid_key', () => {
  const c = classifyError(401, '{"error":{"message":"Invalid API key"}}');
  assert.equal(c.type, 'invalid_key');
  assert.equal(c.retryable, false);
});

test('500 → upstream_error（可重试）', () => {
  const c = classifyError(500, '');
  assert.equal(c.type, 'upstream_error');
  assert.equal(c.retryable, true);
});

test('400 → client_error（不重试）', () => {
  const c = classifyError(400, 'bad request');
  assert.equal(c.type, 'client_error');
  assert.equal(c.retryable, false);
});

test('响应体含额度关键词 → quota', () => {
  const c = classifyError(200, '{"error":"额度已用尽"}');
  assert.equal(c.type, 'quota');
});

test('状态码 0 → network（可重试）', () => {
  const c = classifyError(0, 'ECONNREFUSED');
  assert.equal(c.type, 'network');
  assert.equal(c.retryable, true);
});

test('400 + 上下文超限关键词 → context_length（不重试）', () => {
  const c = classifyError(400, "This model's maximum context length is 8192 tokens");
  assert.equal(c.type, 'context_length');
  assert.equal(c.retryable, false);
});
