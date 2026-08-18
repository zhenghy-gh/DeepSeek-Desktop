// 主动探活：对号池里每个账号发一个轻量请求（GET /v1/models），判断上游是否可达。
// 与请求链路解耦，可作为运维工具/Web 页「一键体检」使用。不自动改账号状态（只报告），避免误杀。

/**
 * @param {object} account 内部账号对象（需 baseUrl / apiKey / id / name）
 * @param {{timeoutMs?:number, fetchFn?:Function}} [opts]
 * @returns {Promise<{id:string,name:string,reachable:boolean,status?:number,error?:string}>}
 */
export async function probeAccount(account, { timeoutMs = 8000, fetchFn = globalThis.fetch } = {}) {
  const url = (account.baseUrl || '').replace(/\/+$/, '') + '/v1/models';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${account.apiKey || ''}` },
      signal: ctrl.signal,
    });
    return { id: account.id, name: account.name, reachable: r.ok, status: r.status };
  } catch (e) {
    const err = e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || String(e);
    return { id: account.id, name: account.name, reachable: false, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 并发探活所有账号 */
export async function probeAccounts(accounts, opts = {}) {
  return Promise.all(accounts.map((a) => probeAccount(a, opts)));
}
