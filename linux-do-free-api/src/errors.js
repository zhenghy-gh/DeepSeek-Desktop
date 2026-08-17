// 把上游返回的「状态码 + 响应体」分类为可控的失败类型，决定号池如何处置该账号。

const QUOTA_PATTERNS = [
  /额度/i, /quota/i, /insufficient/i, /余额/i, /用完/i, /expired/i,
  /no (balance|quota)/i, /out of (credit|quota)/i, /充值/i,
  /account.*(limit|exceed)/i, /daily.*limit/i, /免费额度/i,
];

const KEY_PATTERNS = [
  /invalid.*api.?key/i, /incorrect.*api.?key/i, /unauthorized/i, /authentication/i,
  /api key.*(not|invalid|incorrect|missing)/i, /密钥/i,
  /key.*(expired|revoked|invalid)/i, /未授权/i, /鉴权/i,
];

export function classifyError(statusCode, bodyText = '') {
  const text = String(bodyText || '');
  if (statusCode === 0) return { type: 'network', retryable: true, transient: true };
  if (statusCode === 401 || statusCode === 403) {
    if (KEY_PATTERNS.some((r) => r.test(text))) return { type: 'invalid_key', retryable: false, transient: false };
    return { type: 'auth', retryable: false, transient: false };
  }
  if (statusCode === 402 || statusCode === 429) {
    return { type: 'quota', retryable: false, transient: true };
  }
  if (QUOTA_PATTERNS.some((r) => r.test(text))) return { type: 'quota', retryable: false, transient: true };
  if (KEY_PATTERNS.some((r) => r.test(text))) return { type: 'invalid_key', retryable: false, transient: false };
  if (statusCode >= 500) return { type: 'upstream_error', retryable: true, transient: true };
  // 4xx 其他（400 参数错误等）通常是请求本身的问题，不应切换账号重试
  if (statusCode >= 400) return { type: 'client_error', retryable: false, transient: false };
  return { type: 'unknown', retryable: true, transient: true };
}

export const ERROR_MESSAGES = {
  quota: '账号额度已用尽，已临时停用并冷却',
  invalid_key: '账号 API Key 失效，已停用，需手动更新',
  auth: '账号鉴权失败，已停用',
  upstream_error: '上游中转站异常',
  network: '网络错误，无法连接上游',
  client_error: '请求被上游拒绝（可能是参数问题）',
  unknown: '未知上游错误',
};
