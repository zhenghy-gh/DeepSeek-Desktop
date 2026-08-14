'use strict'

/**
 * 版本升级模块：
 *  - 检查 GitHub Releases 最新版本（api.github.com，匿名可用）
 *  - 有新版本时按平台/架构选择对应安装包
 *  - 下载到系统下载目录（带进度）
 *  - 「重启更新」：打开安装包并退出应用（未签名应用的标准更新方式）
 */
const { app, shell } = require('electron')
const https = require('node:https')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const REPO = 'zhenghy-gh/DeepSeek-Desktop'
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 每 6 小时检查一次
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function log(...args) {
  console.log(`[updater ${new Date().toISOString()}]`, ...args)
}

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number)
  const pb = String(b).replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x - y
  }
  return 0
}

function httpGetJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    const req = client.get(
      url,
      { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' }, timeout: timeoutMs },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`))
            return
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (e) {
            reject(e)
          }
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('请求超时'))
    })
    req.on('error', reject)
  })
}

/** 按平台/架构从 release assets 里选择安装包 */
function pickAsset(assets) {
  const platform = process.platform
  const arch = process.arch
  const list = Array.isArray(assets) ? assets : []
  const has = (name, key) => name.toLowerCase().includes(key)

  let candidates = []
  if (platform === 'darwin') {
    candidates = list.filter((a) => has(a.name, 'mac') && /\.(dmg|zip)$/.test(a.name))
    // 优先 dmg
    candidates.sort((a, b) => (a.name.endsWith('.dmg') ? -1 : 1) - (b.name.endsWith('.dmg') ? -1 : 1))
  } else if (platform === 'win32') {
    candidates = list.filter((a) => has(a.name, 'win') && a.name.endsWith('.exe'))
  } else if (platform === 'linux') {
    candidates = list.filter((a) => has(a.name, 'linux') && a.name.endsWith('.AppImage'))
  }
  if (candidates.length === 0) return null

  // 优先匹配架构（arm64 / x64 / x86_64 / amd64）
  const archKey = arch === 'arm64' ? 'arm64' : arch === 'x64' ? ['x64', 'x86_64', 'amd64'] : arch
  const keys = Array.isArray(archKey) ? archKey : [archKey]
  const exact = candidates.find((a) => keys.some((k) => has(a.name, k)))
  return exact || candidates[0]
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    const req = client.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`下载失败 HTTP ${res.statusCode}`))
        return
      }
      const total = Number(res.headers['content-length']) || 0
      let received = 0
      const out = fs.createWriteStream(dest)
      res.on('data', (chunk) => {
        received += chunk.length
        if (total > 0 && onProgress) onProgress(received, total)
      })
      res.pipe(out)
      out.on('finish', () => out.close(() => resolve(dest)))
      out.on('error', (e) => {
        out.destroy()
        reject(e)
      })
    })
    // 45 秒无数据则中止（GitHub 慢网下避免永久挂起），socket 活动会自动重置计时
    req.setTimeout(45000, () => {
      req.destroy(new Error('下载超时（网络无进展）'))
    })
    req.on('error', (e) => {
      try {
        fs.unlinkSync(dest)
      } catch { /* ignore */ }
      reject(e)
    })
  })
}

class Updater {
  constructor({ onStatus, getWindow }) {
    this.onStatus = onStatus
    this.getWindow = getWindow
    this.state = 'idle' // idle | checking | available | downloading | downloaded | error
    this.latest = null
    this.downloadPath = null
    this.checkTimer = null
  }

  emit() {
    try {
      this.onStatus({
        state: this.state,
        version: this.latest ? this.latest.tag_name : null,
        notes: this.latest ? this.latest.body || '' : '',
        progress: this.progress || 0,
        url: this.latest ? this.latest.html_url : null,
        error: this.error || null,
        downloadPath: this.downloadPath,
      })
    } catch { /* ignore */ }
  }

  start() {
    // 启动延迟 8 秒检查一次，之后每 6 小时
    setTimeout(() => this.check(), 8000)
    this.checkTimer = setInterval(() => this.check(), CHECK_INTERVAL_MS)
  }

  async check(manual = false) {
    if (this.state === 'downloading') return
    this.state = 'checking'
    this.error = null
    this.emit()
    try {
      const release = await httpGetJson(RELEASES_API)
      const latestTag = String(release.tag_name || '').replace(/^v/, '')
      const current = app.getVersion()
      log(`check: current=${current} latest=${latestTag}`)
      if (compareVersions(latestTag, current) > 0) {
        this.latest = release
        this.state = 'available'
        this.emit()
        // 自动开始下载，下载完成后由用户点击「重启更新」
        this.download()
      } else {
        this.latest = null
        this.state = 'idle'
        this.emit()
      }
    } catch (e) {
      log(`check failed: ${e.message}`)
      this.error = e.message
      // 手动检查失败要告知；自动检查静默
      this.state = manual ? 'error' : 'idle'
      this.emit()
    }
  }

  async download() {
    if (!this.latest || this.state === 'downloading') return
    const asset = pickAsset(this.latest.assets)
    if (!asset) {
      this.error = '未找到当前平台的安装包'
      this.state = 'error'
      this.emit()
      return
    }
    this.state = 'downloading'
    this.progress = 0
    this.emit()

    const dest = path.join(
      app.getPath('downloads'),
      `DeepSeek-Desktop-${String(this.latest.tag_name).replace(/^v/, '')}-${process.platform}-${process.arch}${path.extname(asset.name)}`
    )
    try {
      await downloadFile(asset.browser_download_url, dest, (received, total) => {
        this.progress = Math.round((received / total) * 100)
        this.emit()
      })
      this.progress = 100
      this.downloadPath = dest
      this.state = 'downloaded'
      log(`downloaded to ${dest}`)
      this.emit()
    } catch (e) {
      log(`download failed: ${e.message}`)
      this.error = e.message
      this.state = 'error'
      this.emit()
    }
  }

  /** 打开安装包并退出应用（重启更新） */
  installAndRestart() {
    if (!this.downloadPath || !fs.existsSync(this.downloadPath)) return
    log(`install: opening ${this.downloadPath}`)
    const p = this.downloadPath
    try {
      if (process.platform === 'darwin') {
        shell.openPath(p) // 挂载 dmg
      } else if (process.platform === 'win32') {
        shell.openPath(p) // 运行 NSIS 安装器
      } else {
        shell.showItemInFolder(p) // Linux：打开所在目录
        shell.openPath(p)
      }
    } catch (e) {
      log(`open failed: ${e.message}`)
    }
    setTimeout(() => app.quit(), 800)
  }
}

module.exports = { Updater, compareVersions }
