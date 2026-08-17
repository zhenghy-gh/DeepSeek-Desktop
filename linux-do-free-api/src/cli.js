import { Store } from './store.js';
import { AccountPool } from './pool.js';
import { createServer } from './server.js';

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

switch (cmd) {
  case 'add': {
    const o = parseKv(rest);
    if (!o['base-url'] || !o['api-key']) {
      console.error('用法: add --base-url <url> --api-key <key> [--name <n>] [--models m1,m2] [--weight n]');
      process.exit(1);
    }
    const a = store.add({
      name: o.name || o['base-url'],
      baseUrl: o['base-url'],
      apiKey: o['api-key'],
      models: o.models || '',
      weight: o.weight,
    });
    console.log(`已添加账号 ${a.id} (${a.name})`);
    console.log(`  模型: ${a.models.join(', ') || '(未指定，将匹配任意模型)'}`);
    break;
  }
  case 'list': {
    if (pool.accounts.length === 0) {
      console.log('号池为空，用 `node src/cli.js add` 添加账号');
    } else {
      console.table(pool.summary().map((s) => ({ ...s, models: s.models.join(',') })));
    }
    break;
  }
  case 'remove': {
    const o = parseKv(rest);
    const id = o.id || rest[0];
    if (!id) {
      console.error('用法: remove --id <id>');
      process.exit(1);
    }
    store.remove(id);
    console.log(`已删除 ${id}`);
    break;
  }
  case 'enable':
  case 'disable': {
    const o = parseKv(rest);
    const id = o.id || rest[0];
    const a = store.get(id);
    if (!a) {
      console.error('未找到账号', id);
      process.exit(1);
    }
    if (cmd === 'disable') {
      a.status = 'disabled';
      a.enabled = false;
    } else {
      a.status = 'active';
      a.enabled = true;
      a.cooldownUntil = null;
    }
    store.save();
    console.log(`账号 ${id} 已${cmd === 'disable' ? '禁用' : '启用'}`);
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
  case 'serve':
  case 'start': {
    const PORT = Number(process.env.PORT || 3090);
    const HOST = process.env.HOST || '127.0.0.1';
    createServer(pool, { adminToken: process.env.ADMIN_TOKEN || '' }).listen(PORT, HOST, () => {
      console.log(`[linux-do-free-api] 代理已启动: http://${HOST}:${PORT}`);
      console.log(`[linux-do-free-api] 号池账号数: ${pool.accounts.length}，可用模型: ${pool.allModels().join(', ') || '(空)'}`);
    });
    break;
  }
  default: {
    console.log(`linux-do-free-api 号池管理

用法: node src/cli.js <命令> [选项]

命令:
  add      --base-url <url> --api-key <key> [--name <n>] [--models m1,m2] [--weight n]
  list     列出号池
  remove   --id <id>
  enable   --id <id>        启用账号
  disable  --id <id>        禁用账号
  status   号池健康概览
  serve    启动代理（默认端口 3090）

环境变量:
  PORT / HOST / DATA_FILE / ADMIN_TOKEN
`);
  }
}
