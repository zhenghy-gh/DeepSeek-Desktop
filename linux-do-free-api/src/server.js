import http from 'node:http';
import { handleChatCompletion } from './router.js';

export function createServer(pool, { adminToken } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const path = url.pathname;

      if (req.method === 'GET' && path === '/health') {
        return sendJson(res, 200, {
          ok: true,
          accounts: pool.accounts.length,
          models: pool.allModels(),
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

      if (req.method === 'GET' && path === '/admin/pool') {
        if (!checkAdmin(req, adminToken)) return sendJson(res, 401, { error: 'unauthorized' });
        return sendJson(res, 200, { accounts: pool.summary() });
      }

      if (req.method === 'POST' && path === '/v1/chat/completions') {
        const body = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON body' });
        }

        const result = await handleChatCompletion(pool, payload);
        if (!result.ok) {
          return sendJson(res, result.status || 502, { error: result.error, tried: result.tried });
        }

        // 直传上游响应（透明支持流式 /event-stream 与普通 JSON）
        const up = result.upstream;
        res.statusCode = up.statusCode;
        const ct = up.headers['content-type'] || 'application/json';
        res.setHeader('Content-Type', ct);
        if (ct.includes('text/event-stream')) {
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
        }
        up.stream.pipe(res);
        up.stream.on('error', () => {
          try {
            res.end();
          } catch {}
        });
        return;
      }

      return sendJson(res, 404, { error: 'not found', path });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });

  return server;
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
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
