// 极简结构化日志，零依赖。输出 JSON 行到 stderr（不污染代理 JSON 响应）。
// 级别由 LOG_LEVEL 控制（debug|info|warn|error，默认 info）。
// 若提供 file（LOG_FILE），则同时写入按大小轮转的文件（LOG_FILE_MAX_BYTES / LOG_FILE_KEEP 可调）。

import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 按大小轮转的文件写入器，零依赖、同步实现。
 * 当累计写入超过 maxBytes 时，将 file 重命名为 file.1，file.1->file.2 ... 保留最近 keep 份。
 */
export function createRotatingFileStream(file, { maxBytes = 10 * 1024 * 1024, keep = 3 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd = fs.openSync(file, 'a');
  let size = fs.fstatSync(fd).size;

  function rotate() {
    try {
      fs.closeSync(fd);
    } catch {}
    for (let i = keep - 1; i >= 1; i--) {
      const src = i === 1 ? file : `${file}.${i - 1}`;
      const dst = `${file}.${i}`;
      try {
        fs.renameSync(src, dst);
      } catch {}
    }
    fd = fs.openSync(file, 'a');
    size = 0;
  }

  return {
    write(str) {
      const b = Buffer.byteLength(str);
      if (size + b > maxBytes) rotate();
      try {
        fs.writeSync(fd, str);
        size += b;
      } catch {}
    },
    end() {
      try {
        fs.closeSync(fd);
      } catch {}
    },
  };
}

export function createLogger({ level = process.env.LOG_LEVEL || 'info', stream, file } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const targets = [];
  if (stream) targets.push({ write: (s) => { try { stream.write(s); } catch {} } });
  if (file) {
    const maxBytes = Number(process.env.LOG_FILE_MAX_BYTES) || 10 * 1024 * 1024;
    const keep = Number(process.env.LOG_FILE_KEEP) || 3;
    const rf = createRotatingFileStream(file, { maxBytes, keep });
    targets.push({ write: (s) => rf.write(s) });
  }
  if (targets.length === 0) {
    targets.push({ write: (s) => { try { process.stderr.write(s); } catch {} } });
  }

  const emit = (lvl, msg, meta) => {
    if (LEVELS[lvl] < threshold) return;
    const entry = { ts: new Date().toISOString(), lvl, msg };
    if (meta !== undefined) entry.meta = meta;
    const line = JSON.stringify(entry) + '\n';
    for (const t of targets) t.write(line);
  };

  return {
    debug: (m, x) => emit('debug', m, x),
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x),
  };
}
