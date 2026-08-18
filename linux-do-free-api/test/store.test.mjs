import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createAccount } from '../src/account.js';

test('validate：报告非法 baseUrl（error）与空 apiKey（warning）', () => {
  const s = new Store('/tmp/ldfa-test-store.json');
  s.accounts = [
    createAccount({ name: 'bad', baseUrl: 'not-a-url', apiKey: 'k' }),
    createAccount({ name: 'nokey', baseUrl: 'https://x', apiKey: '' }),
  ];
  const problems = s.validate();
  const errs = problems.filter((p) => p.level === 'error');
  const warns = problems.filter((p) => p.level === 'warning');
  assert.ok(errs.some((p) => p.name === 'bad'), '非法 baseUrl 应为 error');
  assert.ok(warns.some((p) => p.name === 'nokey'), '空 apiKey 应为 warning');
});

test('validate：正常配置无问题', () => {
  const s = new Store('/tmp/ldfa-test-store.json');
  s.accounts = [createAccount({ name: 'ok', baseUrl: 'https://x', apiKey: 'k', models: 'm1' })];
  assert.equal(s.validate().length, 0);
});

test('validate：modelWeights 非法项给出 warning', () => {
  const s = new Store('/tmp/ldfa-test-store.json');
  s.accounts = [
    createAccount({ name: 'mw-bad', baseUrl: 'https://x', apiKey: 'k', models: 'm1', modelWeights: { m1: -1 } }),
  ];
  const warns = s.validate().filter((p) => p.level === 'warning');
  assert.ok(warns.some((p) => p.msg.includes('modelWeights')), '权重非法应给出 modelWeights 警告');
});

test('validate：重复 apiKey 与重复 name 给出 warning，且分组去重', () => {
  const s = new Store('/tmp/ldfa-test-store.json');
  s.accounts = [
    createAccount({ name: 'dup1', baseUrl: 'https://x', apiKey: 'SAMEKEY', models: 'm1' }),
    createAccount({ name: 'dup2', baseUrl: 'https://x', apiKey: 'SAMEKEY', models: 'm1' }),
    createAccount({ name: 'same', baseUrl: 'https://x', apiKey: 'k2', models: 'm1' }),
    createAccount({ name: 'same', baseUrl: 'https://x', apiKey: 'k3', models: 'm1' }),
    createAccount({ name: 'g', baseUrl: 'https://x', apiKey: 'k4', models: 'm1', groups: 'g1,g1,g2' }),
  ];
  const warns = s.validate().filter((p) => p.level === 'warning');
  assert.ok(warns.some((p) => p.msg.includes('apiKey 与')), '重复 apiKey 应提示');
  assert.ok(warns.some((p) => p.msg.includes('账号名重复')), '重复 name 应提示');
  // createAccount 已对分组去重（规范化阶段静默去重）
  const gAcct = s.accounts[4];
  assert.deepEqual(gAcct.groups, ['g1', 'g2'], '分组应被去重');
});

