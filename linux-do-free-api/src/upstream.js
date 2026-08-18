import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

/**
 * 把一次请求转发到某个上游中转站。
 *
 * 成功时返回 { ok:true, statusCode, headers, stream }（stream 为可直传的响应流）；
 * 失败时返回 { ok:false, statusCode, bodyText, reason }，由 router 负责分类与切换。
 *
 * 超时控制拆分为两类（都可由环境变量调节）：
 *  - connectTimeout：连接建立前的超时，避免 DNS / TCP 握手卡死。
 *  - timeout：整体超时（含连接 + 读取），避免慢上游长时间占用。
 *
 * pathOverride 用于 chat 之外的端点（如 /v1/embeddings），覆盖账号默认的 path。
 */
export function forwardRequest(account, payload, opts = {}) {
  const { timeout = 60000, connectTimeout = 8000, pathOverride = null, passthroughHeaders = null } = opts;
  return new Promise((resolve) => {
    let target;
    try {
      const p = pathOverride || account.path || '/v1/chat/completions';
      target = new URL(p, account.baseUrl);
    } catch (e) {
      return resolve({ ok: false, statusCode: 0, bodyText: 'invalid baseUrl: ' + e.message, reason: 'bad_url' });
    }

    const lib = target.protocol === 'https:' ? https : http;
    const data = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${account.apiKey}`,
      Accept: 'application/json, text/event-stream',
      'User-Agent': 'linux-do-free-api/0.2',
    };
    // 透传白名单头部（如 OpenAI-Organization / x- 自定义头），但不覆盖鉴权与 Content-Type
    if (passthroughHeaders && typeof passthroughHeaders === 'object') {
      for (const [k, v] of Object.entries(passthroughHeaders)) {
        const lk = k.toLowerCase();
        if (lk === 'authorization' || lk === 'content-type' || lk === 'host' || lk === 'content-length') continue;
        headers[k] = v;
      }
    }

    let settled = false;
    let connected = false;
    const cleanup = () => {
      clearTimeout(connTimer);
      clearTimeout(overallTimer);
    };
    const finish = (obj) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(obj);
    };

    // 连接尚未建立就超时 → 视为连接超时（区别于读取超时）
    const connTimer = setTimeout(() => {
      if (!connected && !settled) finish({ ok: false, statusCode: 0, bodyText: 'connect timeout', reason: 'connect_timeout' });
    }, connectTimeout);

    // 整体超时（连接 + 读取都算）
    const overallTimer = setTimeout(() => {
      if (!settled) finish({ ok: false, statusCode: 0, bodyText: 'upstream timeout', reason: 'timeout' });
    }, timeout);

    const req = lib.request(target, { method: 'POST', headers }, (res) => {
      connected = true;
      clearTimeout(connTimer);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        finish({ ok: true, statusCode: res.statusCode, headers: res.headers, stream: res });
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        finish({ ok: false, statusCode: res.statusCode, bodyText: Buffer.concat(chunks).toString('utf8'), reason: 'bad_status' });
      });
    });

    req.on('error', (e) => {
      finish({ ok: false, statusCode: 0, bodyText: e.message, reason: e.code || 'network' });
    });

    req.end(data);
  });
}
