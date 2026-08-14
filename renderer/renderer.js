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
  const overlay = $('harness-overlay')
  if (status === 'error') {
    overlay.classList.remove('hidden')
    $('overlay-detail').textContent = detail || '未知错误'
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

window.deskAPI.onStatus(({ status, detail, noDsh, installCmd, installHint }) => {
  setStatus(status, detail, { noDsh, installCmd, installHint })
})

// ---------- 工具栏按钮 ----------

$('btn-retry').addEventListener('click', async () => {
  $('btn-retry').disabled = true
  setStatus('connecting', '正在重新启动 Harness…')
  await window.deskAPI.restartHarness()
  $('btn-retry').disabled = false
})

$('btn-log').addEventListener('click', async () => {
  const tail = await window.deskAPI.getLog()
  console.log('[DeepSeek Desktop log]', tail)
  alert(tail || '（无日志）')
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
    case 'available':
      box.classList.remove('hidden')
      btn.textContent = `发现新版本 v${v}`
      btn.classList.add('warn')
      break
    case 'downloading':
      box.classList.remove('hidden')
      btn.textContent = `正在下载更新 ${s.progress || 0}%`
      btn.classList.add('warn')
      break
    case 'downloaded':
      box.classList.remove('hidden')
      btn.textContent = '🔄 重启更新'
      btn.classList.remove('warn')
      break
    case 'error':
      box.classList.remove('hidden')
      btn.textContent = s.error ? '更新失败，点击重试' : '更新失败'
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