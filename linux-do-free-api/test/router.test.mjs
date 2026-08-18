import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccount } from '../src/account.js';
import { AccountPool } from '../src/pool.js';
import { handleChatCompletion, handleWithFailover } from '../src/router.js';
import { Metrics } from '../src/metrics.js';

function makePool(accounts) {
  const store = { accounts: accounts.map((a) => createAccount(a)), save() {} };
  return new AccountPool(store);
}

function okStream() {
  return { ok: true, statusCode: 200, headers: { 'content-type': 'application/json' }, stream: { pipe() {}, on() {} } };
}

// 注入可控的 mock 上游：results 形如 { A:{status,body}, B:{status:200} }
function mockForward(results) {
  return async (account) => {
    const r = typeof results === 'function' ? results(account) : results[account.name];
    if (r && r.status >= 200 && r.status < 300) return okStream();
    if (r) return { ok: false, statusCode: r.status, bodyText: r.body };
    return okStream();
  };
}

test('故障转移：A 429 → 切到 B 200', async () => {
  const pool = makePool([
    { name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'm1' },
    { name: 'B', baseUrl: 'http://b', apiKey: 'k', models: 'm1' },
  ]);
  pool.accounts[1].lastUsedAt = Date.now(); // 让 B 最近用过，优先选 A
  const metrics = new Metrics();
  const res = await handleChatCompletion(pool, { model: 'm1', messages: [] }, {
    forward: mockForward({ A: { status: 429, body: '{"error":"quota"}' }, B: { status: 200 } }),
    metrics,
  });
  assert.equal(res.ok, true);
  assert.equal(pool.accounts[0].status, 'exhausted');
  assert.equal(pool.accounts[1].used, 1);
  assert.equal(metrics.totalSwitches, 1);
  assert.equal(metrics.totalSuccess, 1);
});

test('全部失败 → 502 并返回 tried 列表', async () => {
  const pool = makePool([
    { name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'm1' },
    { name: 'B', baseUrl: 'http://b', apiKey: 'k', models: 'm1' },
  ]);
  const res = await handleChatCompletion(pool, { model: 'm1', messages: [] }, {
    forward: mockForward({ A: { status: 500, body: 'err' }, B: { status: 500, body: 'err' } }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 502);
  assert.deepEqual(res.tried.sort(), [pool.accounts[0].id, pool.accounts[1].id].sort());
});

test('client_error 不切换，直接返回', async () => {
  // 单账号：client_error 应直接返回，不切账号、不重试
  const pool = makePool([{ name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'm1' }]);
  const res = await handleChatCompletion(pool, { model: 'm1', messages: [] }, {
    forward: mockForward({ A: { status: 400, body: 'bad param' } }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.deepEqual(res.tried, [pool.accounts[0].id]);
});

test('瞬态错误在同账号退避重试（不切换）', async () => {
  const pool = makePool([{ name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'm1' }]);
  let calls = 0;
  const forward = async () => {
    calls++;
    if (calls === 1) return { ok: false, statusCode: 500, bodyText: 'temp' }; // 瞬态
    return okStream();
  };
  const metrics = new Metrics();
  const res = await handleChatCompletion(pool, { model: 'm1', messages: [] }, { forward, metrics });
  assert.equal(res.ok, true);
  assert.equal(calls, 2, '第一次失败后应在同账号重试一次');
  assert.equal(metrics.totalRetries, 1);
  assert.equal(metrics.totalSwitches, 0, '不应切换账号');
});

test('embeddings 路径转发（apiPath 覆盖）', async () => {
  let capturedPath = null;
  const forward = async (account, payload, opts) => {
    capturedPath = opts.pathOverride;
    return okStream();
  };
  const pool = makePool([{ name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'text-embedding-3-small' }]);
  const res = await handleWithFailover(pool, { model: 'text-embedding-3-small', input: 'hi' }, {
    forward,
    apiPath: '/v1/embeddings',
  });
  assert.equal(res.ok, true);
  assert.equal(capturedPath, '/v1/embeddings');
});

test('通用透传：/v1/images/generations 按原路径转发（apiPath=实际路径）', async () => {
  let capturedPath = null;
  const forward = async (account, payload, opts) => {
    capturedPath = opts.pathOverride;
    return okStream();
  };
  const pool = makePool([{ name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'dall-e-3' }]);
  const res = await handleWithFailover(pool, { model: 'dall-e-3', prompt: 'a cat' }, {
    forward,
    apiPath: '/v1/images/generations',
  });
  assert.equal(res.ok, true);
  assert.equal(capturedPath, '/v1/images/generations', '应透传原始路径');
});

test('头部透传：passthroughHeaders 到达上游', async () => {
  let captured = null;
  const forward = async (account, payload, opts) => {
    captured = opts.passthroughHeaders;
    return okStream();
  };
  const pool = makePool([{ name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'm1' }]);
  const res = await handleChatCompletion(pool, { model: 'm1', messages: [] }, {
    forward,
    passthroughHeaders: { 'OpenAI-Organization': 'org-1', 'X-Custom': 'v' },
  });
  assert.equal(res.ok, true);
  assert.equal(captured['OpenAI-Organization'], 'org-1');
  assert.equal(captured['X-Custom'], 'v');
});

test('按组路由：仅从指定 group 选号', async () => {
  const pool = makePool([
    { name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'm1', groups: 'premium' },
    { name: 'B', baseUrl: 'http://b', apiKey: 'k', models: 'm1', groups: 'free' },
  ]);
  const calls = [];
  const res = await handleChatCompletion(pool, { model: 'm1', messages: [] }, {
    forward: async (account) => { calls.push(account.name); return okStream(); },
    group: 'premium',
  });
  assert.equal(res.ok, true);
  assert.deepEqual(calls, ['A'], '应只命中 premium 组的 A');
});

test('按组路由：组内无可用账号 → 502 且消息指明 group', async () => {
  const pool = makePool([
    { name: 'B', baseUrl: 'http://b', apiKey: 'k', models: 'm1', groups: 'free' },
  ]);
  const res = await handleChatCompletion(pool, { model: 'm1', messages: [] }, { group: 'premium' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 502);
  assert.ok(res.error.includes('premium'), '错误信息应指明 group');
  assert.deepEqual(res.tried, [], '不应尝试任何账号');
});

test('并发上限：未超限时正常选中并释放计数', async () => {
  const pool = makePool([
    { name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'm1' },
    { name: 'B', baseUrl: 'http://b', apiKey: 'k', models: 'm1' },
  ]);
  const concurrency = new Map();
  const res = await handleChatCompletion(pool, { model: 'm1', messages: [] }, {
    forward: mockForward({ A: { status: 200 }, B: { status: 200 } }),
    concurrency,
    maxConcurrency: 1,
  });
  assert.equal(res.ok, true);
  assert.equal(concurrency.size, 0, '请求结束后并发计数应归零');
});

test('并发上限：全部满载 → 502 并指明并发限制', async () => {
  const pool = makePool([
    { name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'm1' },
    { name: 'B', baseUrl: 'http://b', apiKey: 'k', models: 'm1' },
  ]);
  const concurrency = new Map();
  pool.accounts.forEach((a) => concurrency.set(a.id, 1));
  const res = await handleChatCompletion(pool, { model: 'm1', messages: [] }, {
    forward: mockForward({}),
    concurrency,
    maxConcurrency: 1,
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 502);
  assert.ok(res.error.includes('concurrency'), '应说明是并发上限导致');
  assert.deepEqual(res.tried, [], '满载时不应尝试任何账号');
});

test('熔断：连续错误达阈值自动禁用账号', async () => {
  const pool = makePool([{ name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'm1' }]);
  const metrics = new Metrics();
  const res = await handleChatCompletion(pool, { model: 'm1', messages: [] }, {
    forward: mockForward({ A: { status: 500, body: 'e' } }),
    metrics,
    circuitLimit: 1,
  });
  assert.equal(res.ok, false);
  assert.equal(pool.accounts[0].status, 'disabled', '应被熔断禁用');
  assert.equal(metrics.totalCircuitOpened, 1);
});
