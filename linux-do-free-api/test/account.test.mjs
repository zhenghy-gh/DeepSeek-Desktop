import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccount, isHealthy, markExhausted, recordSuccess, recordTransientError, shouldCircuitBreak } from '../src/account.js';

test('createAccount 规范化 models（数组/逗号串）', () => {
  assert.deepEqual(createAccount({ models: ['a', 'b'] }).models, ['a', 'b']);
  assert.deepEqual(createAccount({ models: 'x, y ,z' }).models, ['x', 'y', 'z']);
  assert.deepEqual(createAccount({}).models, []);
});

test('isHealthy 规则', () => {
  const now = Date.now();
  assert.equal(isHealthy(createAccount({ enabled: false })), false);
  assert.equal(isHealthy(createAccount({ status: 'disabled' })), false);
  assert.equal(isHealthy(createAccount({ cooldownUntil: now + 10000 })), false);
  assert.equal(isHealthy(createAccount({ cooldownUntil: now - 10000 })), true);
  assert.equal(isHealthy(createAccount({})), true);
});

test('markExhausted 进入冷却', () => {
  const a = createAccount({});
  markExhausted(a, 1000);
  assert.equal(a.status, 'exhausted');
  assert.ok(a.cooldownUntil > Date.now());
});

test('recordSuccess 复活并计数', () => {
  const a = createAccount({});
  markExhausted(a, 1000);
  recordSuccess(a);
  assert.equal(a.status, 'active');
  assert.equal(a.cooldownUntil, null);
  assert.equal(a.used, 1);
});

test('recordTransientError 计数 + 短时冷却', () => {
  const a = createAccount({});
  recordTransientError(a, 5000);
  assert.equal(a.consecutiveErrors, 1);
  assert.ok(a.cooldownUntil > Date.now());
});

test('recordTransientError 自适应冷却：随连续错误指数增长', () => {
  const a = createAccount({});
  const t1 = Date.now(); recordTransientError(a, 5000);
  assert.equal(a.consecutiveErrors, 1);
  assert.ok(a.cooldownUntil - t1 >= 4950 && a.cooldownUntil - t1 < 5200);
  const t2 = Date.now(); recordTransientError(a, 5000);
  assert.equal(a.consecutiveErrors, 2);
  assert.ok(a.cooldownUntil - t2 >= 9950, '第2次错误冷却应≈10000ms');
  const t3 = Date.now(); recordTransientError(a, 5000);
  assert.ok(a.cooldownUntil - t3 >= 19950, '第3次错误冷却应≈20000ms');
});

test('shouldCircuitBreak 判定', () => {
  const a = createAccount({});
  assert.equal(shouldCircuitBreak(a, 0), false, 'limit=0 关闭熔断');
  assert.equal(shouldCircuitBreak(a, 5), false);
  a.consecutiveErrors = 5;
  assert.equal(shouldCircuitBreak(a, 5), true, '达阈值触发');
  assert.equal(shouldCircuitBreak(a, 10), false, '未达更高阈值');
});

test('createAccount 保留 modelWeights 与 note', () => {
  const a = createAccount({ modelWeights: { 'gpt-4o': 3 }, note: '主用账号' });
  assert.deepEqual(a.modelWeights, { 'gpt-4o': 3 });
  assert.equal(a.note, '主用账号');
  // 非对象 modelWeights 被忽略
  assert.equal(createAccount({ modelWeights: 'x' }).modelWeights, null);
});
