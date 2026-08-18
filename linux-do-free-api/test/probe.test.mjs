import test from 'node:test';
import assert from 'node:assert/strict';
import { probeAccount, probeAccounts } from '../src/probe.js';

// 通过覆盖 globalThis.fetch 模拟上游，零依赖、可测
function mockFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = orig; };
}

test('probeAccount：上游 200 视为可达', async () => {
  const restore = mockFetch(async () => ({ ok: true, status: 200 }));
  try {
    const r = await probeAccount({ id: '1', name: 'A', baseUrl: 'http://up', apiKey: 'k' });
    assert.equal(r.reachable, true);
    assert.equal(r.status, 200);
  } finally {
    restore();
  }
});

test('probeAccount：上游 401 视为不可达（鉴权失败）', async () => {
  const restore = mockFetch(async () => ({ ok: false, status: 401 }));
  try {
    const r = await probeAccount({ id: '1', name: 'A', baseUrl: 'http://up', apiKey: 'k' });
    assert.equal(r.reachable, false);
    assert.equal(r.status, 401);
  } finally {
    restore();
  }
});

test('probeAccount：网络/超时错误捕获为不可达', async () => {
  const restore = mockFetch(async () => { throw new Error('ECONNREFUSED'); });
  try {
    const r = await probeAccount({ id: '1', name: 'A', baseUrl: 'http://up', apiKey: 'k' });
    assert.equal(r.reachable, false);
    assert.match(r.error, /ECONNREFUSED/);
  } finally {
    restore();
  }
});

test('probeAccounts：并发探活多个账号', async () => {
  const restore = mockFetch(async (url) => ({ ok: url.includes('ok'), status: url.includes('ok') ? 200 : 500 }));
  try {
    const results = await probeAccounts([
      { id: '1', name: 'A', baseUrl: 'http://ok', apiKey: 'k' },
      { id: '2', name: 'B', baseUrl: 'http://bad', apiKey: 'k' },
    ]);
    assert.equal(results[0].reachable, true);
    assert.equal(results[1].reachable, false);
  } finally {
    restore();
  }
});
