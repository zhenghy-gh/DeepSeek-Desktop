import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRotatingFileStream, createLogger } from '../src/logger.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ldfa-log-'));
}

test('createRotatingFileStream：超出 maxBytes 后轮转生成 .1', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'app.log');
  const rf = createRotatingFileStream(file, { maxBytes: 50, keep: 3 });
  rf.write('line1\n'); // ~6B
  rf.write('line2\n'); // ~6B  累计 12B < 50
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(file + '.1'), '尚未轮转');
  // 反复写到超过阈值
  for (let i = 0; i < 20; i++) rf.write('x'.repeat(20) + '\n');
  rf.end();
  assert.ok(fs.existsSync(file + '.1'), '应已轮转出 .1');
  assert.ok(fs.statSync(file).size < 50 * 30, '当前文件应已重置为较小');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createLogger：file 写入且等级过滤生效', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'app.log');
  const log = createLogger({ level: 'warn', file });
  log.debug('hidden');
  log.info('hidden too');
  log.warn('visible');
  log.error('err');
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(!content.includes('hidden'), 'debug 应被过滤');
  assert.ok(!content.includes('hidden too'), 'info 应被过滤');
  assert.ok(content.includes('"lvl":"warn"'));
  assert.ok(content.includes('"lvl":"error"'));
  fs.rmSync(dir, { recursive: true, force: true });
});
