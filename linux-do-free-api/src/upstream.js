import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

/**
 * 把一次 chat completion 请求转发到某个上游中转站。
 * 成功时返回 { ok:true, stream }（stream 为可直传的响应流）；
 * 失败时返回 { ok:false, statusCode, bodyText }，由 router 负责分类与切换。
 */
export function forwardRequest(account, payload, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(account.path || '/v1/chat/completions', account.baseUrl);
    } catch (e) {
      return resolve({ ok: false, statusCode: 0, bodyText: 'invalid baseUrl: ' + e.message });
    }

    const lib = target.protocol === 'https:' ? https : http;
    const data = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${account.apiKey}`,
      Accept: 'application/json, text/event-stream',
      'User-Agent': 'linux-do-free-api/0.1',
    };

    const req = lib.request(target, { method: 'POST', headers, timeout }, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve({ ok: true, statusCode: res.statusCode, headers: res.headers, stream: res });
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ ok: false, statusCode: res.statusCode, bodyText: Buffer.concat(chunks).toString('utf8') });
      });
    });

    req.on('error', (e) => resolve({ ok: false, statusCode: 0, bodyText: e.message }));
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.write(data);
    req.end();
  });
}
