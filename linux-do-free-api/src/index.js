import { Store } from './store.js';
import { AccountPool } from './pool.js';
import { createServer } from './server.js';

const PORT = Number(process.env.PORT || 3090);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = process.env.DATA_FILE || new URL('../data/accounts.json', import.meta.url).pathname;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const store = new Store(DATA_FILE);
store.load();
const pool = new AccountPool(store);

const server = createServer(pool, { adminToken: ADMIN_TOKEN });
server.listen(PORT, HOST, () => {
  console.log(`[linux-do-free-api] 代理已启动: http://${HOST}:${PORT}`);
  console.log(`[linux-do-free-api] 号池账号数: ${pool.accounts.length}`);
  console.log(`[linux-do-free-api] 可用模型: ${pool.allModels().join(', ') || '(空，请用 cli add 添加)'}`);
  console.log(`[linux-do-free-api] 端点: POST http://${HOST}:${PORT}/v1/chat/completions`);
});
