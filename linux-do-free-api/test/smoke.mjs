// 冒烟测试：用两个 mock 上游验证「额度耗尽自动切换」核心逻辑。
//   - 上游 A：返回 429（额度耗尽）→ 应被号池标记 exhausted 并冷却
//   - 上游 B：返回 200（正常）→ 应作为 failover 命中
// 期望：代理最终返回 200，且 A 被标记为 exhausted。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { AccountPool } from '../src/pool.js';
import { createServer } from '../src/server.js';

function mockUpstream(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

const exhausted = await mockUpstream((req, res) => {
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: { message: 'quota exhausted', type: 'insufficient_quota' } }));
});

const good = await mockUpstream((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'hello from B' } }] }));
});

const tmp = path.join(os.tmpdir(), `ldfa-test-${Date.now()}.json`);
const store = new Store(tmp);
store.add({ name: 'A', baseUrl: `http://127.0.0.1:${exhausted.address().port}`, apiKey: 'k', models: 'deepseek-chat' });
store.add({ name: 'B', baseUrl: `http://127.0.0.1:${good.address().port}`, apiKey: 'k', models: 'deepseek-chat' });
// 让 B 最近用过，确保优先选 A（验证 failover 真的从 A 切到 B）
store.accounts[1].lastUsedAt = Date.now();
store.save();

const pool = new AccountPool(store);
const server = createServer(pool, {});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
});
const json = await resp.json();

const a = store.get(store.accounts[0].id);
const b = store.get(store.accounts[1].id);

console.log('代理状态码:', resp.status);
console.log('回复内容:', JSON.stringify(json));
console.log('A 状态:', a.status, '| B 状态:', b.status);

const pass = resp.status === 200 && json.choices && a.status === 'exhausted';
console.log(pass ? 'SMOKE TEST PASSED ✅' : 'SMOKE TEST FAILED ❌');

server.close();
exhausted.close();
good.close();
fs.rmSync(tmp, { force: true });
process.exit(pass ? 0 : 1);
