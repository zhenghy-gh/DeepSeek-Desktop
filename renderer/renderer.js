'use strict'

const $ = (id) => document.getElementById(id)

const state = {
  activeTab: 'chat',
  harnessStatus: 'connecting',
}

// ---------- 标签页切换（视图由主进程 WebContentsView 承载） ----------

function setActiveTab(name) {
  state.activeTab = name
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name)
  })
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => window.deskAPI.switchTab(tab.dataset.tab))
})

window.deskAPI.onTabChanged((name) => setActiveTab(name))

// ---------- Harness 状态 ----------

function setStatus(status, detail, extra = {}) {
  state.harnessStatus = status
  const dot = $('statusDot')
  dot.className = 'dot'
  if (status === 'running') {
    dot.classList.add('running')
  } else if (status === 'error') {
    dot.classList.add('error')
  } else {
    dot.classList.add('connecting')
  }
  $('statusText').textContent = detail || status
  // 错误时显示工具栏里的「重新启动」入口（该按钮在工具栏内，永不被 WebContentsView 遮挡）
  const topRestart = $('btnRestartTop')
  if (topRestart) {
    if (status === 'error') topRestart.classList.remove('hidden')
    else topRestart.classList.add('hidden')
  }
  const overlay = $('harness-overlay')
  if (status === 'error') {
    overlay.classList.remove('hidden')
    $('overlay-detail').textContent = detail || '未知错误'
    // 展示 dsh 的真实错误（stderr 末尾），便于定位启动失败原因
    const errEl = $('overlay-dsherr')
    if (extra.dshErr) {
      errEl.textContent = extra.dshErr
      errEl.classList.remove('hidden')
    } else {
      errEl.classList.add('hidden')
    }
    // 未安装 dsh → 展示安装命令
    const box = $('install-box')
    if (extra.noDsh && extra.installCmd) {
      box.classList.remove('hidden')
      $('install-cmd-text').textContent = extra.installCmd
      $('install-hint-extra').textContent = extra.installHint || ''
    } else {
      box.classList.add('hidden')
    }
  } else {
    overlay.classList.add('hidden')
  }
}

window.deskAPI.onStatus(({ status, detail, noDsh, installCmd, installHint, dshErr }) => {
  setStatus(status, detail, { noDsh, installCmd, installHint, dshErr })
})

// ---------- 工具栏按钮 ----------

// 统一的重启逻辑：两个入口（浮层按钮 / 工具栏按钮）共用，确保一定能触发
async function doRestart() {
  setStatus('connecting', '正在重新启动 Harness…')
  await window.deskAPI.restartHarness()
}

$('btn-retry').addEventListener('click', async () => {
  $('btn-retry').disabled = true
  await doRestart()
  $('btn-retry').disabled = false
})

$('btnRestartTop').addEventListener('click', async () => {
  $('btnRestartTop').disabled = true
  await doRestart()
  $('btnRestartTop').disabled = false
})

const logModal = $('logModal')
const logBody = $('logBody')

function openLogModal(text) {
  logBody.textContent = text || '（无日志）'
  logModal.classList.remove('hidden')
}

function closeLogModal() {
  logModal.classList.add('hidden')
}

$('btn-log').addEventListener('click', async () => {
  const tail = await window.deskAPI.getLog()
  console.log('[DeepSeek Desktop log]', tail)
  openLogModal(tail)
})

$('logClose').addEventListener('click', closeLogModal)
logModal.addEventListener('click', (e) => {
  if (e.target && e.target.dataset && e.target.dataset.close) closeLogModal()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !logModal.classList.contains('hidden')) closeLogModal()
})
$('logCopy').addEventListener('click', async () => {
  const text = logBody.textContent
  if (!text) return
  await window.deskAPI.copyText(text)
  const btn = $('logCopy')
  const prev = btn.textContent
  btn.textContent = '已复制 ✓'
  setTimeout(() => {
    btn.textContent = prev
  }, 1500)
})

$('btn-copy').addEventListener('click', async () => {
  const cmd = $('install-cmd-text').textContent
  if (!cmd) return
  await window.deskAPI.copyText(cmd)
  const btn = $('btn-copy')
  const prev = btn.textContent
  btn.textContent = '已复制 ✓'
  setTimeout(() => {
    btn.textContent = prev
  }, 1500)
})

// ---------- 版本更新 ----------

const updateState = { state: 'idle' }

function renderUpdate(s) {
  updateState.state = s.state
  const box = $('updateBox')
  const btn = $('updateBtn')
  const v = (s.version || '').replace(/^v/, '')
  switch (s.state) {
    case 'checking':
      // 重试/手动检查时保持框可见，避免框子闪没被误判为「点了没反应」
      box.classList.remove('hidden')
      btn.textContent = '正在检查更新…'
      btn.title = ''
      btn.classList.add('warn')
      break
    case 'available':
      box.classList.remove('hidden')
      btn.textContent = `发现新版本 v${v}`
      btn.title = ''
      btn.classList.add('warn')
      break
    case 'downloading':
      box.classList.remove('hidden')
      btn.textContent = `正在下载更新 ${s.progress || 0}%`
      btn.title = ''
      btn.classList.add('warn')
      break
    case 'downloaded':
      box.classList.remove('hidden')
      btn.textContent = '🔄 重启更新'
      btn.title = ''
      btn.classList.remove('warn')
      break
    case 'error':
      box.classList.remove('hidden')
      btn.textContent = s.error ? '更新失败，点击重试' : '更新失败'
      btn.title = s.error ? `失败原因：${s.error}` : ''
      btn.classList.add('warn')
      break
    default:
      box.classList.add('hidden')
  }
}

$('updateBtn').addEventListener('click', () => {
  switch (updateState.state) {
    case 'downloaded':
      window.deskAPI.updateInstall()
      break
    case 'error':
      // 失败多发生在「检查」阶段（如网络问题），此时 latest 为空，
      // 必须重新 check() 而非 download()，否则 download() 会因 latest 为空直接 return
      window.deskAPI.updateCheck()
      break
    case 'available':
      window.deskAPI.updateDownload()
      break
    default:
      break // downloading 中忽略点击
  }
})

window.deskAPI.onUpdateStatus((s) => renderUpdate(s))

// ---------- 初始化 ----------

window.deskAPI.getState().then((s) => {
  if (s.status && s.status !== 'connecting') setStatus(s.status, s.detail, s)
  if (s.activeTab) setActiveTab(s.activeTab)
})