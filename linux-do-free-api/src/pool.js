import { isHealthy } from './account.js';

/**
 * 号池：负责「为某个模型挑选一个可用账号」。
 * 选择策略：在健康候选中，优先选「连续错误少 + 最近没用过」的账号，
 * 并用权重做随机扰动实现负载均衡。
 */
export class AccountPool {
  constructor(store) {
    this.store = store;
  }

  get accounts() {
    return this.store.accounts;
  }

  /** 返回支持该模型且当前可用的账号（会就地复活冷却结束的 exhausted 账号） */
  candidatesForModel(model) {
    const now = Date.now();
    return this.accounts.filter((a) => {
      if (!a.enabled || a.status === 'disabled') return false;
      if (a.cooldownUntil && now < a.cooldownUntil) return false;
      if (a.status === 'exhausted') {
        if (now > a.cooldownUntil) {
          a.status = 'active';
          a.cooldownUntil = null;
        } else {
          return false;
        }
      }
      return a.models.includes(model);
    });
  }

  select(model) {
    const cands = this.candidatesForModel(model);
    if (cands.length === 0) return null;
    const scored = cands.map((a) => ({
      a,
      // 连续错误越多越靠后；最近用过（lastUsedAt 大）越靠后；权重越大越靠前
      score: (a.consecutiveErrors || 0) * 1e9 + (a.lastUsedAt || 0) - Math.random() * (a.weight || 1) * 1e6,
    }));
    scored.sort((x, y) => x.score - y.score);
    return scored[0].a;
  }

  allModels() {
    const set = new Set();
    this.accounts.forEach((a) => a.models.forEach((m) => set.add(m)));
    return [...set].sort();
  }

  summary() {
    return this.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      enabled: a.enabled,
      models: a.models,
      used: a.used,
      consecutiveErrors: a.consecutiveErrors,
      cooldownUntil: a.cooldownUntil,
      lastError: a.lastError,
    }));
  }
}
