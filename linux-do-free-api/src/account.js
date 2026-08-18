import crypto from 'node:crypto';

// 额度按天重置（多数签到制中转站每天送额度）
export const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// 瞬态错误（网络/5xx）短暂冷却，避免反复打挂一个坏账号
export const TRANSIENT_COOLDOWN_MS = 5 * 60 * 1000;
// 瞬态冷却上限（指数退避到此封顶），避免一致坏账号被冷却过久又无法人工介入
export const TRANSIENT_COOLDOWN_MAX_MS = 60 * 60 * 1000;

/**
 * 将一个原始账号输入规范化为内部账号对象。
 * 既用于新建，也用于从持久化文件恢复（会保留运行时字段）。
 */
export function createAccount(input = {}) {
  const now = Date.now();
  const models = Array.isArray(input.models)
    ? input.models
    : (input.models ? String(input.models).split(',').map((s) => s.trim()).filter(Boolean) : []);
  const groups = Array.isArray(input.groups)
    ? input.groups
    : (input.groups ? String(input.groups).split(',').map((s) => s.trim()).filter(Boolean) : []);
  // 去重分组（保留首次出现顺序），避免编辑手误导致同一账号重复出现在某分组
  const seenGroups = new Set();
  const dedupedGroups = [];
  for (const g of groups) {
    if (!seenGroups.has(g)) { seenGroups.add(g); dedupedGroups.push(g); }
  }

  return {
    id: input.id || crypto.randomUUID(),
    name: input.name || 'unnamed',
    baseUrl: (input.baseUrl || '').replace(/\/+$/, ''),
    apiKey: input.apiKey || '',
    models,
    groups: dedupedGroups,
    path: input.path || '/v1/chat/completions',
    weight: Number(input.weight) || 1,
    // 模型级权重（可选）：{ [model]: weight }，命中时覆盖账号级 weight，实现「热门模型偏好高配账号」
    modelWeights: input.modelWeights && typeof input.modelWeights === 'object' ? input.modelWeights : null,
    note: typeof input.note === 'string' ? input.note : null,
    cooldownMs: Number(input.cooldownMs) || DEFAULT_COOLDOWN_MS,
    enabled: input.enabled !== false,

    // —— 运行时状态（会持久化）——
    status: input.status || 'active', // active | exhausted | disabled
    cooldownUntil: input.cooldownUntil || null,
    consecutiveErrors: input.consecutiveErrors || 0,
    used: input.used || 0,
    // Token 用量累计（从响应 usage 解析，用于成本估算与配额观察）
    promptTokens: input.promptTokens || 0,
    completionTokens: input.completionTokens || 0,
    totalTokens: input.totalTokens || 0,
    lastUsedAt: input.lastUsedAt || null,
    lastErrorAt: input.lastErrorAt || null,
    lastError: input.lastError || null,
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
}

/** 账号当前是否可被选中（不修改对象） */
export function isHealthy(a, now = Date.now()) {
  if (!a.enabled || a.status === 'disabled') return false;
  if (a.cooldownUntil && now < a.cooldownUntil) return false;
  return true;
}

/** 额度耗尽：停用并进入冷却，冷却结束后由号池自动复活 */
export function markExhausted(a, cooldownMs = DEFAULT_COOLDOWN_MS) {
  a.status = 'exhausted';
  a.cooldownUntil = Date.now() + (a.cooldownMs || cooldownMs);
  a.consecutiveErrors = 0;
  a.updatedAt = Date.now();
}

/** Key 失效 / 鉴权失败：人工修复前不再使用 */
export function markInvalidKey(a) {
  a.status = 'disabled';
  a.updatedAt = Date.now();
}

/** 瞬态错误：计数 + 自适应冷却（随连续错误指数退避，封顶 TRANSIENT_COOLDOWN_MAX_MS） */
export function recordTransientError(a, baseCooldownMs = TRANSIENT_COOLDOWN_MS, maxCooldownMs = TRANSIENT_COOLDOWN_MAX_MS) {
  a.consecutiveErrors = (a.consecutiveErrors || 0) + 1;
  const mult = 2 ** (a.consecutiveErrors - 1); // 第1次×1，第2次×2，第3次×4…
  const cd = Math.min(maxCooldownMs, baseCooldownMs * mult);
  a.cooldownUntil = Date.now() + cd;
  a.updatedAt = Date.now();
}

/**
 * 熔断判定：连续错误达到阈值（limit>0）时返回 true，提示调用方将该账号自动禁用。
 * 默认 limit<=0 表示关闭熔断。
 */
export function shouldCircuitBreak(a, limit = 0) {
  return limit > 0 && (a.consecutiveErrors || 0) >= limit;
}

/** 成功：复活、计数、记录使用时间 */
export function recordSuccess(a) {
  if (a.status === 'exhausted') {
    a.status = 'active';
    a.cooldownUntil = null;
  }
  a.consecutiveErrors = 0;
  a.used = (a.used || 0) + 1;
  a.lastUsedAt = Date.now();
  a.updatedAt = Date.now();
}
