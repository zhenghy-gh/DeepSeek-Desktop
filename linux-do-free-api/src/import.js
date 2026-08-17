// 多平台账号导入：把常见 OpenAI 兼容平台（Codex / One API / New API / NextChat /
// 各中转站仪表盘导出、.env）的配置统一解析为号池账号。
// 设计原则：字段名容错 + 自动识别格式，避免为每个平台写死一套 schema。

const BASE_KEYS = ['base_url', 'baseUrl', 'endpoint', 'url', 'server', 'api_base', 'base', 'host'];
const KEY_KEYS = ['api_key', 'apiKey', 'key', 'token', 'access_token', 'secret', 'sk', 'apikey'];
const NAME_KEYS = ['name', 'remark', 'title', 'site', 'platform', 'tag'];
const MODEL_KEYS = ['models', 'model', 'model_list', 'support_models', 'modelList'];

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

/** 把任意对象归一化为一个账号候选；缺 baseUrl 或 apiKey 则返回 null */
export function normalizeAccount(obj, fallbackName) {
  if (!obj || typeof obj !== 'object') return null;
  const lower = Object.keys(obj).reduce((m, k) => ((m[k.toLowerCase()] = obj[k]), m), {});
  const get = (keys) => {
    for (const k of keys) {
      const v = obj[k];
      if (v !== undefined && v !== null && v !== '') return v;
      const lv = lower[k.toLowerCase()];
      if (lv !== undefined && lv !== null && lv !== '') return lv;
    }
    return undefined;
  };

  let baseUrl = get(BASE_KEYS);
  let apiKey = get(KEY_KEYS);
  if (!baseUrl || !apiKey) return null;

  baseUrl = String(baseUrl).replace(/\/+$/, '');
  let models = get(MODEL_KEYS) || [];
  if (typeof models === 'string') models = models.split(',').map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(models)) models = [];

  const name = String(get(NAME_KEYS) || fallbackName || hostOf(baseUrl));
  const weight = Number(obj.weight) || 1;
  return { name, baseUrl, apiKey: String(apiKey), models, weight };
}

function parseEnv(text) {
  const map = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    map[m[1].toUpperCase()] = v;
  }
  const baseUrl =
    map.OPENAI_BASE_URL || map.BASE_URL || map.API_BASE || map.OPENAI_API_BASE || map.ENDPOINT;
  const apiKey = map.OPENAI_API_KEY || map.API_KEY || map.OPENAI_KEY || map.KEY || map.TOKEN;
  if (!baseUrl || !apiKey) return [];
  const models = map.OPENAI_MODELS ? map.OPENAI_MODELS.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return [{ name: 'env-import', baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, models, weight: 1 }];
}

function parseJson(data) {
  const out = [];
  if (Array.isArray(data)) {
    for (const it of data) {
      const a = normalizeAccount(it);
      if (a) out.push(a);
    }
    return out;
  }
  if (data && typeof data === 'object') {
    // NextChat / OneChat 风格：{ openai: { base_url, api_key, models } }
    if (data.openai && typeof data.openai === 'object') {
      const a = normalizeAccount(data.openai, 'nextchat');
      if (a) out.push(a);
    }
    if (data.openai_api_key || data.openai_base_url) {
      const a = normalizeAccount(
        { api_key: data.openai_api_key, base_url: data.openai_base_url, models: data.openai_models },
        'nextchat'
      );
      if (a) out.push(a);
    }
    // One API / New API 批量导出：{ data: [...] } 或 { accounts: [...] }
    for (const key of ['data', 'accounts', 'items', 'list']) {
      if (Array.isArray(data[key])) {
        for (const it of data[key]) {
          const a = normalizeAccount(it);
          if (a) out.push(a);
        }
      }
    }
    // 单个对象
    const a = normalizeAccount(data);
    if (a) out.push(a);
  }
  return out;
}

/**
 * 解析导入文本。
 * @param {string} text
 * @param {{format?: 'auto'|'json'|'env'|'codex'|'oneapi'|'nextchat'}} [opts]
 */
export function parseImport(text, { format = 'auto' } = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];

  // codex/oneapi/nextchat 都走同样的 JSON 归一化（字段容错已覆盖）
  const forceJson = ['codex', 'oneapi', 'nextchat'].includes(format);
  const looksEnv = format === 'env' || (format === 'auto' && /^\s*\w[\w.-]*\s*=/.test(trimmed) && !/^[\[{]/.test(trimmed));

  if (looksEnv && !forceJson) {
    const env = parseEnv(trimmed);
    if (env.length) return env;
    if (format === 'env') return [];
    // 不是合法 env 也尝试当 JSON
  }

  if (forceJson || !looksEnv) {
    try {
      return parseJson(JSON.parse(trimmed));
    } catch (e) {
      if (format !== 'auto') throw new Error(`JSON 解析失败: ${e.message}`);
    }
  }
  // 兜底：当纯文本试试 env
  return parseEnv(trimmed);
}

/**
 * 把候选账号写入号池（或仅预览）。
 * 去重：相同 apiKey 或 (baseUrl+apiKey) 已存在则跳过。
 */
export function importAccounts(store, candidates, { dryRun = false, prefix = '', skipExisting = true } = {}) {
  const byKey = new Set(store.accounts.map((a) => a.apiKey));
  const byPair = new Set(store.accounts.map((a) => `${a.baseUrl}|${a.apiKey}`));
  const added = [];
  const skipped = [];

  for (const c of candidates) {
    const pair = `${c.baseUrl}|${c.apiKey}`;
    if (skipExisting && (byKey.has(c.apiKey) || byPair.has(pair))) {
      skipped.push(c);
      continue;
    }
    const name = prefix ? `${prefix}-${c.name}` : c.name;
    if (dryRun) {
      added.push({ ...c, name, status: 'active' });
    } else {
      const a = store.add({ ...c, name });
      added.push(a);
    }
  }
  return { added, skipped };
}
