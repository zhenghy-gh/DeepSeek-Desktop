import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { AccountPool } from './pool.js';
import { createServer } from './server.js';
import { createLogger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3090);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'accounts.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PROXY_AUTH_TOKEN = process.env.PROXY_AUTH_TOKEN || '';
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 60000;
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS) || 8000;
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.STREAM_IDLE_TIMEOUT_MS) || 30000;
const MAX_CONCURRENCY_PER_ACCOUNT = Number(process.env.MAX_CONCURRENCY_PER_ACCOUNT) || 0;
const CONSECUTIVE_FAILURE_LIMIT = Number(process.env.CONSECUTIVE_FAILURE_LIMIT) || 0;
const ALLOW_CORS = process.env.ALLOW_CORS || '';
const MAX_REQUEST_BODY_BYTES = Number(process.env.MAX_REQUEST_BODY_BYTES) || 10 * 1024 * 1024;
const RATE_LIMIT_RPS = Number(process.env.RATE_LIMIT_RPS) || 0;
const RATE_LIMIT_BURST = Number(process.env.RATE_LIMIT_BURST) || 0;
const WATCH_CONFIG = process.env.WATCH_CONFIG !== 'false';
const POOL_STRATEGY = process.env.POOL_STRATEGY || 'weighted';
// 可选价格表（config/prices.json）：{ model: { prompt: 每1k USD, completion: 每1k USD } }，用于估算成本
function resolvePrices() {
  for (const f of [path.join(process.cwd(), 'config', 'prices.json'), path.join(__dirname, '..', 'config', 'prices.json')]) {
    try {
      const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (obj && typeof obj === 'object') return obj;
    } catch {}
  }
  return null;
}
const PRICES = resolvePrices();

// 解析模型别名：优先 config/aliases.json，其次 ALIASES 环境变量
function resolveAliases(envStr) {
  const candidates = [
    path.join(process.cwd(), 'config', 'aliases.json'),
    path.join(__dirname, '..', 'config', 'aliases.json'),
  ];
  for (const f of candidates) {
    try {
      const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (obj && typeof obj === 'object') return obj;
    } catch {}
  }
  return AccountPool.parseAliases(envStr);
}

const store = new Store(DATA_FILE);
store.load();
const pool = new AccountPool(store, { strategy: POOL_STRATEGY, aliases: resolveAliases(process.env.ALIASES) });

// 共享日志器（便于优雅退出时 flush）
const log = createLogger({ file: process.env.LOG_FILE || '' });

const server = createServer(pool, {
  adminToken: ADMIN_TOKEN,
  proxyToken: PROXY_AUTH_TOKEN,
  upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
  connectTimeoutMs: CONNECT_TIMEOUT_MS,
  streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
  maxConcurrency: MAX_CONCURRENCY_PER_ACCOUNT,
  circuitLimit: CONSECUTIVE_FAILURE_LIMIT,
  allowCors: ALLOW_CORS,
  maxBodyBytes: MAX_REQUEST_BODY_BYTES,
  rateLimitRps: RATE_LIMIT_RPS,
  rateLimitBurst: RATE_LIMIT_BURST,
  prices: PRICES,
  log,
});
server.listen(PORT, HOST, () => {
  console.log(`[linux-do-free-api] 代理已启动: http://${HOST}:${PORT}`);
  console.log(`[linux-do-free-api] 号池账号数: ${pool.accounts.length}`);
  // 启动预检：号池累计 Token（来自持久化用量），快速判断历史负载
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
  console.log(`[linux-do-free-api] 可用模型: ${pool.allModels().join(', ') || '(空，请用 cli add 添加)'}`);
  console.log(`[linux-do-free-api] 选号策略: ${POOL_STRATEGY} | 端点: POST http://${HOST}:${PORT}/v1/chat/completions`);
  console.log(`[linux-do-free-api] 只读管理页: http://${HOST}:${PORT}/`);
  if (ADMIN_TOKEN) console.log(`[linux-do-free-api] 管理端已启用令牌保护 (ADMIN_TOKEN)`);
  if (PROXY_AUTH_TOKEN) console.log(`[linux-do-free-api] 代理端已启用令牌保护 (PROXY_AUTH_TOKEN)`);
  if (MAX_CONCURRENCY_PER_ACCOUNT > 0) console.log(`[linux-do-free-api] 每账号并发上限: ${MAX_CONCURRENCY_PER_ACCOUNT}`);
  if (CONSECUTIVE_FAILURE_LIMIT > 0) console.log(`[linux-do-free-api] 熔断阈值(连续错误): ${CONSECUTIVE_FAILURE_LIMIT}`);
  if (RATE_LIMIT_RPS > 0) console.log(`[linux-do-free-api] 全局限速: ${RATE_LIMIT_RPS} rps (burst ${RATE_LIMIT_BURST || RATE_LIMIT_RPS})`);
  if (WATCH_CONFIG) console.log(`[linux-do-free-api] 配置热重载已开启 (WATCH_CONFIG)，编辑 ${DATA_FILE} 自动生效`);
});

// —— 配置热重载：监听号池文件变更，自动重载（无需重启进程）——
// 忽略自身 save 写入（store.lastSaveAt 时间窗内），仅响应外部编辑
if (WATCH_CONFIG && fs.existsSync(DATA_FILE)) {
  let reloadTimer = null;
  fs.watchFile(DATA_FILE, { interval: 1000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    if (Date.now() - (store.lastSaveAt || 0) < 1500) return; // 跳过自身 save
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      try {
        store.load();
        log.info('pool reloaded from disk', { reason: 'file change' });
        console.log(`[linux-do-free-api] 配置已热重载（文件变更）：账号数 ${pool.accounts.length}`);
      } catch (e) {
        log.error('pool reload failed', { error: e.message });
        console.error(`[linux-do-free-api] 配置热重载失败：${e.message}`);
      }
    }, 300);
  });
}

// —— 优雅退出：停止接收新连接，等待在途请求结束后再退出 ——
let shuttingDown = false;
const openSockets = new Set();
server.on('connection', (socket) => {
  openSockets.add(socket);
  socket.once('close', () => openSockets.delete(socket));
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown signal received', { signal });
  console.log(`[linux-do-free-api] 收到 ${signal}，正在优雅退出…`);
  server.close(() => {
    log.info('server closed', {});
    try { log.end(); } catch {}
    process.exit(0);
  });
  // 强制超时兜底：最多等 10s，避免长连接挂死
  const forceTimer = setTimeout(() => {
    console.log('[linux-do-free-api] 等待超时，强制退出');
    try { log.end(); } catch {}
    process.exit(0);
  }, 10000);
  forceTimer.unref?.();
  // 关闭所有空闲长连接，加速退出
  for (const s of openSockets) {
    if (!s.destroyed) s.destroy();
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
