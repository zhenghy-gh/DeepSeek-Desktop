// 轻量内存指标，零依赖。供 /metrics 端点与可观测性使用。
// 设计：单进程内累计计数 + 按账号/模型聚合 + 最近错误环形缓冲 + 延迟直方图（分位数）。

// 延迟直方图桶的「上界」，最后一个 Infinity 表示 >= 51200ms 的溢出桶
const LATENCY_BUCKETS = [50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200, Infinity];

export class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.reset();
  }

  reset() {
    this.totalRequests = 0;
    this.totalSuccess = 0;
    this.totalFailure = 0;
    this.totalSwitches = 0; // 因账号失败而切换到下一个的次数
    this.totalRetries = 0; // 同一账号对瞬态错误的退避重试次数
    this.totalConcurrencyLimited = 0; // 因账号并发达上限而跳过的次数
    this.totalCircuitOpened = 0; // 因连续错误触发熔断（自动禁用）的次数
    this.totalRateLimited = 0; // 因全局速率限制被拒的次数
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.totalTokens = 0;
    this.estimatedCost = 0; // 按价格表估算的累计成本（USD），无价格表则为 0
    this.totalLatencyMs = 0;
    this.latencyCount = 0;
    this.latencyMax = 0;
    this.latencyHist = {}; // 桶索引 -> 计数
    this.byAccount = {}; // id -> { success, fail, switched, used, lastError, retries, circuitOpened }
    this.byModel = {}; // model -> { requests, success, fail }
    this.lastErrors = []; // 最近失败摘要（环形，最多 20 条）
  }

  _acct(id) {
    return (this.byAccount[id] ||= { success: 0, fail: 0, switched: 0, used: 0, retries: 0, circuitOpened: 0, lastError: null });
  }
  _model(m) {
    return (this.byModel[m] ||= { requests: 0, success: 0, fail: 0 });
  }

  requestStart(model) {
    this.totalRequests++;
    this._model(model).requests++;
  }

  recordAttempt(accountId, outcome, errorSummary = null) {
    const a = this._acct(accountId);
    a.used++;
    if (outcome === 'success') {
      a.success++;
      this.totalSuccess++;
    } else if (outcome === 'fail') {
      a.fail++;
      this.totalFailure++;
      if (errorSummary) a.lastError = errorSummary;
      this.lastErrors.push({ at: Date.now(), account: accountId, error: errorSummary });
      if (this.lastErrors.length > 20) this.lastErrors.shift();
    }
  }

  recordSwitch(accountId) {
    this.totalSwitches++;
    this._acct(accountId).switched++;
  }

  recordRetry(accountId) {
    this.totalRetries++;
    this._acct(accountId).retries++;
  }

  recordConcurrencyLimited() {
    this.totalConcurrencyLimited++;
  }

  recordCircuitOpened(accountId) {
    this.totalCircuitOpened++;
    this._acct(accountId).circuitOpened++;
  }

  recordRateLimited() {
    this.totalRateLimited++;
  }

  /**
   * 记录一次成功响应的 Token 用量，并（若提供 priceMap）累加估算成本。
   * @param {string} model
   * @param {number} prompt
   * @param {number} completion
   * @param {object} [priceMap] { [model]: { prompt: 每1k价格USD, completion: 每1k价格USD } }
   */
  recordTokens(model, prompt = 0, completion = 0, priceMap = null) {
    prompt = Number(prompt) || 0;
    completion = Number(completion) || 0;
    this.totalPromptTokens += prompt;
    this.totalCompletionTokens += completion;
    this.totalTokens += prompt + completion;
    if (priceMap && priceMap[model]) {
      const p = priceMap[model];
      const pp = Number(p.prompt) || 0;
      const cp = Number(p.completion) || 0;
      this.estimatedCost += (prompt / 1000) * pp + (completion / 1000) * cp;
    }
  }

  recordModelOutcome(model, success) {
    const m = this._model(model);
    if (success) m.success++;
    else m.fail++;
  }

  recordLatency(ms) {
    if (!(ms >= 0)) return;
    this.totalLatencyMs += ms;
    this.latencyCount++;
    if (ms > this.latencyMax) this.latencyMax = ms;
    let i = 0;
    while (i < LATENCY_BUCKETS.length && ms > LATENCY_BUCKETS[i]) i++;
    this.latencyHist[i] = (this.latencyHist[i] || 0) + 1;
  }

  /** 近似分位数（线性插值），p 取 0..1 */
  _percentile(p) {
    if (this.latencyCount === 0) return 0;
    const n = this.latencyCount;
    const rank = Math.min(n, Math.max(1, Math.ceil(p * n)));
    let cum = 0;
    for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
      const c = this.latencyHist[i] || 0;
      cum += c;
      if (cum >= rank) {
        const lower = i === 0 ? 0 : LATENCY_BUCKETS[i - 1];
        const upper = LATENCY_BUCKETS[i] === Infinity ? this.latencyMax : LATENCY_BUCKETS[i];
        const prevCum = cum - c;
        const frac = c > 1 ? (rank - prevCum - 1) / (c - 1) : 0;
        return Math.round(lower + frac * (upper - lower));
      }
    }
    return this.latencyMax;
  }

  snapshot() {
    const now = Date.now();
    return {
      uptimeSec: Math.round((now - this.startedAt) / 1000),
      totalRequests: this.totalRequests,
      totalSuccess: this.totalSuccess,
      totalFailure: this.totalFailure,
      totalSwitches: this.totalSwitches,
      totalRetries: this.totalRetries,
      totalConcurrencyLimited: this.totalConcurrencyLimited,
      totalCircuitOpened: this.totalCircuitOpened,
      totalRateLimited: this.totalRateLimited,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      totalTokens: this.totalTokens,
      estimatedCostUsd: Number(this.estimatedCost.toFixed(6)),
      avgLatencyMs: this.latencyCount ? Math.round(this.totalLatencyMs / this.latencyCount) : 0,
      p50LatencyMs: this._percentile(0.5),
      p95LatencyMs: this._percentile(0.95),
      p99LatencyMs: this._percentile(0.99),
      maxLatencyMs: this.latencyMax,
      latencySamples: this.latencyCount,
      byAccount: this.byAccount,
      byModel: this.byModel,
      recentErrors: this.lastErrors.slice(-10),
    };
  }

  prometheus() {
    const lines = [];
    const g = (name, help, type) => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    g('ldfa_requests_total', 'Total chat completion requests', 'counter');
    lines.push(`ldfa_requests_total ${this.totalRequests}`);
    g('ldfa_success_total', 'Successful requests', 'counter');
    lines.push(`ldfa_success_total ${this.totalSuccess}`);
    g('ldfa_failure_total', 'Failed requests', 'counter');
    lines.push(`ldfa_failure_total ${this.totalFailure}`);
    g('ldfa_switches_total', 'Account switches due to failure', 'counter');
    lines.push(`ldfa_switches_total ${this.totalSwitches}`);
    g('ldfa_retries_total', 'Transient retries on same account', 'counter');
    lines.push(`ldfa_retries_total ${this.totalRetries}`);
    g('ldfa_concurrency_limited_total', 'Skips due to per-account concurrency limit', 'counter');
    lines.push(`ldfa_concurrency_limited_total ${this.totalConcurrencyLimited}`);
    g('ldfa_circuit_opened_total', 'Accounts auto-disabled by circuit breaker', 'counter');
    lines.push(`ldfa_circuit_opened_total ${this.totalCircuitOpened}`);
    g('ldfa_rate_limited_total', 'Requests rejected by global rate limit', 'counter');
    lines.push(`ldfa_rate_limited_total ${this.totalRateLimited}`);
    g('ldfa_tokens_total', 'Tokens consumed (prompt/completion/total)', 'counter');
    lines.push(`ldfa_prompt_tokens_total ${this.totalPromptTokens}`);
    lines.push(`ldfa_completion_tokens_total ${this.totalCompletionTokens}`);
    lines.push(`ldfa_total_tokens_total ${this.totalTokens}`);
    g('ldfa_estimated_cost_usd', 'Estimated cost in USD (requires price map)', 'counter');
    lines.push(`ldfa_estimated_cost_usd ${this.estimatedCost.toFixed(6)}`);

    // 延迟直方图
    g('ldfa_latency_seconds', 'Request latency histogram', 'histogram');
    const counts = LATENCY_BUCKETS.map((b, i) => this.latencyHist[i] || 0);
    let running = 0;
    for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
      const upper = LATENCY_BUCKETS[i] === Infinity ? '+Inf' : (LATENCY_BUCKETS[i] / 1000).toString();
      lines.push(`ldfa_latency_seconds_bucket{le="${upper}"} ${running + counts[i]}`);
      running += counts[i];
    }
    lines.push(`ldfa_latency_seconds_sum ${(this.totalLatencyMs / 1000).toFixed(3)}`);
    lines.push(`ldfa_latency_seconds_count ${this.latencyCount}`);

    // 分位数摘要
    g('ldfa_latency_quantiles_seconds', 'Request latency quantiles', 'summary');
    lines.push(`ldfa_latency_quantiles_seconds{quantile="0.5"} ${(this._percentile(0.5) / 1000).toFixed(3)}`);
    lines.push(`ldfa_latency_quantiles_seconds{quantile="0.95"} ${(this._percentile(0.95) / 1000).toFixed(3)}`);
    lines.push(`ldfa_latency_quantiles_seconds{quantile="0.99"} ${(this._percentile(0.99) / 1000).toFixed(3)}`);

    for (const [id, a] of Object.entries(this.byAccount)) {
      lines.push(`ldfa_account_used_total{id="${id}"} ${a.used}`);
      lines.push(`ldfa_account_success_total{id="${id}"} ${a.success}`);
      lines.push(`ldfa_account_fail_total{id="${id}"} ${a.fail}`);
      lines.push(`ldfa_account_switched_total{id="${id}"} ${a.switched}`);
      lines.push(`ldfa_account_circuit_opened_total{id="${id}"} ${a.circuitOpened}`);
    }
    for (const [m, v] of Object.entries(this.byModel)) {
      lines.push(`ldfa_model_requests_total{model="${m}"} ${v.requests}`);
      lines.push(`ldfa_model_success_total{model="${m}"} ${v.success}`);
    }
    return lines.join('\n') + '\n';
  }
}
