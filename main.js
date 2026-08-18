'use strict'

const { app, BrowserWindow, WebContentsView, Menu, ipcMain, shell, clipboard } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { Updater } = require('./updater')

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
let updater = null
let harnessChild = null
let harnessOwned = false // true when we spawned the server ourselves
let harnessPort = 3080
let harnessUrl = null
let lastStatus = 'connecting'
let lastDetail = '正在检查 Harness…'
let lastExtra = {}
let logTail = [] // last lines of dsh output for diagnostics
let dshOutputBuffer = '' // 累积 dsh 的 stdout+stderr，用于把真实启动错误暴露给用户

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

// dsh（dsh-app-boot）在入口顶层 `import { parseEnv } from 'node:util'`，
// 而 util.parseEnv 是 Node 20.12.0 才引入的 API，因此 Harness 只能跑在 ≥ 20.12 的
// Node 上；低于此版本的 node（如 nvm 里的 v16）会启动即崩溃。
const MIN_NODE = [20, 12, 0]

function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] || 0) - (b[i] || 0)
    if (d) return d
  }
  return 0
}

function geVer(a, min) {
  return cmpVer(a, min) >= 0
}

// 探测某个 node 可执行文件的版本号；不是 node / 启动超时等异常返回 null
function nodeVersionAt(p) {
  try {
    const out = execFileSync(p, ['-p', 'process.versions.node'], {
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
      .toString()
      .trim()
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/)
    if (!m) return null
    return [Number(m[1]), Number(m[2]), Number(m[3])]
  } catch {
    return null
  }
}

async function findNode() {
  // 显式覆盖优先：用户指定了 node 就直接信任（不再卡版本门槛，便于调试）
  if (process.env.DSH_DESKTOP_NODE) {
    try {
      if (fs.existsSync(process.env.DSH_DESKTOP_NODE)) return process.env.DSH_DESKTOP_NODE
    } catch { /* ignore */ }
  }
  const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']
  try {
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node')
    if (fs.existsSync(nvmDir)) {
      // 枚举 nvm 实际安装的 node（PATH 中的 "*" 通配不会展开）
      for (const v of fs.readdirSync(nvmDir)) {
        candidates.push(path.join(nvmDir, v, 'bin', 'node'))
      }
    }
  } catch { /* ignore */ }
  let best = null
  let bestVer = null
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) continue
    } catch {
      continue
    }
    const ver = nodeVersionAt(c)
    // 跳过不满足 dsh 最低版本要求的 node（如 v16），避免「启动即崩溃」
    if (!ver || !geVer(ver, MIN_NODE)) continue
    if (!bestVer || cmpVer(ver, bestVer) > 0) {
      best = c
      bestVer = ver
    }
  }
  // 没有任何兼容的系统 node 时返回 null → 调用方回退到 Electron 自带 Node（≥ 20.12）
  return best
}

function findBundledDsh() {
  // 打包后：dsh-runtime 在 app 的 Resources 下；开发模式（electron .）：在项目根目录下
  const roots = [
    path.join(process.resourcesPath, 'dsh-runtime', 'node_modules'),
    path.join(__dirname, 'dsh-runtime', 'node_modules'),
  ]
  for (const root of roots) {
    try {
      // 优先用真实入口文件（不依赖 .bin 符号链接，跨机器可靠）
      const real = path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (fs.existsSync(real)) return real
      const bin = path.join(root, '.bin', 'dsh')
      if (fs.existsSync(bin)) return bin
    } catch { /* ignore */ }
  }
  return null
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

function extendedEnv(preferNodeDir) {
  const extra = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ]
  // 枚举 nvm 实际安装的 node bin 目录，新版本优先；dsh 内部 spawn 的 `node`
  // 也按此顺序解析，避免回落到过旧的 node（如 v16）。
  try {
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node')
    if (fs.existsSync(nvmDir)) {
      const vers = fs.readdirSync(nvmDir).sort((a, b) => {
        const va = a.split('.').map(Number)
        const vb = b.split('.').map(Number)
        for (let i = 0; i < 3; i++) if ((vb[i] || 0) !== (va[i] || 0)) return (vb[i] || 0) - (va[i] || 0)
        return 0
      })
      for (const v of vers) {
        const bin = path.join(nvmDir, v, 'bin')
        try {
          if (fs.statSync(bin).isDirectory()) extra.push(bin)
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  const merged = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
  // 把「选定的 node 所在目录」放到 PATH 最前，确保 dsh 及其子进程用的都是同一个新版本 node
  if (preferNodeDir && !merged.includes(preferNodeDir)) merged.unshift(preferNodeDir)
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

// 等待端口释放（用于重启前确认旧进程已退出，避免误判复用）
async function waitPortFree(port, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = await probePort(port, 600)
    if (!r.alive) return true
    await new Promise((r2) => setTimeout(r2, 300))
  }
  return false
}

function spawnHarness(nodePath, dshScript, port, viaPath = false) {
  dshOutputBuffer = '' // 新一轮启动，清空上次的输出缓冲
  // 把选定 node 的目录插到 PATH 最前，确保 dsh 内部 spawn 的 node 也是同一个新版本
  const nodeDir = nodePath && nodePath !== process.execPath ? path.dirname(nodePath) : null
  const env = extendedEnv(nodeDir)
  // 清理会干扰 dsh 子进程 Node 的环境变量：
  //  - NODE_OPTIONS 可能含仅特定 node 版本支持的 flag（如 --use-system-ca），
  //    透传后 dsh 的 node 一启动就 exit 1 且无任何输出，极难排查。
  //  - 非 Electron 兜底时，必须剥掉 ELECTRON_RUN_AS_NODE，否则会污染系统 node。
  delete env.NODE_OPTIONS
  if (nodePath !== process.execPath) {
    delete env.ELECTRON_RUN_AS_NODE
  }
  const args = nodePath
    ? [dshScript, 'web', '--port', String(port)]
    : ['web', '--port', String(port)]
  // 用 Electron 自身二进制兜底跑 dsh 时，dsh 的 cordis HMR 插件要求 --expose-internals，
  // 否则启动即崩溃（exit 1，无有用输出）。该 flag 必须位于脚本名之前。
  if (nodePath === process.execPath) {
    args.unshift('--expose-internals')
  }
  const bin = nodePath || dshScript
  // 无系统 node 时才用 Electron 自带的 Node 兜底；pty.node 是 N-API，但 Electron-as-node 在加载某些原生依赖时仍可能异常
  if (nodePath === process.execPath) env.ELECTRON_RUN_AS_NODE = '1'
  const commandStr = `${bin} ${args.join(' ')}`
  log(`spawning harness: ${commandStr}`)
  const child = spawn(bin, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const appendOutput = (prefix, d) => {
    const s = String(d).trimEnd()
    log(`[${prefix}] ${s}`)
    dshOutputBuffer += s + '\n'
    if (dshOutputBuffer.length > 4000) dshOutputBuffer = dshOutputBuffer.slice(-4000)
  }
  child.stdout.on('data', (d) => appendOutput('dsh', d))
  child.stderr.on('data', (d) => appendOutput('dsh:err', d))
  child.on('error', (err) => {
    log(`dsh spawn error: ${err.message}`)
    dshOutputBuffer += `[spawn error] ${err.code}: ${err.message}\n`
    // 通过 PATH 调 dsh 但命令不存在（未安装）
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
let harnessGen = 0
async function ensureHarness(force = false) {
  if (ensureRunning && !force) return // 防重入（启动时与切标签时可能并发触发）
  const myGen = ++harnessGen
  ensureRunning = true
  try {
    sendStatus('connecting', '正在检查 Harness…')

    // 重启时跳过「复用已有进程」逻辑，强制拉起新实例，
    // 否则会误连刚被杀死、尚未完全退出的残留进程，导致"点了没反应"
    if (!force) {
      const existing = await findExistingHarness()
      if (existing !== null) {
        harnessPort = existing
        harnessOwned = false
        log(`harness already running on port ${existing}, will reuse it`)
        sendStatus('running', `已连接现有 Harness（端口 ${existing}）`)
        loadHarnessView()
        return
      }
    } else {
      log('force restart: 跳过复用探测，准备拉起新实例')
    }

    const nodePath = (await findNode()) || process.execPath // 兜底：Electron 自带 Node
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
    if (nodePath === process.execPath) {
      // 有内置 dsh 但本机没有 node，Electron-as-node 兜底风险较高，先提示用户安装 node
      log('fallback to electron binary as node')
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
        if (myGen !== harnessGen) { log('ensureHarness superseded by newer call, aborting'); return }
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
    if (myGen !== harnessGen) return
    const dshOutputTail = dshOutputBuffer.trim().split('\n').slice(-8).join('\n').slice(0, 450)
    const pathHead = (extendedEnv().PATH || '').split(path.delimiter).slice(0, 6).join('\n')
    const commandStr = `${nodePath || '(no node)'} ${dshScript || '(no dsh)'} web --port <port>`
    const diagnostics = {
      summary: lastErr || '未知错误',
      nodePath: nodePath || 'not found',
      dshScript: dshScript || 'not found',
      command: commandStr,
      electronAsNode: nodePath === process.execPath,
      pathHead,
      outputTail: dshOutputTail || '(无输出)',
    }
    sendStatus('error', `Harness 启动失败：${lastErr || '未知错误'}`, { diagnostics })
    log('harness start failed, diagnostics:', JSON.stringify(diagnostics))
  } finally {
    if (myGen === harnessGen) ensureRunning = false
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

  // 版本更新检测（启动延迟检查 + 每 6 小时）
  if (!updater) {
    updater = new Updater({
      onStatus: (s) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update-status', s)
        }
      },
    })
    updater.start()
  }
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
  // 彻底停掉我们拉起的 Harness 进程（SIGKILL 确保退出，避免残留进程被误复用）
  if (harnessOwned && harnessChild) {
    log('restart-harness: 杀死已拥有的 Harness 子进程')
    try { harnessChild.kill('SIGKILL') } catch { /* ignore */ }
    harnessChild = null
  }
  harnessOwned = false
  // 等待原端口释放，防止 ensureHarness 探测时误判复用残留进程
  await waitPortFree(harnessPort, 5000).catch(() => {})
  await ensureHarness(true)
  return { port: harnessPort }
})

ipcMain.handle('desk:copy-text', (_e, text) => {
  if (typeof text === 'string' && text.length < 2000) clipboard.writeText(text)
})

ipcMain.handle('desk:get-log', () => logTail.slice(-40).join('\n'))

// ---------- 版本更新 ----------

ipcMain.handle('desk:update-check', () => updater?.check(true))
ipcMain.handle('desk:update-download', () => updater?.download())
ipcMain.handle('desk:update-install', () => updater?.installAndRestart())

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
        { label: '检查更新…', click: () => updater?.check(true) },
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
