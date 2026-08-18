import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';
import { AccountPool } from './pool.js';
import { createServer } from './server.js';
import { parseImport, importAccounts } from './import.js';

const DATA_FILE = process.env.DATA_FILE || new URL('../data/accounts.json', import.meta.url).pathname;

const store = new Store(DATA_FILE);
store.load();
const pool = new AccountPool(store);

const [cmd, ...rest] = process.argv.slice(2);

// 极简 --key value 解析（零依赖）
function parseKv(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

// 统计各分组的账号数
function groupDistribution(accounts) {
  const dist = {};
  for (const a of accounts) {
    const gs = a.groups && a.groups.length ? a.groups : ['(无分组)'];
    for (const g of gs) dist[g] = (dist[g] || 0) + 1;
  }
  return dist;
}

// 解析模型别名：优先 config/aliases.json，其次 ALIASES 环境变量（"alias:real1,real2;..."）
function resolveAliases(envStr, dataFile) {
  const candidates = [
    path.join(process.cwd(), 'config', 'aliases.json'),
    path.join(path.dirname(dataFile || ''), 'aliases.json'),
  ];
  for (const f of candidates) {
    try {
      const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (obj && typeof obj === 'object') return obj;
    } catch {}
  }
  return AccountPool.parseAliases(envStr);
}

switch (cmd) {
  case 'add': {
    const o = parseKv(rest);
    if (!o['base-url'] || !o['api-key']) {
      console.error('用法: add --base-url <url> --api-key <key> [--name <n>] [--models m1,m2] [--groups g1,g2] [--weight n]');
      process.exit(1);
    }
    const a = store.add({
      name: o.name || o['base-url'],
      baseUrl: o['base-url'],
      apiKey: o['api-key'],
      models: o.models || '',
      groups: o.groups || '',
      weight: o.weight,
    });
    console.log(`已添加账号 ${a.id} (${a.name})`);
    console.log(`  模型: ${a.models.join(', ') || '(未指定，将匹配任意模型)'}`);
    console.log(`  分组: ${a.groups.join(', ') || '(无)'}`);
    break;
  }
  case 'list': {
    const o = parseKv(rest);
    let accounts = pool.summary();
    if (o.group) accounts = accounts.filter((a) => (a.groups || []).includes(o.group));
    if (accounts.length === 0) {
      console.log('号池为空，用 `node src/cli.js add` 添加账号');
    } else {
      console.table(accounts.map((s) => ({ ...s, models: s.models.join(',') })));
    }
    break;
  }
  case 'remove':
  case 'purge':
  case 'restore':
  case 'enable':
  case 'disable': {
    const o = parseKv(rest);
    const id = o.id || rest[0];
    // 批量目标：--all 全部 / --group <g> 该组 / --id 单个
    let targets = [];
    if (o.all) {
      targets = pool.accounts.slice();
    } else if (o.group) {
      targets = pool.accounts.filter((a) => (a.groups || []).includes(o.group));
      if (targets.length === 0) { console.error(`分组 ${o.group} 下没有账号`); process.exit(1); }
    } else if (id) {
      const a = store.get(id);
      if (!a) { console.error('未找到账号', id); process.exit(1); }
      targets = [a];
    } else {
      console.error(`用法: ${cmd} --id <id> | --all | --group <g>`);
      process.exit(1);
    }
    let count = 0;
    for (const a of targets) {
      if (cmd === 'remove') store.remove(a.id);
      else if (cmd === 'purge') store.purge(a.id);
      else if (cmd === 'restore') store.restore(a.id);
      else if (cmd === 'disable') { a.status = 'disabled'; a.enabled = false; }
      else if (cmd === 'enable') { a.status = 'active'; a.enabled = true; a.cooldownUntil = null; }
      count++;
    }
    if (['disable', 'enable'].includes(cmd)) store.save();
    const verb = { remove: '软删除', purge: '彻底删除', restore: '恢复', disable: '禁用', enable: '启用' }[cmd];
    console.log(`已${verb} ${count} 个账号${o.group ? `（分组 ${o.group}）` : o.all ? '（全部）' : ''}`);
    break;
  }
  case 'status': {
    const total = pool.accounts.length;
    const active = pool.accounts.filter((a) => a.status === 'active' && a.enabled).length;
    const exhausted = pool.accounts.filter((a) => a.status === 'exhausted').length;
    const disabled = pool.accounts.filter((a) => a.status === 'disabled' || !a.enabled).length;
    console.log(`账号总数: ${total} | 可用: ${active} | 额度耗尽: ${exhausted} | 已禁用: ${disabled}`);
    console.log('模型覆盖:', pool.allModels().join(', ') || '(空)');
    break;
  }
  case 'stats': {
    const o = parseKv(rest);
    let accounts = pool.summary();
    if (o.group) accounts = accounts.filter((a) => (a.groups || []).includes(o.group));
    const total = accounts.length;
    const active = accounts.filter((a) => a.status === 'active' && a.enabled).length;
    const exhausted = accounts.filter((a) => a.status === 'exhausted').length;
    const disabled = accounts.filter((a) => a.status === 'disabled' || !a.enabled).length;
    const removed = pool.accounts.filter((a) => a.status === 'removed').length;
    const totalTokens = accounts.reduce((s, a) => s + (a.totalTokens || 0), 0);
    console.log('=== 号池统计 ===');
    console.log(`可见账号: ${total} | 可用: ${active} | 额度耗尽: ${exhausted} | 禁用: ${disabled}`);
    console.log(`软删除(可恢复): ${removed}`);
    console.log(`累计 Token: ${totalTokens}`);
    console.log('分组分布:', JSON.stringify(groupDistribution(accounts)));
    console.log('模型覆盖:', pool.allModels().join(', ') || '(空)');
    break;
  }
  case 'validate': {
    const problems = store.validate();
    if (problems.length === 0) {
      console.log('配置校验通过，未发现错误。');
      break;
    }
    const errors = problems.filter((p) => p.level === 'error');
    const warnings = problems.filter((p) => p.level === 'warning');
    console.log(`发现 ${problems.length} 个问题（错误 ${errors.length}，警告 ${warnings.length}）：`);
    problems.forEach((p) => console.log(`  [${p.level}] ${p.name} (${p.id}): ${p.msg}`));
    if (errors.length) process.exitCode = 1;
    break;
  }
  case 'export': {
    const o = parseKv(rest);
    const payload = JSON.stringify(store.accounts, null, 2);
    if (o.out) {
      fs.writeFileSync(o.out, payload);
      console.log(`已导出 ${store.accounts.length} 个账号到 ${o.out}`);
    } else {
      process.stdout.write(payload + '\n');
    }
    break;
  }
  case 'show': {
    const o = parseKv(rest);
    const id = o.id || rest[0];
    const a = store.get(id);
    if (!a) {
      console.error('未找到账号', id);
      process.exit(1);
    }
    console.log(JSON.stringify(a, null, 2));
    break;
  }
  case 'restore': {
    const o = parseKv(rest);
    const file = o.file || rest[0];
    if (!file) {
      console.error('用法: restore --file <path>');
      process.exit(1);
    }
    let arr;
    try {
      arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.error('解析失败:', e.message);
      process.exit(1);
    }
    try {
      const n = store.replaceAccounts(arr);
      console.log(`已从 ${file} 恢复 ${n} 个账号`);
    } catch (e) {
      console.error('恢复失败:', e.message);
      process.exit(1);
    }
    break;
  }
  case 'serve':
  case 'start': {
    const PORT = Number(process.env.PORT || 3090);
    const HOST = process.env.HOST || '127.0.0.1';
    const upstreamTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS) || 60000;
    const connectTimeoutMs = Number(process.env.CONNECT_TIMEOUT_MS) || 8000;
    const streamIdleTimeoutMs = Number(process.env.STREAM_IDLE_TIMEOUT_MS) || 30000;
    const maxConcurrency = Number(process.env.MAX_CONCURRENCY_PER_ACCOUNT) || 0;
    const circuitLimit = Number(process.env.CONSECUTIVE_FAILURE_LIMIT) || 0;
    const allowCors = process.env.ALLOW_CORS || '';
    const problems = store.validate();
    const errors = problems.filter((p) => p.level === 'error');
    if (errors.length) {
      console.error(`[配置校验] ${errors.length} 个错误：`);
      errors.forEach((p) => console.error(`  [error] ${p.name}: ${p.msg}`));
    }
    const warnings = problems.filter((p) => p.level === 'warning');
    if (warnings.length) {
      console.error(`[配置校验] ${warnings.length} 个警告（如 apiKey 缺失），运行 'node src/cli.js validate' 查看详情`);
    }
    const strategy = process.env.POOL_STRATEGY || 'weighted';
    const aliases = resolveAliases(process.env.ALIASES, DATA_FILE);
    const servePool = new AccountPool(store, { strategy, aliases });
    createServer(servePool, {
      adminToken: process.env.ADMIN_TOKEN || '',
      proxyToken: process.env.PROXY_AUTH_TOKEN || '',
      upstreamTimeoutMs,
      connectTimeoutMs,
      streamIdleTimeoutMs,
      maxConcurrency,
      circuitLimit,
      allowCors,
      logFile: process.env.LOG_FILE || '',
    }).listen(PORT, HOST, () => {
      console.log(`[linux-do-free-api] 代理已启动: http://${HOST}:${PORT}`);
      console.log(`[linux-do-free-api] 号池账号数: ${pool.accounts.length}，可用模型: ${pool.allModels().join(', ') || '(空)'}`);
      // 启动预检：打印号池累计 Token（来自持久化的各账号用量），便于快速判断号池历史负载
      const tokenTotals = pool.summary().reduce(
        (acc, s) => {
          acc.prompt += s.promptTokens || 0;
          acc.completion += s.completionTokens || 0;
          acc.total += s.totalTokens || 0;
          return acc;
        },
        { prompt: 0, completion: 0, total: 0 }
      );
      console.log(`[linux-do-free-api] 号池累计 Token: ${tokenTotals.total}（prompt ${tokenTotals.prompt} / completion ${tokenTotals.completion}）`);
      if (process.env.PROXY_AUTH_TOKEN) console.log(`[linux-do-free-api] 代理端已启用令牌保护 (PROXY_AUTH_TOKEN)`);
    });
    break;
  }
  case 'edit': {
    const o = parseKv(rest);
    const id = o.id || rest[0];
    const a = store.get(id);
    if (!a) {
      console.error('未找到账号', id);
      process.exit(1);
    }
    if (o.name !== undefined) a.name = o.name;
    if (o['base-url'] !== undefined) a.baseUrl = o['base-url'].replace(/\/+$/, '');
    if (o['api-key'] !== undefined) a.apiKey = o['api-key'];
    if (o.models !== undefined) {
      a.models = String(o.models).split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (o.groups !== undefined) {
      a.groups = String(o.groups).split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (o.weight !== undefined) a.weight = Number(o.weight) || 1;
    if (o['cooldown-ms'] !== undefined) a.cooldownMs = Number(o['cooldown-ms']) || a.cooldownMs;
    if (o.note !== undefined) a.note = o.note ? String(o.note).slice(0, 500) : null;
    if (o['model-weights'] !== undefined) {
      try {
        const mw = JSON.parse(o['model-weights']);
        const clean = {};
        for (const [k, v] of Object.entries(mw)) { const n = Number(v); if (Number.isFinite(n) && n > 0) clean[k] = n; }
        a.modelWeights = Object.keys(clean).length ? clean : null;
      } catch {
        console.error('model-weights 不是合法 JSON');
        process.exit(1);
      }
    }
    if (o.enable === true) { a.enabled = true; a.status = 'active'; a.cooldownUntil = null; }
    if (o.disable === true) { a.enabled = false; a.status = 'disabled'; }
    a.updatedAt = Date.now();
    store.save();
    console.log(`账号 ${id} 已更新:`, {
      name: a.name,
      baseUrl: a.baseUrl,
      models: a.models.join(',') || '(空)',
      groups: a.groups.join(',') || '(无)',
      weight: a.weight,
      enabled: a.enabled,
    });
    break;
  }
  case 'import': {
    const o = parseKv(rest);
    const file = o.file;
    const url = o.url;
    const format = o.format || 'auto';
    const dryRun = !!o['dry-run'];
    const prefix = o['name-prefix'] || '';
    if (!file && !url) {
      console.error('用法: import --file <path> | --url <url> [--format auto|json|env|codex|oneapi|nextchat] [--dry-run] [--name-prefix <p>]');
      process.exit(1);
    }
    let text;
    if (url) {
      const resp = await fetch(url);
      text = await resp.text();
    } else {
      text = fs.readFileSync(file, 'utf8');
    }
    let candidates;
    try {
      candidates = parseImport(text, { format });
    } catch (e) {
      console.error('解析失败:', e.message);
      process.exit(1);
    }
    if (candidates.length === 0) {
      console.log('未从中解析到任何账号（检查格式或字段名 base_url / api_key）');
      process.exit(0);
    }
    const { added, skipped } = importAccounts(store, candidates, { dryRun, prefix });
    console.log(
      `解析到 ${candidates.length} 个候选账号 → 新增 ${added.length}，跳过 ${skipped.length}` +
        (dryRun ? '（dry-run，未写入）' : '')
    );
    console.table(added.map((a) => ({ name: a.name, baseUrl: a.baseUrl, models: (a.models || []).join(',') || '(空)', status: a.status || 'active' })));
    if (skipped.length) console.log('已跳过（号池已存在）:', skipped.map((s) => s.name).join(', '));
    break;
  }
  default: {
    console.log(`linux-do-free-api 号池管理

用法: node src/cli.js <命令> [选项]

命令:
  add      --base-url <url> --api-key <key> [--name <n>] [--models m1,m2] [--groups g1,g2] [--weight n]
  edit     --id <id> [--name <n>] [--base-url <url>] [--api-key <key>] [--models m1,m2] [--groups g1,g2] [--weight n] [--cooldown-ms <ms>] [--note <text>] [--model-weights '{"m":3}'] [--enable|--disable]
  import   --file <path> | --url <url> [--format auto|json|env|codex|oneapi|nextchat] [--dry-run] [--name-prefix <p>]
  list     [--group <g>]    列出号池（可按分组过滤）
  remove   --id <id> | --all | --group <g>   软删除账号（可用 restore 恢复）
  purge    --id <id> | --all | --group <g>   彻底删除账号（不可恢复）
  restore  --id <id> | --all | --group <g>   恢复被软删除的账号
  enable   --id <id> | --all | --group <g>   启用账号
  disable  --id <id> | --all | --group <g>   禁用账号
  show     --id <id>        查看单个账号详情（含运行时状态）
  status   号池健康概览
  stats    [--group <g>]    号池统计（账号状态分布 / Token / 分组）
  export   [--out <file>]   导出号池为 JSON（备份；不带 --out 则输出到 stdout）
  restore  --file <path>    从 JSON 文件整体恢复号池（覆盖当前）
  validate 校验号池配置，列出错误与警告
  serve    启动代理（默认端口 3090）

环境变量:
  PORT / HOST / DATA_FILE / ADMIN_TOKEN / PROXY_AUTH_TOKEN
  UPSTREAM_TIMEOUT_MS / CONNECT_TIMEOUT_MS / STREAM_IDLE_TIMEOUT_MS
  MAX_CONCURRENCY_PER_ACCOUNT / CONSECUTIVE_FAILURE_LIMIT / ALLOW_CORS
  LOG_LEVEL / LOG_FILE[=/path] / LOG_FILE_MAX_BYTES / LOG_FILE_KEEP
  POOL_STRATEGY / ALIASES
`);
  }
}
