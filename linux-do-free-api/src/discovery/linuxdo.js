// ─────────────────────────────────────────────────────────────────────────────
// 实验性：从 linux.do 抓取免费中转信息
//
// 重要说明（请先读）：
//   1. linux.do 需要登录，且分享帖频繁变动，自动化抓取脆弱、可能违反站点条款。
//   2. 中转站 Key 属于他人资源，滥用可能导致封号；请仅录入你本人注册/签到的账号。
//   3. 推荐做法：人工在论坛收集「中转地址 + Key + 支持的模型」后，用
//      `node src/cli.js add` 录入号池。本模块仅作为辅助提取工具。
//
// 因此这里只提供「给定已登录 Cookie + 帖子链接，提取疑似中转域名 / api-key」的能力，
// 不负责自动注册或自动签到。
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import https from 'node:https';

/** 拉取某个 linux.do 帖子（需提供登录后的 _t / session cookie） */
export function fetchThread(cookie, threadUrl, { timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(threadUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const headers = {
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0 (compatible; ldfa-discovery/0.1)',
      Accept: 'text/html,application/xhtml+xml',
    };
    const req = lib.request(url, { method: 'GET', headers, timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchThread(cookie, new URL(res.headers.location, threadUrl).href, { timeout }));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** 从 HTML / 文本中提取疑似中转域名与 api-key */
export function extractRelays(text) {
  const relays = new Set();
  const keyRe = /sk-[A-Za-z0-9_\-]{16,}/g;
  const urlRe = /https?:\/\/[^\s"'<>)]+/g;

  const urls = text.match(urlRe) || [];
  for (const u of urls) {
    try {
      const host = new URL(u).host;
      // 过滤掉论坛本身与常见非中转域名
      if (/linux\.do|discourse|github\.com|google\.com|telegram\.me|t\.me/.test(host)) continue;
      relays.add(u.replace(/\/+$/, ''));
    } catch {}
  }

  const keys = (text.match(keyRe) || []).map((k) => k.trim());
  return { relays: [...relays], keys };
}

/**
 * 端到端示例（需自备 cookie 与帖子链接）：
 *   const html = await fetchThread(cookie, 'https://linux.do/t/xxx');
 *   const { relays, keys } = extractRelays(html);
 *   然后人工核对后调用 store.add(...) 录入号池。
 */
