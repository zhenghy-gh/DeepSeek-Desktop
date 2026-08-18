import test from 'node:test';
import assert from 'node:assert/strict';
import { Metrics } from '../src/metrics.js';

test('recordRetry 计数（总量 + 按账号）', () => {
  const m = new Metrics();
  m.recordRetry('A');
  m.recordRetry('A');
  assert.equal(m.totalRetries, 2);
  assert.equal(m.byAccount.A.retries, 2);
});

test('snapshot 包含 totalRetries', () => {
  const m = new Metrics();
  m.recordRetry('A');
  assert.equal(m.snapshot().totalRetries, 1);
});

test('prometheus 导出包含 retries 指标', () => {
  const m = new Metrics();
  m.recordRetry('A');
  assert.ok(m.prometheus().includes('ldfa_retries_total 1'));
});

test('reset 清空全部计数', () => {
  const m = new Metrics();
  m.recordRetry('A');
  m.requestStart('m1');
  m.reset();
  assert.equal(m.totalRequests, 0);
  assert.equal(m.totalRetries, 0);
  assert.deepEqual(m.byAccount, {});
  assert.deepEqual(m.snapshot().byModel, {});
});

test('延迟分位数：分位数单调且 reset 归零', () => {
  const m = new Metrics();
  const vals = [10, 60, 150, 300, 800, 2000, 5000, 12000, 30000, 60000];
  vals.forEach((v) => m.recordLatency(v));
  const p50 = m.snapshot().p50LatencyMs;
  const p95 = m.snapshot().p95LatencyMs;
  const p99 = m.snapshot().p99LatencyMs;
  assert.ok(p50 >= 0);
  assert.ok(p95 >= p50, 'p95 应不小于 p50');
  assert.ok(p99 >= p95, 'p99 应不小于 p95');
  assert.equal(m.snapshot().latencySamples, vals.length);
  assert.equal(m.snapshot().maxLatencyMs, 60000);
  m.reset();
  assert.equal(m.snapshot().p50LatencyMs, 0);
  assert.equal(m.snapshot().latencySamples, 0);
});

test('新增计数器：并发跳过 / 熔断', () => {
  const m = new Metrics();
  m.recordConcurrencyLimited();
  m.recordConcurrencyLimited();
  m.recordCircuitOpened('A');
  assert.equal(m.totalConcurrencyLimited, 2);
  assert.equal(m.totalCircuitOpened, 1);
  assert.equal(m.byAccount.A.circuitOpened, 1);
  assert.ok(m.prometheus().includes('ldfa_concurrency_limited_total 2'));
  assert.ok(m.prometheus().includes('ldfa_circuit_opened_total 1'));
});

test('recordTokens 累计 token 并按价格表估算成本', () => {
  const m = new Metrics();
  const prices = { 'gpt-4o': { prompt: 0.005, completion: 0.015 } };
  m.recordTokens('gpt-4o', 1000, 500, prices);
  assert.equal(m.totalPromptTokens, 1000);
  assert.equal(m.totalCompletionTokens, 500);
  assert.equal(m.totalTokens, 1500);
  // 1000/1000*0.005 + 500/1000*0.015 = 0.0125
  assert.equal(m.snapshot().estimatedCostUsd, 0.0125);
  assert.ok(m.prometheus().includes('ldfa_total_tokens_total 1500'));

  // 无价格表时不计成本
  const m2 = new Metrics();
  m2.recordTokens('gpt-4o', 10, 10);
  assert.equal(m2.totalTokens, 20);
  assert.equal(m2.snapshot().estimatedCostUsd, 0);
});

