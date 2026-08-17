import fs from 'node:fs';
import path from 'node:path';
import { createAccount } from './account.js';

/** 号池持久化：本地 JSON 文件，零依赖。 */
export class Store {
  constructor(file) {
    this.file = file;
    this.accounts = [];
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
    fs.writeFileSync(this.file, JSON.stringify(this.accounts, null, 2));
  }

  add(input) {
    const a = createAccount(input);
    this.accounts.push(a);
    this.save();
    return a;
  }

  remove(id) {
    this.accounts = this.accounts.filter((a) => a.id !== id);
    this.save();
  }

  get(id) {
    return this.accounts.find((a) => a.id === id);
  }

  findByName(name) {
    return this.accounts.find((a) => a.name === name);
  }
}
