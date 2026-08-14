'use strict'

const { app, BrowserWindow, WebContentsView, Menu, ipcMain, shell, clipboard } = require('electron')
const { spawn, execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const HARNESS_PROBE_PORTS = [3080, 3081, 3082, 3083]
const CHAT_URL = 'https://chat.deepseek.com'
const BOOT_MARKER = '__DSH_BOOT__'
const TOOLBAR_H = 46
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

let mainWindow = null
let chatView = null
let harnessView = null
let activeTab = 'chat'
let harnessChild = null
let harnessOwned = false // true when we spawned the server ourselves
let harnessPort = 3080
let harnessUrl = null
let lastStatus = 'connecting'
let lastDetail = '正在检查 Harness…'
let lastExtra = {}
let logTail = [] // last lines of dsh output for diagnostics

function log(...args) {
  const line = `[desktop ${new Date().toISOString()}] ${args.join(' ')}`
  console.log(line)
  logTail.push(line)
  if (logTail.length > 200) logTail.shift()
}

function sendStatus(status, detail, extra = {}) {
  lastStatus = status
  lastDetail = detail
  lastExtra = extra
  // 出错时隐藏 Harness 视图，露出渲染层的错误面板；恢复后按当前标签页决定显隐
  if (harnessView) {
    if (status === 'error') harnessView.setVisible(false)
    else if (status === 'running' && activeTab === 'harness') harnessView.setVisible(true)
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('harness-status', { status, detail, port: harnessPort, ...extra })
  }
}

// ---------- Node / dsh 定位 ----------

function findNode() {
  const candidates = []
  if (process.env.DSH_DESKTOP_NODE) candidates.push(process.env.DSH_DESKTOP_NODE)
  candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node')
  try {
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node')
    if (fs.existsSync(nvmDir)) {
      const versions = fs.readdirSync(nvmDir).sort((a, b) => {
        const va = a.split('.').map(Number)
        const vb = b.split('.').map(Number)
        for (let i = 0; i < 3; i++) return (vb[i] || 0) - (va[i] || 0)
        return 0
      })
      for (const v of versions) candidates.push(path.join(nvmDir, v, 'bin', 'node'))
    }
  } catch { /* ignore */ }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch { /* ignore */ }
  }
  return null
}

function findBundledDsh() {
  try {
    const p = path.join(process.resourcesPath, 'dsh-runtime', 'node_modules', '.bin', 'dsh')
    return fs.existsSync(p) ? p : null
  } catch {
    return null
  }
}

function findNpxDsh() {
  // 扫描 ~/.npm/_npx/<hash>/node_modules/.bin/dsh，取最新
  try {
    const npxDir = path.join(os.homedir(), '.npm', '_npx')
    if (!fs.existsSync(npxDir)) return null
    let best = null
    let bestTime = 0
    for (const entry of fs.readdirSync(npxDir)) {
      const p = path.join(npxDir, entry, 'node_modules', '.bin', 'dsh')
      try {
        if (fs.existsSync(p)) {
          const st = fs.statSync(p)
          if (st.mtimeMs > bestTime) {
            bestTime = st.mtimeMs
            best = p
          }
        }
      } catch { /* ignore */ }
    }
    return best
  } catch {
    return null
  }
}

function extendedEnv() {
  const extra = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    path.join(os.homedir(), '.nvm', 'versions', 'node', '*', 'bin'),
  ]
  const merged = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
  for (const d of extra) if (d && !merged.includes(d)) merged.push(d)
  return { ...process.env, PATH: merged.join(path.delimiter) }
}

// ---------- Harness 探测 / 启动 ----------

function probePort(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', timeout: timeoutMs },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          resolve({ alive: true, isHarness: body.includes(BOOT_MARKER) })
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ alive: false, isHarness: false })
    })
    req.on('error', () => resolve({ alive: false, isHarness: false }))
  })
}

async function findExistingHarness() {
  for (const port of HARNESS_PROBE_PORTS) {
    const r = await probePort(port)
    if (r.alive && r.isHarness) return port
  }
  return null
}

function spawnHarness(nodePath, dshScript, port, viaPath = false) {
  const env = extendedEnv()
  const args = nodePath
    ? [dshScript, 'web', '--port', String(port)]
    : ['web', '--port', String(port)]
  const bin = nodePath || dshScript
  // 无系统 node 时用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE）；pty.node 是 N-API，兼容
  if (nodePath === process.execPath) env.ELECTRON_RUN_AS_NODE = '1'
  log(`spawning harness: ${bin} ${args.join(' ')}`)
  const child = spawn(bin, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => log(`[dsh] ${String(d).trimEnd()}`))
  child.stderr.on('data', (d) => log(`[dsh:err] ${String(d).trimEnd()}`))
  child.on('error', (err) => {
    // 通过 PATH 调 dsh 但命令不存在（未安装）
    log(`dsh spawn error: ${err.message}`)
    if (viaPath && err.code === 'ENOENT') {
      sendStatus('error', '未检测到 dsh 运行时，请先安装', {
        noDsh: true,
        installCmd: INSTALL_CMD,
        installHint: '安装完成后点击「重新启动」即可自动拉起 Harness',
      })
    }
  })
  child.on('exit', (code, signal) => {
    log(`dsh exited code=${code} signal=${signal} (owned=${harnessOwned})`)
    if (harnessOwned && mainWindow && !mainWindow.isDestroyed()) {
      sendStatus('error', `Harness 进程意外退出 (code=${code})`)
    }
  })
  return child
}

const INSTALL_CMD = 'npm install -g @deepseek-ai/dsh'

let ensureRunning = false
async function ensureHarness() {
  if (ensureRunning) return // 防重入（启动时与切标签时可能并发触发）
  ensureRunning = true
  try {
    sendStatus('connecting', '正在检查 Harness…')

    const existing = await findExistingHarness()
    if (existing !== null) {
      harnessPort = existing
      harnessOwned = false
      log(`harness already running on port ${existing}, will reuse it`)
      sendStatus('running', `已连接现有 Harness（端口 ${existing}）`)
      loadHarnessView()
      return
    }

    const nodePath = findNode() || process.execPath // 兜底：Electron 自带 Node
    let dshScript = findBundledDsh()
    let viaPath = false
    if (!dshScript) {
      dshScript = findNpxDsh()
    }
    if (!dshScript) {
      viaPath = true
      dshScript = 'dsh'
    }

    if (nodePath === process.execPath && viaPath) {
      // 既没有内置运行时，也找不到 PATH/npx 里的 dsh → 视为未安装
      log('dsh not found: bundled=no, PATH=no, npx=no')
      sendStatus('error', '未检测到 dsh 运行时，请先安装', {
        noDsh: true,
        installCmd: INSTALL_CMD,
        installHint: '安装完成后点击「重新启动」即可自动拉起 Harness',
      })
      return
    }

    harnessOwned = true
    let lastErr = null
    for (const port of HARNESS_PROBE_PORTS) {
      const started = Date.now()
      harnessChild = spawnHarness(nodePath, dshScript, port, viaPath)
      let spawnFailed = false
      harnessChild.once('error', () => {
        spawnFailed = true
      })
      sendStatus('starting', `正在启动 Harness（端口 ${port}）…`)

      // 等就绪或失败
      let ready = false
      while (Date.now() - started < 60000) {
        const r = await probePort(port, 1000)
        if (r.alive && r.isHarness) {
          ready = true
          break
        }
        // spawn 失败（命令不存在）→ 不再尝试其他端口
        if (spawnFailed) {
          lastErr = '命令不存在'
          break
        }
        // 进程已退出且从未就绪 → 尝试下一个端口
        if (harnessChild.exitCode !== null || harnessChild.signalCode) {
          if (harnessChild.exitCode !== null) lastErr = `exit code ${harnessChild.exitCode}`
          break
        }
        await new Promise((r2) => setTimeout(r2, 800))
      }
      if (ready) {
        harnessPort = port
        log(`harness ready on port ${port}`)
        sendStatus('running', `Harness 已启动（端口 ${port}）`)
        loadHarnessView()
        return
      }
      if (!harnessChild || (harnessChild.exitCode === null && !harnessChild.signalCode)) {
        // 超时未就绪
        lastErr = '启动超时'
        try { harnessChild.kill('SIGKILL') } catch { /* ignore */ }
      } else {
        try { harnessChild.kill('SIGKILL') } catch { /* ignore */ }
      }
      harnessChild = null
    }
    sendStatus('error', `Harness 启动失败：${lastErr || '未知错误'}`)
    log('harness start failed, last lines:', logTail.slice(-20).join('\n'))
  } finally {
    ensureRunning = false
  }
}

function stopOwnHarness() {
  if (harnessOwned && harnessChild) {
    log('stopping harness (owned)')
    const child = harnessChild
    harnessChild = null
    try {
      child.kill('SIGTERM')
    } catch { /* ignore */ }
    setTimeout(() => {
      try {
        if (child.exitCode === null) child.kill('SIGKILL')
      } catch { /* ignore */ }
    }, 4000)
  }
}

// ---------- 视图（WebContentsView，精确控制尺寸与位置） ----------

function layoutViews() {
  if (!mainWindow) return
  const [w, h] = mainWindow.getContentSize()
  const bounds = { x: 0, y: TOOLBAR_H, width: w, height: Math.max(0, h - TOOLBAR_H) }
  if (chatView) chatView.setBounds(bounds)
  if (harnessView) harnessView.setBounds(bounds)
}

function activeView() {
  return activeTab === 'chat' ? chatView : harnessView
}

function switchTab(name) {
  if (name !== 'chat' && name !== 'harness') return
  activeTab = name
  if (chatView) chatView.setVisible(name === 'chat')
  if (harnessView) harnessView.setVisible(name === 'harness' && lastStatus === 'running')
  const v = activeView()
  if (v) v.webContents.focus()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tab-changed', name)
  }
  // 切到 Harness 标签时：若服务未就绪（未启动/启动失败），自动探测并启动
  if (name === 'harness' && lastStatus !== 'running') {
    ensureHarness()
  }
}

function loadHarnessView() {
  if (!harnessView) return
  const url = `http://127.0.0.1:${harnessPort}`
  harnessUrl = url
  harnessView.webContents.loadURL(url)
}

function onBeforeInput(webContents, event, input) {
  if (!input.meta && !input.control) return
  const key = (input.key || '').toLowerCase()
  if (key === '1' || key === '2') {
    event.preventDefault()
    switchTab(key === '1' ? 'chat' : 'harness')
  } else if (key === 'r' && input.type === 'keyDown') {
    event.preventDefault()
    activeView()?.webContents.reload()
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 960,
    minHeight: 640,
    title: 'DeepSeek Desktop',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('before-input-event', (e, i) => onBeforeInput(mainWindow.webContents, e, i))

  // 对话视图
  chatView = new WebContentsView({
    webPreferences: {
      partition: 'persist:deepseek',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  chatView.webContents.setWindowOpenHandler(({ url }) => {
    if (url) shell.openExternal(url)
    return { action: 'deny' }
  })
  chatView.webContents.setUserAgent(CHROME_UA)
  chatView.webContents.loadURL(CHAT_URL)

  // Harness 视图
  harnessView = new WebContentsView({
    webPreferences: {
      partition: 'persist:harness',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  harnessView.webContents.setWindowOpenHandler(({ url }) => {
    if (url) shell.openExternal(url)
    return { action: 'deny' }
  })
  harnessView.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code === -102 && lastStatus === 'running' && harnessUrl) {
      // 连接被拒：可能是服务刚重启，自动重试
      setTimeout(() => {
        if (harnessUrl && lastStatus === 'running') harnessView.webContents.loadURL(harnessUrl)
      }, 1500)
    }
  })

  mainWindow.contentView.addChildView(chatView)
  mainWindow.contentView.addChildView(harnessView)
  harnessView.setVisible(false)
  layoutViews()

  mainWindow.on('resize', layoutViews)
  mainWindow.on('enter-full-screen', layoutViews)
  mainWindow.on('leave-full-screen', layoutViews)
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 等渲染层就绪后再探测/启动 Harness，避免状态事件在监听器注册前丢失
  mainWindow.webContents.on('did-finish-load', () => {
    ensureHarness()
  })
}

// ---------- IPC ----------

ipcMain.handle('desk:get-state', () => ({
  chatUrl: CHAT_URL,
  port: harnessPort,
  status: lastStatus,
  detail: lastDetail,
  activeTab,
  ...lastExtra,
}))

ipcMain.handle('desk:switch-tab', (_e, name) => {
  switchTab(name)
})

ipcMain.handle('desk:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url)
})

ipcMain.handle('desk:restart-harness', async () => {
  if (harnessOwned) {
    stopOwnHarness()
    await new Promise((r) => setTimeout(r, 800))
  }
  await ensureHarness()
  return { port: harnessPort }
})

ipcMain.handle('desk:copy-text', (_e, text) => {
  if (typeof text === 'string' && text.length < 2000) clipboard.writeText(text)
})

ipcMain.handle('desk:get-log', () => logTail.slice(-40).join('\n'))

// ---------- 菜单 ----------

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about', label: '关于 DeepSeek Desktop' },
            { type: 'separator' },
            { role: 'quit', label: '退出 DeepSeek Desktop' },
          ],
        }]
      : []),
    {
      label: '标签页',
      submenu: [
        { label: 'DeepSeek 对话', accelerator: 'CmdOrCtrl+1', click: () => switchTab('chat') },
        { label: 'Harness', accelerator: 'CmdOrCtrl+2', click: () => switchTab('harness') },
      ],
    },
    {
      label: '查看',
      submenu: [
        { label: '重新载入当前标签页', accelerator: 'CmdOrCtrl+R', click: () => activeView()?.webContents.reload() },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front', label: '前置全部窗口' }] : []),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------- 生命周期 ----------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    buildMenu()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    stopOwnHarness()
  })
}
