import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAccount } from './account.js';

/** 号池持久化：本地 JSON 文件，零依赖。 */
export class Store {
  constructor(file) {
    this.file = file;
    this.accounts = [];
    this.lastSaveAt = 0; // 最近一次 save 的时间戳，供热重载去抖忽略自身写入
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const arr = JSON.parse(raw);
      this.accounts = Array.isArray(arr) ? arr.map((a) => createAccount(a)) : [];
    } catch (e) {
      if (e.code === 'ENOENT') {
        this.accounts = [];
      } else {
        throw e;
      }
    }
    return this.accounts;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    // 原子写：先写临时文件再 rename，避免并发保存或崩溃导致原文件损坏
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.accounts, null, 2));
      fs.renameSync(tmp, this.file);
      this.lastSaveAt = Date.now();
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  }

  add(input) {
    const a = createAccount(input);
    this.accounts.push(a);
    this.save();
    return a;
  }

  remove(id) {
    // 软删除：标记为 removed（隐藏但仍保留，可恢复），避免误删导致号池数据丢失
    const a = this.get(id);
    if (a) {
      a.status = 'removed';
      a.enabled = false;
      a.updatedAt = Date.now();
      this.save();
    }
  }

  /** 彻底删除（不可恢复），用于清理软删除的账号 */
  purge(id) {
    this.accounts = this.accounts.filter((a) => a.id !== id);
    this.save();
  }

  /** 恢复软删除的账号（回到 active） */
  restore(id) {
    const a = this.get(id);
    if (a) {
      a.status = 'active';
      a.enabled = true;
      a.cooldownUntil = null;
      a.updatedAt = Date.now();
      this.save();
    }
  }

  get(id) {
    return this.accounts.find((a) => a.id === id);
  }

  /**
   * 用一份账号数组整体替换当前号池（用于备份恢复）。会逐个规范化，并去重 id。
   * @param {Array} arr 原始账号数组
   * @returns {number} 导入的账号数
   */
  replaceAccounts(arr) {
    if (!Array.isArray(arr)) throw new Error('accounts must be an array');
    const seen = new Set();
    const accounts = [];
    for (const raw of arr) {
      const a = createAccount(raw);
      if (seen.has(a.id)) continue; // 去重
      seen.add(a.id);
      accounts.push(a);
    }
    this.accounts = accounts;
    this.save();
    return accounts.length;
  }

  findByName(name) {
    return this.accounts.find((a) => a.name === name);
  }

  /**
   * 校验号池配置，返回可读问题列表（不修改任何数据）。
   * level: 'error' 表示会导致请求必然失败的硬错误；'warning' 为可疑配置。
   */
  validate() {
    const problems = [];
    this.accounts.forEach((a) => {
      if (!a.baseUrl || !/^https?:\/\//i.test(a.baseUrl)) {
        problems.push({ id: a.id, name: a.name, level: 'error', msg: 'baseUrl 非法或缺失（需以 http(s):// 开头）' });
      }
      if (!a.apiKey) {
        problems.push({ id: a.id, name: a.name, level: 'warning', msg: 'apiKey 为空，该账号无法向上游鉴权' });
      }
      if (!Array.isArray(a.models) || a.models.length === 0) {
        problems.push({ id: a.id, name: a.name, level: 'warning', msg: '未声明 models，将匹配任意模型的请求（可能误命中）' });
      }
      // modelWeights 校验：应为 { [model]: 正数 } 的对象，否则加权选号会落到账号级 weight
      if (a.modelWeights != null) {
        if (typeof a.modelWeights !== 'object' || Array.isArray(a.modelWeights)) {
          problems.push({ id: a.id, name: a.name, level: 'warning', msg: 'modelWeights 不是对象，将被忽略（请使用 {"model": 权重} 形式）' });
        } else {
          for (const [m, w] of Object.entries(a.modelWeights)) {
            if (!(Number(w) > 0)) {
              problems.push({ id: a.id, name: a.name, level: 'warning', msg: `modelWeights["${m}"] 权重非法（需为正数），该项将被忽略` });
            }
          }
        }
      }
      // note 校验：应为字符串（持久化时会被截断到 500 字）；非字符串视为数据损坏
      if (a.note != null && typeof a.note !== 'string') {
        problems.push({ id: a.id, name: a.name, level: 'warning', msg: 'note 不是字符串，已损坏（运行期将被重置为 null）' });
      }
      // 注：分组重复已由 createAccount 在规范化阶段静默去重，无需在校验中重复报警
    });

    // 跨账号重复提示：相同 apiKey（同一上游凭证被多次录入）或相同 name（易混淆）
    // 注意：空 apiKey 已在上面单独警告，这里跳过以免噪音
    const byKey = new Map();
    const byName = new Map();
    this.accounts.forEach((a) => {
      if (a.apiKey) {
        if (!byKey.has(a.apiKey)) byKey.set(a.apiKey, []);
        byKey.get(a.apiKey).push(a.name);
      }
      if (a.name) {
        if (!byName.has(a.name)) byName.set(a.name, []);
        byName.get(a.name).push(a.id);
      }
    });
    for (const [key, names] of byKey) {
      if (names.length > 1) {
        names.forEach((n) =>
          problems.push({ id: null, name: n, level: 'warning', msg: `apiKey 与 ${names.filter((x) => x !== n).join('、')} 重复，疑似同一凭证被多次添加` })
        );
      }
    }
    for (const [name, ids] of byName) {
      if (ids.length > 1) {
        problems.push({ id: ids[0], name, level: 'warning', msg: `账号名重复（id: ${ids.join(', ')}），建议用 edit --id 区分` });
      }
    }
    return problems;
  }
}
