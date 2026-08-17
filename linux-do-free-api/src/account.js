import crypto from 'node:crypto';

// 额度按天重置（多数签到制中转站每天送额度）
export const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// 瞬态错误（网络/5xx）短暂冷却，避免反复打挂一个坏账号
export const TRANSIENT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * 将一个原始账号输入规范化为内部账号对象。
 * 既用于新建，也用于从持久化文件恢复（会保留运行时字段）。
 */
export function createAccount(input = {}) {
  const now = Date.now();
  const models = Array.isArray(input.models)
    ? input.models
    : (input.models ? String(input.models).split(',').map((s) => s.trim()).filter(Boolean) : []);

  return {
    id: input.id || crypto.randomUUID(),
    name: input.name || 'unnamed',
    baseUrl: (input.baseUrl || '').replace(/\/+$/, ''),
    apiKey: input.apiKey || '',
    models,
    path: input.path || '/v1/chat/completions',
    weight: Number(input.weight) || 1,
    cooldownMs: Number(input.cooldownMs) || DEFAULT_COOLDOWN_MS,
    enabled: input.enabled !== false,

    // —— 运行时状态（会持久化）——
    status: input.status || 'active', // active | exhausted | disabled
    cooldownUntil: input.cooldownUntil || null,
    consecutiveErrors: input.consecutiveErrors || 0,
    used: input.used || 0,
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

/** 瞬态错误：计数 + 短时冷却 */
export function recordTransientError(a, cooldownMs = TRANSIENT_COOLDOWN_MS) {
  a.consecutiveErrors = (a.consecutiveErrors || 0) + 1;
  a.cooldownUntil = Date.now() + cooldownMs;
  a.updatedAt = Date.now();
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
