import { forwardRequest } from './upstream.js';
import { classifyError } from './errors.js';
import { markExhausted, markInvalidKey, recordTransientError, recordSuccess } from './account.js';

/**
 * 处理一次 chat completion 请求，带自动选号 + 故障转移。
 * 若某个账号额度耗尽 / Key 失效 / 上游报错，会标记该账号并尝试号池里的下一个，
 * 直到命中可用账号或尝试次数耗尽。
 */
export async function handleChatCompletion(pool, payload, { maxAttempts = 8 } = {}) {
  const model = payload.model;
  if (!model) return { ok: false, status: 400, error: 'missing model' };

  const tried = [];
  let attempts = 0;

  while (attempts < maxAttempts) {
    const acc = pool.select(model);
    if (!acc) break;
    attempts++;
    tried.push(acc.id);

    const r = await forwardRequest(acc, payload);
    if (r.ok) {
      recordSuccess(acc);
      pool.store.save();
      return { ok: true, account: acc, upstream: r };
    }

    const cls = classifyError(r.statusCode, r.bodyText);
    if (cls.type === 'quota') markExhausted(acc);
    else if (cls.type === 'invalid_key' || cls.type === 'auth') markInvalidKey(acc);
    else recordTransientError(acc);

    acc.lastErrorAt = Date.now();
    acc.lastError = `${r.statusCode} ${String(r.bodyText).slice(0, 200)}`;
    pool.store.save();

    // 请求本身有问题（如参数错误），换账号也无济于事
    if (cls.type === 'client_error') {
      return { ok: false, status: r.statusCode || 400, error: r.bodyText, tried };
    }
  }

  return { ok: false, status: 502, error: 'all accounts failed or unavailable', tried };
}
