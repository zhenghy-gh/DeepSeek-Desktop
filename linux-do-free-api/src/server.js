import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { handleChatCompletion, handleWithFailover } from './router.js';
import { probeAccounts } from './probe.js';
import { Metrics } from './metrics.js';
import { createLogger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_HTML = path.join(__dirname, '..', 'web', 'index.html');

/** 简单令牌桶：每秒补充 rps 个令牌，桶容量 burst；rps<=0 表示不限速 */
class TokenBucket {
  constructor(rps, burst) {
    this.rps = rps;
    this.capacity = Math.max(burst || rps, 1);
    this.tokens = this.capacity;
    this.last = Date.now();
  }
  take() {
    if (this.rps <= 0) return true;
    const now = Date.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.rps);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

// 需透传给上游的客户端请求头白名单（不覆盖本地 Authorization/Content-Type）
const PASSTHROUGH_HEADER_KEYS = ['openai-organization', 'openai-beta'];
function buildPassthroughHeaders(req) {
  const out = {};
  for (const k of PASSTHROUGH_HEADER_KEYS) {
    if (req.headers[k]) out[k] = req.headers[k];
  }
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith('x-') && k.toLowerCase() !== 'x-ldfa-group') out[k] = v;
  }
  return out;
}

export function createServer(pool, opts = {}) {
  const {
    adminToken = '',
    proxyToken = '',
    upstreamTimeoutMs = 60000,
    connectTimeoutMs = 8000,
    streamIdleTimeoutMs = 30000,
    maxConcurrency = 0,
    circuitLimit = 0,
    allowCors = '',
    maxBodyBytes = 10 * 1024 * 1024,
    rateLimitRps = 0,
    rateLimitBurst = 0,
    prices = null,
    metrics,
    log,
    logFile,
    concurrency,
  } = opts;
  const metrics_ = metrics || new Metrics();
  const log_ = log || createLogger({ file: logFile });
  // 跨请求共享的「账号在途计数」表（并发上限用）
  const concurrency_ = concurrency || new Map();
  const bucket = new TokenBucket(rateLimitRps, rateLimitBurst);

  const server = http.createServer(async (req, res) => {
    const start = Date.now();
    const requestId = crypto.randomUUID();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    res.setHeader('X-Request-Id', requestId);

    // CORS：开启时对所有响应加头；OPTIONS 预检直接放行
    if (allowCors) {
      res.setHeader('Access-Control-Allow-Origin', allowCors);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-LDFA-Group, OpenAI-Organization, OpenAI-Beta, X-Request-Id');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    let status = 200;

    try {
      if (req.method === 'GET' && (path === '/' || path === '/web' || path === '/index.html')) {
        return serveStatic(res, WEB_HTML, 'text/html; charset=utf-8');
      }

      if (req.method === 'GET' && path === '/health') {
        return sendJson(res, 200, {
          ok: true,
          accounts: pool.accounts.length,
          models: pool.allModels().length,
          uptimeSec: metrics_.snapshot().uptimeSec,
          failures: metrics_.totalFailure,
          adminProtected: !!adminToken,
          proxyProtected: !!proxyToken,
          rateLimited: metrics_.totalRateLimited,
        });
      }

      if (req.method === 'GET' && path === '/v1/models') {
        const data = pool.allModels().map((id) => ({
          id,
          object: 'model',
          created: 0,
          owned_by: 'linux-do-free-api',
          available_accounts: pool.candidatesForModel(id).length,
        }));
        return sendJson(res, 200, { object: 'list', data });
      }

      // 指标端点：JSON 默认；?format=prometheus 输出 Prometheus 文本
      if (req.method === 'GET' && path === '/metrics') {
        if (!checkAdmin(req, adminToken)) return sendJson(res, 401, { error: 'unauthorized' });
        if (url.searchParams.get('format') === 'prometheus') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
          return res.end(metrics_.prometheus());
        }
        return sendJson(res, 200, metrics_.snapshot());
      }

      if (req.method === 'GET' && path === '/admin/pool') {
        if (!checkAdmin(req, adminToken)) return sendJson(res, 401, { error: 'unauthorized' });
        return sendJson(res, 200, { accounts: pool.summary() });
      }

      // 重置指标（受 ADMIN_TOKEN 保护），便于长期运行后清零统计
      if (req.method === 'POST' && path === '/admin/metrics/reset') {
        if (!checkAdmin(req, adminToken)) return sendJson(res, 401, { error: 'unauthorized' });
        metrics_.reset();
        log_.info('metrics reset', { requestId });
        return sendJson(res, 200, { ok: true, message: 'metrics reset' });
      }

      // 手动热重载号池（受 ADMIN_TOKEN 保护）：外部编辑 accounts.json 后无需重启即生效
      if (req.method === 'POST' && path === '/admin/reload') {
        if (!checkAdmin(req, adminToken)) return sendJson(res, 401, { error: 'unauthorized' });
        try {
          pool.store.load();
          log_.info('pool reloaded', { requestId });
          return sendJson(res, 200, { ok: true, accounts: pool.accounts.length });
        } catch (e) {
          return sendJson(res, 500, { error: e.message, type: 'internal' });
        }
      }

      // 备份：下载当前号池 JSON（受 ADMIN_TOKEN 保护）
      if (req.method === 'GET' && path === '/admin/backup') {
        if (!checkAdmin(req, adminToken)) return sendJson(res, 401, { error: 'unauthorized' });
        const buf = Buffer.from(JSON.stringify(pool.accounts, null, 2));
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="accounts-backup.json"');
        res.setHeader('Content-Length', buf.length);
        return res.end(buf);
      }

      // 恢复：用上传的 JSON 数组整体替换号池（受 ADMIN_TOKEN 保护）
      if (req.method === 'POST' && path === '/admin/restore') {
        if (!checkAdmin(req, adminToken)) return sendJson(res, 401, { error: 'unauthorized' });
        let body;
        try {
          body = await readBody(req, maxBodyBytes);
        } catch {
          return sendJson(res, 413, { error: 'request body too large', type: 'payload_too_large' });
        }
        let arr;
        try {
          arr = JSON.parse(body);
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON body', type: 'bad_request' });
        }
        try {
          const n = pool.store.replaceAccounts(arr);
          log_.info('pool restored', { requestId, count: n });
          return sendJson(res, 200, { ok: true, accounts: n });
        } catch (e) {
          return sendJson(res, 400, { error: e.message, type: 'bad_request' });
        }
      }

      // —— 号池管理 API（受 ADMIN_TOKEN 保护）——
      if (req.method === 'POST' && path === '/admin/pool') {
        if (!checkAdmin(req, adminToken)) return sendJson(res, 401, { error: 'unauthorized' });
        const body = await readBody(req, maxBodyBytes);
        let p;
        try {
          p = JSON.parse(body);
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON body' });
        }
        if (!p.baseUrl || !p.apiKey) return sendJson(res, 400, { error: 'baseUrl and apiKey are required' });
        const a = pool.store.add(p);
        return sendJson(res, 201, { ok: true, account: pool.summary().find((x) => x.id === a.id) });
      }

      const poolMgmt = path.match(/^\/admin\/pool\/([^/]+)\/(enable|disable|remove|purge|restore)$/);
      if (poolMgmt && req.method === 'POST') {
        if (!checkAdmin(req, adminToken)) return sendJson(res, 401, { error: 'unauthorized' });
        const [, id, action] = poolMgmt;
        const a = pool.store.get(id);
        if (!a) return sendJson(res, 404, { error: 'account not found' });
        if (action === 'remove') {
          pool.store.remove(id); // 软删除（可恢复）
          return sendJson(res, 200, { ok: true, removed: id, soft: true });
        }
        if (action === 'purge') {
          pool.store.purge(id); // 彻底删除（不可恢复）
          return sendJson(res, 200, { ok: true, purged: id });
        }
        if (action === 'restore') {
          pool.store.restore(id); // 恢复软删除
          return sendJson(res, 200, { ok: true, account: pool.summary().find((x) => x.id === id) });
        }
        if (action === 'enable') {
          a.status = 'active';
          a.enabled = true;
          a.cooldownUntil = null;
        } else if (action === 'disable') {
          a.status = 'disabled';
          a.enabled = false;
        }
        pool.store.save();
        return sendJson(res, 200, { ok: true, account: pool.summary().find((x) => x.id === id) });
      }

      // 通用编辑：改 models / groups / weight / modelWeights / note（受 ADMIN_TOKEN 保护）
      const poolEdit = path.match(/^\/admin\/pool\/([^/]+)\/edit$/);
      if (poolEdit && req.method === 'POST') {
        if (!checkAdmin(req, adminToken)) return sendJson(res, 401, { error: 'unauthorized' });
        const [, id] = poolEdit;
        const a = pool.store.get(id);
        if (!a) return sendJson(res, 404, { error: 'account not found' });
        const body = await readBody(req, maxBodyBytes);
        let p;
        try {
          p = JSON.parse(body);
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON body', type: 'bad_request' });
        }
        if (p.models !== undefined) {
          a.models = Array.isArray(p.models)
            ? p.models.map((s) => String(s).trim()).filter(Boolean)
            : String(p.models).split(',').map((s) => s.trim()).filter(Boolean);
        }
        if (p.groups !== undefined) {
          a.groups = Array.isArray(p.groups)
            ? p.groups.map((s) => String(s).trim()).filter(Boolean)
            : String(p.groups).split(',').map((s) => s.trim()).filter(Boolean);
        }
        if (p.weight !== undefined) a.weight = Number(p.weight) || 1;
        if (p.modelWeights !== undefined) {
          if (p.modelWeights && typeof p.modelWeights === 'object') {
            const mw = {};
            for (const [k, v] of Object.entries(p.modelWeights)) {
              const n = Number(v);
              if (Number.isFinite(n) && n > 0) mw[k] = n;
            }
            a.modelWeights = Object.keys(mw).length ? mw : null;
          } else {
            a.modelWeights = null;
          }
        }
        if (p.note !== undefined) a.note = p.note ? String(p.note).slice(0, 500) : null;
        a.updatedAt = Date.now();
        pool.store.save();
        return sendJson(res, 200, { ok: true, account: pool.summary().find((x) => x.id === id) });
      }

      // 主动探活：逐个账号发轻量请求，报告可达性；可选 autoDisable 将不可达账号自动下线
      if (req.method === 'POST' && path === '/admin/health-check') {
        if (!checkAdmin(req, adminToken)) return sendJson(res, 401, { error: 'unauthorized' });
        let autoDisable = false;
        try {
          const body = await readBody(req, maxBodyBytes);
          const p = body ? JSON.parse(body) : {};
          autoDisable = !!p.autoDisable;
        } catch { /* 无 body 或非法 JSON 时按 autoDisable=false 处理 */ }
        const results = await probeAccounts(pool.accounts);
        const reachable = results.filter((r) => r.reachable).length;
        let disabled = [];
        if (autoDisable) {
          const downIds = new Set(results.filter((r) => !r.reachable).map((r) => r.id));
          for (const a of pool.accounts) {
            if (downIds.has(a.id) && a.status !== 'disabled' && a.enabled !== false) {
              a.status = 'disabled';
              a.enabled = false;
              disabled.push(a.id);
            }
          }
          if (disabled.length) pool.store.save();
        }
        return sendJson(res, 200, { ok: true, reachable, total: results.length, autoDisabled: disabled, results });
      }

      if (req.method === 'POST' && path === '/v1/chat/completions') {
        if (!checkProxy(req, proxyToken)) return sendJson(res, 401, { error: 'unauthorized', type: 'proxy_auth' });
        if (!bucket.take()) {
          metrics_.recordRateLimited();
          return sendJson(res, 429, { error: 'rate limit exceeded', type: 'rate_limited' });
        }
        let body;
        try {
          body = await readBody(req, maxBodyBytes);
        } catch {
          return sendJson(res, 413, { error: 'request body too large', type: 'payload_too_large' });
        }
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON body', type: 'bad_request' });
        }
        if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
          return sendJson(res, 400, { error: 'messages is required (non-empty array)', type: 'bad_request' });
        }
        const group = payload.group || req.headers['x-ldfa-group'] || undefined;
        if (log_) log_.info('proxy request', { model: payload.model, group, requestId });
        const result = await handleChatCompletion(pool, payload, {
          metrics: metrics_,
          log: log_,
          timeout: upstreamTimeoutMs,
          connectTimeout: connectTimeoutMs,
          group,
          concurrency: concurrency_,
          maxConcurrency,
          circuitLimit,
          passthroughHeaders: buildPassthroughHeaders(req),
        });
        if (log_) log_.info('proxy done', { model: payload.model, account: result.account && result.account.name, ok: result.ok, status: result.status || 502, requestId });
        return finishProxyResult(res, req, result, { log: log_, requestId, streamIdleTimeoutMs, metrics: metrics_, model: payload.model, prices });
      }

      if (req.method === 'POST' && path === '/v1/embeddings') {
        if (!checkProxy(req, proxyToken)) return sendJson(res, 401, { error: 'unauthorized', type: 'proxy_auth' });
        if (!bucket.take()) {
          metrics_.recordRateLimited();
          return sendJson(res, 429, { error: 'rate limit exceeded', type: 'rate_limited' });
        }
        let body;
        try {
          body = await readBody(req, maxBodyBytes);
        } catch {
          return sendJson(res, 413, { error: 'request body too large', type: 'payload_too_large' });
        }
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON body', type: 'bad_request' });
        }
        if (!payload || payload.input === undefined || payload.input === null) {
          return sendJson(res, 400, { error: 'input is required', type: 'bad_request' });
        }
        const result = await handleWithFailover(pool, payload, {
          metrics: metrics_,
          log: log_,
          timeout: upstreamTimeoutMs,
          connectTimeout: connectTimeoutMs,
          apiPath: '/v1/embeddings',
          group: payload.group || req.headers['x-ldfa-group'] || undefined,
          concurrency: concurrency_,
          maxConcurrency,
          circuitLimit,
          passthroughHeaders: buildPassthroughHeaders(req),
        });
        return finishProxyResult(res, req, result, { log: log_, requestId, streamIdleTimeoutMs, metrics: metrics_, model: payload.model, prices });
      }

      // 通用 OpenAI 兼容透传：/v1/* 其余路径（images/audio/moderations/responses 等）
      // 复用故障转移，按原请求路径转发（apiPath = 实际路径），与 chat/embeddings 逻辑一致。
      const genericV1 = path.match(/^\/v1\/(?!chat\/completions$|embeddings$).+/);
      if (req.method === 'POST' && genericV1) {
        if (!checkProxy(req, proxyToken)) return sendJson(res, 401, { error: 'unauthorized', type: 'proxy_auth' });
        if (!bucket.take()) {
          metrics_.recordRateLimited();
          return sendJson(res, 429, { error: 'rate limit exceeded', type: 'rate_limited' });
        }
        let body;
        try {
          body = await readBody(req, maxBodyBytes);
        } catch {
          return sendJson(res, 413, { error: 'request body too large', type: 'payload_too_large' });
        }
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON body', type: 'bad_request' });
        }
        if (!payload || !payload.model) {
          return sendJson(res, 400, { error: 'model is required', type: 'bad_request' });
        }
        const result = await handleWithFailover(pool, payload, {
          metrics: metrics_,
          log: log_,
          timeout: upstreamTimeoutMs,
          connectTimeout: connectTimeoutMs,
          apiPath: path,
          group: payload.group || req.headers['x-ldfa-group'] || undefined,
          concurrency: concurrency_,
          maxConcurrency,
          circuitLimit,
          passthroughHeaders: buildPassthroughHeaders(req),
        });
        return finishProxyResult(res, req, result, { log: log_, requestId, streamIdleTimeoutMs, metrics: metrics_, model: payload.model, prices });
      }

      return sendJson(res, 404, { error: 'not found', path });
    } catch (e) {
      status = 500;
      if (!res.headersSent) sendJson(res, 500, { error: e.message, type: 'internal' });
    } finally {
      status = res.statusCode || status;
      log_.info('request', { method: req.method, path, status, ms: Date.now() - start, requestId });
    }
  });

  server.metrics = metrics_;
  return server;
}

/** 把故障转移结果转成响应：成功则透明转发上游流（含流式健壮性），失败则返回 JSON 错误 */
function finishProxyResult(res, req, result, { log, requestId, streamIdleTimeoutMs, model, prices, metrics: m_ } = {}) {
  if (!result.ok) {
    const body = { error: result.error, tried: result.tried };
    if (result.type) body.type = result.type;
    return sendJson(res, result.status || 502, body);
  }
  pipeUpstream(res, result.upstream, {
    req, log, requestId, idleTimeoutMs: streamIdleTimeoutMs,
    account: result.account, model, prices, metrics: m_,
  });
}

/** 从响应 JSON 中提取 usage（兼容标准 OpenAI 字段） */
function extractUsage(obj) {
  const u = obj && obj.usage;
  if (!u) return null;
  const p = Number(u.prompt_tokens ?? u.promptTokens) || 0;
  const c = Number(u.completion_tokens ?? u.completionTokens) || 0;
  const t = Number(u.total_tokens ?? u.totalTokens) || (p + c);
  return { prompt: p, completion: c, total: t };
}

/** 透明转发上游响应流，并附加：X-Request-Id 已设；流式空闲超时；客户端断开即销毁上游；流式中间错误修复；Token 用量采集 */
function pipeUpstream(res, up, { req, log, requestId, idleTimeoutMs = 0, account, model, prices = null, metrics: m_ = null } = {}) {
  res.statusCode = up.statusCode;
  const ct = up.headers['content-type'] || 'application/json';
  res.setHeader('Content-Type', ct);
  if (ct.includes('text/event-stream')) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
  }

  // 采集 Token 用量：成功后调用一次，更新账号累计 + 指标 + 成本估算
  const recordUsage = (usage) => {
    if (!usage) return;
    if (account) {
      account.promptTokens = (account.promptTokens || 0) + usage.prompt;
      account.completionTokens = (account.completionTokens || 0) + usage.completion;
      account.totalTokens = (account.totalTokens || 0) + usage.total;
    }
    if (m_) m_.recordTokens(model, usage.prompt, usage.completion, prices);
  };

  let idleTimer = null;
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const armIdle = () => {
    clearIdle();
    if (idleTimeoutMs > 0) {
      idleTimer = setTimeout(() => {
        if (log) log.warn('stream idle timeout, aborting', { requestId });
        try { up.stream.destroy(); } catch {}
        if (!res.headersSent) {
          res.statusCode = 504;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'upstream stream idle timeout', type: 'upstream_error' }));
        } else {
          try { res.end(); } catch {}
        }
      }, idleTimeoutMs);
    }
  };

  if (ct.includes('text/event-stream')) {
    // 流式：逐块扫描 SSE 的 data: 行，遇到含 usage 的 JSON 即采集（最佳努力，不缓冲整响应）
    let buf = '';
    up.stream.on('data', (chunk) => {
      armIdle();
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data && data !== '[DONE]') {
            try {
              const parsed = JSON.parse(data);
              const u = extractUsage(parsed);
              if (u) recordUsage(u);
            } catch {}
          }
        }
      }
    });
    up.stream.on('end', () => { clearIdle(); try { res.end(); } catch {} });
    up.stream.on('error', () => {
      clearIdle();
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'upstream stream error', type: 'upstream_error' }));
      } else {
        try {
          res.write('data: ' + JSON.stringify({ error: { message: 'upstream stream error', type: 'upstream_error' } }) + '\n\n');
        } catch {}
        try { res.end(); } catch {}
      }
    });
    // 流式：直接管道转发（usage 采集已在 data 事件中完成）
    armIdle();
    up.stream.pipe(res);
  } else {
    // 非流式：整块缓冲后解析 usage，再原样写回客户端（便于统计 Token）
    const chunks = [];
    up.stream.on('data', (chunk) => { armIdle(); chunks.push(chunk); });
    up.stream.on('end', () => {
      clearIdle();
      const body = Buffer.concat(chunks);
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        recordUsage(extractUsage(parsed));
      } catch {}
      res.end(body);
    });
    up.stream.on('error', () => {
      clearIdle();
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'upstream stream error', type: 'upstream_error' }));
      } else {
        try { res.end(); } catch {}
      }
    });
  }

  // 客户端断开：销毁上游，避免白白转发占用额度/连接
  req.on('close', () => { clearIdle(); try { up.stream.destroy(); } catch {} });
  res.on('close', () => { clearIdle(); try { up.stream.destroy(); } catch {} });
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
}

function serveStatic(res, file, contentType) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'web page not found' }));
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  });
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.pause(); // 停止接收剩余数据，但保留 socket 以便正常写回 413 响应
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function checkAdmin(req, adminToken) {
  if (!adminToken) return true; // 未设置 token 时本地默认开放
  const h = req.headers['authorization'] || '';
  return h === `Bearer ${adminToken}` || h === adminToken;
}

function checkProxy(req, proxyToken) {
  if (!proxyToken) return true; // 未设置 token 时本地默认开放
  const h = req.headers['authorization'] || '';
  return h === `Bearer ${proxyToken}` || h === proxyToken;
}
