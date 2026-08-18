import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccount } from '../src/account.js';
import { AccountPool } from '../src/pool.js';

function makeStore(accounts) {
  return { accounts: accounts.map((a) => createAccount(a)), save() {} };
}

test('candidatesForModel：按模型+健康过滤并复活过期 exhausted', () => {
  const pool = new AccountPool(makeStore([
    { name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'm1', status: 'exhausted', cooldownUntil: Date.now() - 1 },
    { name: 'B', baseUrl: 'http://b', apiKey: 'k', models: 'm1', status: 'disabled' },
    { name: 'C', baseUrl: 'http://c', apiKey: 'k', models: 'm2' },
  ]));
  const names = pool.candidatesForModel('m1').map((a) => a.name);
  assert.ok(names.includes('A'), '过期 exhausted 应被复活');
  assert.ok(!names.includes('B'), 'disabled 应被排除');
});

test('select：返回支持模型且健康的账号；无候选返回 null', () => {
  const pool = new AccountPool(makeStore([{ name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'm1' }]));
  assert.equal(pool.select('m1').name, 'A');
  assert.equal(pool.select('nope'), null);
});

test('allModels：去重并集', () => {
  const pool = new AccountPool(makeStore([
    { name: 'A', baseUrl: 'http://a', apiKey: 'k', models: ['m1', 'm2'] },
    { name: 'B', baseUrl: 'http://b', apiKey: 'k', models: ['m2', 'm3'] },
  ]));
  assert.deepEqual(pool.allModels(), ['m1', 'm2', 'm3']);
});

test('别名匹配：请求别名命中真名账号（正向）', () => {
  const pool = new AccountPool(makeStore([{ name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'DeepSeek-V3' }]), {
    aliases: { 'deepseek-chat': ['DeepSeek-V3'] },
  });
  assert.deepEqual(pool.candidatesForModel('deepseek-chat').map((a) => a.name), ['A']);
});

test('别名匹配：请求真名命中别名配置的账号（反向）', () => {
  const pool = new AccountPool(makeStore([{ name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'DeepSeek-V3' }]), {
    aliases: { 'deepseek-chat': ['DeepSeek-V3'] },
  });
  assert.deepEqual(pool.candidatesForModel('DeepSeek-V3').map((a) => a.name), ['A']);
});

test('策略 round_robin 轮流', () => {
  const pool = new AccountPool(makeStore([
    { name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'm1' },
    { name: 'B', baseUrl: 'http://b', apiKey: 'k', models: 'm1' },
  ]), { strategy: 'round_robin' });
  assert.deepEqual([pool.select('m1').name, pool.select('m1').name, pool.select('m1').name], ['A', 'B', 'A']);
});

test('策略 least_used 选用量最少', () => {
  const pool = new AccountPool(makeStore([
    { name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'm1', used: 5 },
    { name: 'B', baseUrl: 'http://b', apiKey: 'k', models: 'm1', used: 2 },
  ]), { strategy: 'least_used' });
  assert.equal(pool.select('m1').name, 'B');
});

test('parseAliases 解析', () => {
  assert.deepEqual(AccountPool.parseAliases('deepseek-chat:DeepSeek-V3,DeepSeek-V2.5;gpt:abab'), {
    'deepseek-chat': ['DeepSeek-V3', 'DeepSeek-V2.5'],
    gpt: ['abab'],
  });
});

test('分组过滤：candidatesForModel 仅返回属于指定 group 的账号', () => {
  const pool = new AccountPool(makeStore([
    { name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'm1', groups: 'premium' },
    { name: 'B', baseUrl: 'http://b', apiKey: 'k', models: 'm1', groups: 'free' },
    { name: 'C', baseUrl: 'http://c', apiKey: 'k', models: 'm1' }, // 无分组
  ]));
  const premium = pool.candidatesForModel('m1', { group: 'premium' }).map((a) => a.name);
  assert.deepEqual(premium, ['A']);
  const all = pool.candidatesForModel('m1').map((a) => a.name).sort();
  assert.deepEqual(all, ['A', 'B', 'C']);
  // 不带 group 时，无分组账号仍可被选中
  assert.ok(pool.candidatesForModel('m1', { group: 'nope' }).length === 0, '不存在的分组应无候选');
});

test('select 透传 group', () => {
  const pool = new AccountPool(makeStore([
    { name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'm1', groups: 'premium' },
    { name: 'B', baseUrl: 'http://b', apiKey: 'k', models: 'm1', groups: 'free' },
  ]));
  assert.equal(pool.select('m1', { group: 'premium' }).name, 'A');
  assert.equal(pool.select('m1', { group: 'free' }).name, 'B');
});

test('summary 包含 groups', () => {
  const pool = new AccountPool(makeStore([{ name: 'A', baseUrl: 'http://a', apiKey: 'k', models: 'm1', groups: 'g1,g2' }]));
  assert.deepEqual(pool.summary()[0].groups, ['g1', 'g2']);
});
