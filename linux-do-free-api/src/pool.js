import { isHealthy } from './account.js';

/**
 * 号池：负责「为某个模型挑选一个可用账号」。
 *
 * 选择策略（strategy）:
 *  - 'weighted'（默认）：连续错误少 + 最近没用过 的账号优先，权重做随机扰动实现负载均衡。
 *  - 'round_robin'：在候选中按顺序轮流，保证均匀分摊。
 *  - 'least_used'：优先选累计用量最少的账号。
 *
 * 模型别名（aliases）：映射 { 别名: [真名...] }。
 * 请求 model 既可以是别名也可以是真名，双向都能命中（请求别名→命中真名账号；请求真名→命中别名账号）。
 *
 * 账号分组（group）：账号可打 groups 标签，请求通过 payload.group 或 X-LDFA-Group 头指定分组，
 * 号池只在「属于该分组且支持模型」的账号里选号。不指定则不限分组。
 */
export class AccountPool {
  constructor(store, { strategy = 'weighted', aliases = null } = {}) {
    this.store = store;
    this.strategy = strategy;
    this.aliases = aliases || {};
    this._rrCursor = 0;
    // 反向索引：真名 -> [别名...]，用于请求写真名时也能命中别名配置的账号
    this._reverseAliases = {};
    for (const [alias, reals] of Object.entries(this.aliases)) {
      reals.forEach((r) => {
        (this._reverseAliases[r] ||= []).push(alias);
      });
    }
  }

  /** 将请求 model 展开为「等价匹配集合」（含自身 + 别名 + 反向别名） */
  _matchSet(model) {
    const set = new Set([model]);
    const direct = this.aliases[model];
    if (direct) direct.forEach((x) => set.add(x));
    const reverse = this._reverseAliases[model];
    if (reverse) reverse.forEach((x) => set.add(x));
    return set;
  }

  get accounts() {
    return this.store.accounts;
  }

  /** 返回支持该模型且当前可用的账号（会就地复活冷却结束的 exhausted 账号） */
  candidatesForModel(model, { group, exclude } = {}) {
    const now = Date.now();
    const matchSet = this._matchSet(model);
    const ex = exclude instanceof Set ? exclude : null;
    return this.accounts.filter((a) => {
      if (a.status === 'removed') return false; // 软删除的账号不参与选号
      if (!a.enabled || a.status === 'disabled') return false;
      if (ex && ex.has(a.id)) return false;
      if (a.cooldownUntil && now < a.cooldownUntil) return false;
      if (a.status === 'exhausted') {
        if (now > a.cooldownUntil) {
          a.status = 'active';
          a.cooldownUntil = null;
        } else {
          return false;
        }
      }
      if (group && (!a.groups || !a.groups.includes(group))) return false;
      return a.models.some((m) => matchSet.has(m));
    });
  }

  select(model, opts = {}) {
    const cands = this.candidatesForModel(model, opts);
    if (cands.length === 0) return null;

    if (this.strategy === 'least_used') {
      return cands.slice().sort((a, b) => (a.used || 0) - (b.used || 0))[0];
    }
    if (this.strategy === 'round_robin') {
      const idx = this._rrCursor % cands.length;
      this._rrCursor++;
      return cands[idx];
    }
    // weighted（默认）：连续错误越多越靠后；最近用过越靠后；权重越大越靠前；加随机扰动
    // 权重取「模型级权重（命中时）」或账号级 weight
    const scored = cands.map((a) => {
      const w = (a.modelWeights && a.modelWeights[model] != null) ? Number(a.modelWeights[model]) : (a.weight || 1);
      return { a, score: (a.consecutiveErrors || 0) * 1e9 + (a.lastUsedAt || 0) - Math.random() * w * 1e6 };
    });
    scored.sort((x, y) => x.score - y.score);
    return scored[0].a;
  }

  allModels() {
    const set = new Set();
    this.accounts.forEach((a) => a.models.forEach((m) => set.add(m)));
    return [...set].sort();
  }

  summary() {
    // 软删除的账号不出现在号池概览（仍可通过 API/CLI 恢复或 purge）
    return this.accounts.filter((a) => a.status !== 'removed').map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      enabled: a.enabled,
      models: a.models,
      groups: a.groups || [],
      modelWeights: a.modelWeights || null,
      note: a.note || null,
      weight: a.weight,
      used: a.used,
      promptTokens: a.promptTokens || 0,
      completionTokens: a.completionTokens || 0,
      totalTokens: a.totalTokens || 0,
      consecutiveErrors: a.consecutiveErrors,
      cooldownUntil: a.cooldownUntil,
      lastError: a.lastError,
    }));
  }

  /** 解析 "alias:real1,real2;alias2:real3" 形式的别名字符串 */
  static parseAliases(str) {
    const out = {};
    if (!str) return out;
    for (const part of String(str).split(';')) {
      const [alias, reals] = part.split(':');
      if (!alias || !reals) continue;
      out[alias.trim()] = reals
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return out;
  }
}
