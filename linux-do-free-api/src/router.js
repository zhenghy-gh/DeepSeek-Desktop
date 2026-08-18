import { forwardRequest } from './upstream.js';
import { classifyError } from './errors.js';
import { markExhausted, markInvalidKey, recordTransientError, recordSuccess, shouldCircuitBreak } from './account.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 指数退避：200ms, 400ms, 800ms ... 上限 5s */
function backoffMs(retry) {
  return Math.min(5000, 200 * 2 ** (retry - 1));
}

/**
 * 通用故障转移核心：为某个模型挑选可用账号并转发，失败按错误类型处置后切换到下一个。
 *
 * @param {object} opts
 * @param {Function} [opts.forward]        可注入的转发函数（便于测试）
 * @param {object}   [opts.metrics]        指标收集器（可注入）
 * @param {object}   [opts.log]            日志器（可注入）
 * @param {number}   [opts.maxAttempts]    最多尝试的账号数（默认 8）
 * @param {number}   [opts.timeout]        上游整体超时（ms）
 * @param {number}   [opts.connectTimeout] 上游连接超时（ms）
 * @param {number}   [opts.maxPerAccountRetries] 同一账号对瞬态错误的退避重试次数（默认 1）
 * @param {Function} [opts.sleep]          退避等待（可注入，便于测试）
 * @param {string}   [opts.apiPath]        覆盖转发的上游路径（如 /v1/embeddings）
 * @param {string}   [opts.group]          限定账号分组
 * @param {Map}      [opts.concurrency]    共享的「账号在途计数」表（key=账号id, value=并发数），用于并发上限
 * @param {number}   [opts.maxConcurrency] 每账号最大并发（0 = 不限）。达到上限的账号会被暂时跳过（仍有其他候选时）
 * @param {number}   [opts.circuitLimit]   连续错误达到该值自动熔断禁用账号（0 = 关闭）
 */
export async function handleWithFailover(pool, payload, opts = {}) {
  const {
    forward = forwardRequest,
    metrics = null,
    log = null,
    maxAttempts = 8,
    timeout = 60000,
    connectTimeout = 8000,
    maxPerAccountRetries = 1,
    sleep = defaultSleep,
    apiPath = null,
    group = null,
    concurrency = null,
    maxConcurrency = 0,
    circuitLimit = 0,
    passthroughHeaders = null,
  } = opts;

  const model = payload.model;
  if (!model) return { ok: false, status: 400, error: 'missing model' };

  if (metrics) metrics.requestStart(model);
  const startTs = Date.now();
  const tried = [];
  const triedSet = new Set();
  const excluded = new Set(); // 因并发达上限被暂时跳过的账号

  while (tried.length < maxAttempts) {
    const acc = pool.select(model, { group, exclude: excluded });
    if (!acc || triedSet.has(acc.id)) break; // 无候选，或所有候选已试过

    // 并发上限：该账号已满载，加入排除集并跳过（还有别的候选时），避免打爆单账号
    if (maxConcurrency > 0 && concurrency && (concurrency.get(acc.id) || 0) >= maxConcurrency) {
      excluded.add(acc.id);
      if (metrics) metrics.recordConcurrencyLimited();
      continue;
    }

    tried.push(acc.id);
    triedSet.add(acc.id);
    if (maxConcurrency > 0 && concurrency) concurrency.set(acc.id, (concurrency.get(acc.id) || 0) + 1);

    try {
      // —— 同账号对瞬态错误的有限次退避重试 ——
      let r;
      let retries = 0;
      while (true) {
        r = await forward(acc, payload, { timeout, connectTimeout, pathOverride: apiPath, passthroughHeaders });
        if (r.ok) break;
        const cls = classifyError(r.statusCode, r.bodyText);
        if (cls.retryable && retries < maxPerAccountRetries) {
          retries++;
          if (metrics) metrics.recordRetry(acc.id);
          if (log) log.warn('transient retransmit', { account: acc.name, retry: retries, reason: r.reason });
          await sleep(backoffMs(retries));
          continue;
        }
        break;
      }

      if (r.ok) {
        recordSuccess(acc);
        if (metrics) {
          metrics.recordAttempt(acc.id, 'success');
          metrics.recordModelOutcome(model, true);
          metrics.recordLatency(Date.now() - startTs);
        }
        if (log) log.info('request ok', { model, account: acc.name, attempts: tried.length });
        pool.store.save();
        return { ok: true, account: acc, upstream: r };
      }

      const cls = classifyError(r.statusCode, r.bodyText);
      if (cls.type === 'quota') markExhausted(acc);
      else if (cls.type === 'invalid_key' || cls.type === 'auth') markInvalidKey(acc);
      else {
        recordTransientError(acc);
        // 连续错误触顶 → 熔断自动禁用，避免持续浪费请求
        if (shouldCircuitBreak(acc, circuitLimit)) {
          markInvalidKey(acc);
          if (metrics) metrics.recordCircuitOpened(acc.id);
          if (log) log.warn('circuit opened', { account: acc.name, consecutiveErrors: acc.consecutiveErrors });
        }
      }

      acc.lastErrorAt = Date.now();
      acc.lastError = `${r.statusCode} ${String(r.bodyText).slice(0, 200)}`;
      if (metrics) metrics.recordAttempt(acc.id, 'fail', acc.lastError);
      if (log) log.warn('account failed, switching', { account: acc.name, type: cls.type, status: r.statusCode, reason: r.reason });
      pool.store.save();

      // 请求本身有问题（参数错误 / 超长），换账号也无济于事
      if (cls.type === 'client_error' || cls.type === 'context_length') {
        if (metrics) {
          metrics.recordModelOutcome(model, false);
          metrics.recordLatency(Date.now() - startTs);
        }
        return { ok: false, status: r.statusCode || 400, error: r.bodyText, tried, type: cls.type };
      }

      // 非请求错误：切下一个账号继续尝试
      if (metrics) metrics.recordSwitch(acc.id);
    } finally {
      if (maxConcurrency > 0 && concurrency) {
        const n = (concurrency.get(acc.id) || 1) - 1;
        if (n <= 0) concurrency.delete(acc.id);
        else concurrency.set(acc.id, n);
      }
    }
  }

  if (metrics) {
    metrics.recordModelOutcome(model, false);
    metrics.recordLatency(Date.now() - startTs);
  }
  let error = 'all accounts failed or unavailable';
  if (tried.length === 0) {
    if (excluded.size > 0) error = 'all available accounts are at concurrency limit';
    else if (group) error = `no available account in group "${group}" for model "${model}"`;
    else error = `no available account for model "${model}"`;
  }
  return { ok: false, status: 502, error, tried };
}

/** chat completion 入口（语义化包装，保持向后兼容） */
export async function handleChatCompletion(pool, payload, opts = {}) {
  return handleWithFailover(pool, payload, opts);
}
