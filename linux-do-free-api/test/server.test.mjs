import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { createServer } from '../src/server.js';

const NODE = process.execPath;

function startServer({ adminToken = 'sekret', proxyToken = '', allowCors = '', maxBodyBytes, rateLimitRps = 0, rateLimitBurst = 0 } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ldfa-srv-')), 'accounts.json');
  const store = new Store(file);
  const pool = new AccountPool(store);
  const server = createServer(pool, { adminToken, proxyToken, allowCors, maxBodyBytes, rateLimitRps, rateLimitBurst });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}`, auth: `Bearer ${adminToken}`, proxyAuth: `Bearer ${proxyToken}`, file });
    });
  });
}

test('管理 API：未带 token 添加账号 → 401；带 token → 201 并可查到', async () => {
  const { server, base, auth, file } = await startServer();
  try {
    // 无 token
    let r = await fetch(`${base}/admin/pool`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://x', apiKey: 'k' }),
    });
    assert.equal(r.status, 401);

    // 带 token
    r = await fetch(`${base}/admin/pool`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ name: 'A', baseUrl: 'http://x', apiKey: 'k', models: 'm1', groups: 'g1' }),
    });
    assert.equal(r.status, 201);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.account.name, 'A');

    // 查号池能看到
    r = await fetch(`${base}/admin/pool`, { headers: { Authorization: auth } });
    const pj = await r.json();
    assert.equal(pj.accounts.length, 1);
    assert.deepEqual(pj.accounts[0].groups, ['g1']);

    // 禁用 + 删除
    const id = j.account.id;
    r = await fetch(`${base}/admin/pool/${id}/disable`, { method: 'POST', headers: { Authorization: auth } });
    assert.equal((await r.json()).account.status, 'disabled');
    r = await fetch(`${base}/admin/pool/${id}/remove`, { method: 'POST', headers: { Authorization: auth } });
    assert.equal((await r.json()).ok, true);
    r = await fetch(`${base}/admin/pool`, { headers: { Authorization: auth } });
    assert.equal((await r.json()).accounts.length, 0);
  } finally {
    server.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('health-check：返回可达性汇总', async () => {
  const orig = globalThis.fetch;
  // 仅对上游探活 URL 返回模拟；本机 server 的请求仍走真实 fetch
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return orig(url, opts);
    return { ok: String(url).includes('up'), status: String(url).includes('up') ? 200 : 500 };
  };
  const { server, base, auth } = await startServer();
  try {
    await fetch(`${base}/admin/pool`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ baseUrl: 'http://up/v1', apiKey: 'k', models: 'm1' }),
    });
    const r = await fetch(`${base}/admin/health-check`, { method: 'POST', headers: { Authorization: auth } });
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.total, 1);
    assert.equal(j.reachable, 1);
  } finally {
    globalThis.fetch = orig;
    server.close();
  }
});

test('health-check：autoDisable 自动下线不可达账号', async () => {
  const orig = globalThis.fetch;
  // up 可达，down 不可达
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return orig(url, opts);
    const up = String(url).includes('up');
    return { ok: up, status: up ? 200 : 500 };
  };
  const { server, base, auth } = await startServer();
  try {
    await fetch(`${base}/admin/pool`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ name: 'down', baseUrl: 'http://down/v1', apiKey: 'k', models: 'm1' }),
    });
    const r = await fetch(`${base}/admin/health-check`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ autoDisable: true }),
    });
    const j = await r.json();
    assert.equal(j.autoDisabled.length, 1, '不可达账号应被下线');
    assert.equal(j.reachable, 0);
    // 确认账号状态已为 disabled
    const pj = await fetch(`${base}/admin/pool`, { headers: { Authorization: auth } });
    const acct = (await pj.json()).accounts.find((a) => a.name === 'down');
    assert.equal(acct.status, 'disabled');
    assert.equal(acct.enabled, false);
  } finally {
    globalThis.fetch = orig;
    server.close();
  }
});

test('代理鉴权：未带 PROXY_AUTH_TOKEN → 401；带 → 放行(无账号则502)', async () => {
  const { server, base, proxyAuth } = await startServer({ proxyToken: 'ptok' });
  try {
    let r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.status, 401);
    const j = await r.json();
    assert.equal(j.type, 'proxy_auth');

    r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: proxyAuth },
      body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    // 号池为空，鉴权通过但无账号 → 502（说明已放行而非 401）
    assert.equal(r.status, 502);
  } finally {
    server.close();
  }
});

test('请求校验：chat 缺 messages → 400 bad_request', async () => {
  const { server, base, proxyAuth } = await startServer({ proxyToken: 'ptok' });
  try {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: proxyAuth },
      body: JSON.stringify({ model: 'm1' }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.type, 'bad_request');
  } finally {
    server.close();
  }
});

test('CORS：OPTIONS 预检 204 + 响应头（含 credentials/vary）', async () => {
  const { server, base } = await startServer({ allowCors: '*' });
  try {
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
    assert.ok(r.headers.get('vary'), '应带 Vary: Origin');
  } finally {
    server.close();
  }
});

test('X-Request-Id：每个响应都带追踪头', async () => {
  const { server, base } = await startServer();
  try {
    const r = await fetch(`${base}/health`);
    assert.ok(r.headers.get('x-request-id'), '应存在 X-Request-Id');
  } finally {
    server.close();
  }
});

test('请求体过大 → 413 payload_too_large', async () => {
  const { server, base, proxyAuth } = await startServer({ proxyToken: 'ptok', maxBodyBytes: 5 });
  try {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: proxyAuth },
      body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.status, 413);
    const j = await r.json();
    assert.equal(j.type, 'payload_too_large');
  } finally {
    server.close();
  }
});

test('全局限速：第二个请求超出突发 → 429 rate_limited', async () => {
  const { server, base, proxyAuth } = await startServer({ proxyToken: 'ptok', rateLimitRps: 1, rateLimitBurst: 0 });
  try {
    const opts = {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: proxyAuth },
      body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
    };
    const r1 = await fetch(`${base}/v1/chat/completions`, opts);
    const r2 = await fetch(`${base}/v1/chat/completions`, opts);
    // 首请求应通过鉴权（号池空 → 502），表明未被限速
    assert.equal(r1.status, 502);
    // 第二个请求令牌已耗尽（burst=0）→ 429
    assert.equal(r2.status, 429);
    const j = await r2.json();
    assert.equal(j.type, 'rate_limited');
  } finally {
    server.close();
  }
});

test('admin/reload：无 token → 401；带 token → 200 并返回账号数', async () => {
  const { server, base, auth } = await startServer();
  try {
    let r = await fetch(`${base}/admin/reload`, { method: 'POST' });
    assert.equal(r.status, 401);
    r = await fetch(`${base}/admin/reload`, { method: 'POST', headers: { Authorization: auth } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.accounts, 0);
  } finally {
    server.close();
  }
});

test('Token 用量采集：成功后从 usage 累计到指标与账号', async () => {
  // 启动一个真实上游，返回带 usage 的非流式 JSON
  const upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upBase = `http://127.0.0.1:${upstream.address().port}`;

  const { server, base, auth, proxyAuth } = await startServer({ proxyToken: 'ptok' });
  try {
    // 注册指向该上游的账号
    const add = await fetch(`${base}/admin/pool`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ name: 'UP', baseUrl: upBase, apiKey: 'k', models: 'm1' }),
    });
    const id = (await add.json()).account.id;

    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: proxyAuth },
      body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.status, 200);
    await r.text();

    // 指标应累计 20 tokens
    const mj = await (await fetch(`${base}/metrics`, { headers: { Authorization: auth } })).json();
    assert.equal(mj.totalTokens, 20, '指标 totalTokens 应为 20');
    assert.equal(mj.totalPromptTokens, 12);
    assert.equal(mj.totalCompletionTokens, 8);

    // 账号累计也应体现
    const pj = (await (await fetch(`${base}/admin/pool`, { headers: { Authorization: auth } })).json());
    const acct = pj.accounts.find((a) => a.id === id);
    assert.equal(acct.totalTokens, 20);
  } finally {
    server.close();
    upstream.close();
  }
});

test('admin/pool/:id/edit：改 models/groups/weight/note/modelWeights（受 token 保护）', async () => {
  const { server, base, auth } = await startServer();
  try {
    let r = await fetch(`${base}/admin/pool`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ name: 'A', baseUrl: 'http://x', apiKey: 'k', models: 'm1' }),
    });
    const id = (await r.json()).account.id;

    // 无 token → 401
    r = await fetch(`${base}/admin/pool/${id}/edit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weight: 5 }) });
    assert.equal(r.status, 401);

    // 带 token 改字段
    r = await fetch(`${base}/admin/pool/${id}/edit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ models: 'm2,m3', groups: 'g1', weight: 7, note: '主用', modelWeights: { 'm2': 3 } }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.account.models, ['m2', 'm3']);
    assert.deepEqual(j.account.groups, ['g1']);
    assert.equal(j.account.weight, 7);
    assert.equal(j.account.note, '主用');
    assert.deepEqual(j.account.modelWeights, { 'm2': 3 });

    // 非法 JSON → 400
    r = await fetch(`${base}/admin/pool/${id}/edit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{bad' });
    assert.equal(r.status, 400);
  } finally {
    server.close();
  }
});

test('备份/恢复：GET /admin/backup 下载；POST /admin/restore 整体替换', async () => {
  const { server, base, auth } = await startServer();
  try {
    // 先加两个账号
    await fetch(`${base}/admin/pool`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'm1' }),
    });
    await fetch(`${base}/admin/pool`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ name: 'B', baseUrl: 'http://b', apiKey: 'k', models: 'm2' }),
    });

    // 无 token → 401
    let r = await fetch(`${base}/admin/backup`);
    assert.equal(r.status, 401);

    // 备份
    r = await fetch(`${base}/admin/backup`, { headers: { Authorization: auth } });
    assert.equal(r.status, 200);
    const backup = await r.json();
    assert.equal(backup.length, 2);

    // 恢复（替换成单个账号）
    r = await fetch(`${base}/admin/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify([{ name: 'C', baseUrl: 'http://c', apiKey: 'k', models: 'm9' }]),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.accounts, 1);

    const pj = (await (await fetch(`${base}/admin/pool`, { headers: { Authorization: auth } })).json());
    assert.equal(pj.accounts.length, 1);
    assert.equal(pj.accounts[0].name, 'C');

    // 非法 JSON → 400
    r = await fetch(`${base}/admin/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{bad',
    });
    assert.equal(r.status, 400);
  } finally {
    server.close();
  }
});

test('软删除/恢复/purge：remove 软删可恢复，purge 彻底删', async () => {
  const { server, base, auth } = await startServer();
  try {
    let r = await fetch(`${base}/admin/pool`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ name: 'A', baseUrl: 'http://x', apiKey: 'k', models: 'm1' }),
    });
    const id = (await r.json()).account.id;

    // 软删除：号池概览应不再包含（隐藏），但 store 仍保留
    r = await fetch(`${base}/admin/pool/${id}/remove`, { method: 'POST', headers: { Authorization: auth } });
    assert.equal((await r.json()).soft, true);
    let pj = (await (await fetch(`${base}/admin/pool`, { headers: { Authorization: auth } })).json());
    assert.equal(pj.accounts.length, 0, '软删除后概览应隐藏该账号');

    // 恢复
    r = await fetch(`${base}/admin/pool/${id}/restore`, { method: 'POST', headers: { Authorization: auth } });
    assert.equal(r.status, 200);
    pj = (await (await fetch(`${base}/admin/pool`, { headers: { Authorization: auth } })).json());
    assert.equal(pj.accounts.length, 1, '恢复后重新出现');

    // 彻底删除
    r = await fetch(`${base}/admin/pool/${id}/purge`, { method: 'POST', headers: { Authorization: auth } });
    assert.equal((await r.json()).purged, id);
    // 已彻底删除，store.get 应找不到
    r = await fetch(`${base}/admin/pool/${id}/restore`, { method: 'POST', headers: { Authorization: auth } });
    assert.equal(r.status, 404, 'purge 后恢复应 404');
  } finally {
    server.close();
  }
});
