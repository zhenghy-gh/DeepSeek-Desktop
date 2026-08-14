'use strict'

const $ = (id) => document.getElementById(id)

const state = {
  activeTab: 'chat',
  harnessPort: 3080,
  harnessUrl: null,
  harnessStatus: 'connecting',
  harnessViewLoaded: false,
}

const viewChat = $('view-chat')
const viewHarness = $('view-harness')

// ---------- 标签页切换 ----------

// Electron 的 <webview> 对 flex/百分比布局支持不完整，必须显式同步像素尺寸
function syncViewSize(view) {
  const wrap = view.parentElement
  if (!wrap || wrap.classList.contains('hidden')) return
  const w = wrap.clientWidth
  const h = wrap.clientHeight
  if (w > 0 && h > 0 && (view.style.width !== w + 'px' || view.style.height !== h + 'px')) {
    view.style.width = w + 'px'
    view.style.height = h + 'px'
  }
}

function syncAllViews() {
  syncViewSize(viewChat)
  syncViewSize(viewHarness)
}

function switchTab(name) {
  state.activeTab = name
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name)
  })
  $('wrap-chat').classList.toggle('hidden', name !== 'chat')
  $('wrap-harness').classList.toggle('hidden', name !== 'harness')
  requestAnimationFrame(syncAllViews)
}

// 窗口尺寸变化时同步
window.addEventListener('resize', () => requestAnimationFrame(syncAllViews))

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab))
})

// ---------- Harness 状态 ----------

function setStatus(status, detail) {
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
  } else {
    overlay.classList.add('hidden')
  }
}

window.deskAPI.onStatus(({ status, detail, port }) => {
  if (status === 'running' && port) {
    state.harnessPort = port
    if (!state.harnessUrl) {
      state.harnessUrl = `http://127.0.0.1:${port}`
      viewHarness.src = state.harnessUrl
    }
  }
  setStatus(status, detail)
})

// ---------- webview 事件 ----------

function attachWebview(view, isHarness) {
  view.addEventListener('new-window', (e) => {
    if (e.url) window.deskAPI.openExternal(e.url)
  })
  view.addEventListener('dom-ready', () => requestAnimationFrame(() => syncViewSize(view)))
  view.addEventListener('did-finish-load', () => requestAnimationFrame(() => syncViewSize(view)))
  view.addEventListener('did-fail-load', (e) => {
    if (isHarness && e.errorCode === -102 && state.harnessStatus === 'running') {
      // 连接被拒：可能是服务刚重启，自动重试
      setTimeout(() => {
        if (state.harnessUrl) view.src = state.harnessUrl
      }, 1500)
    }
  })
}

attachWebview(viewChat, false)
attachWebview(viewHarness, true)

// ---------- 工具栏按钮 ----------

$('openBrowser').addEventListener('click', () => {
  const url = state.activeTab === 'harness' && state.harnessUrl
    ? state.harnessUrl
    : 'https://chat.deepseek.com'
  window.deskAPI.openExternal(url)
})

$('btn-retry').addEventListener('click', async () => {
  $('btn-retry').disabled = true
  setStatus('connecting', '正在重新启动 Harness…')
  const r = await window.deskAPI.restartHarness()
  if (r && r.port) {
    state.harnessPort = r.port
    state.harnessUrl = `http://127.0.0.1:${r.port}`
    viewHarness.src = state.harnessUrl
  }
  $('btn-retry').disabled = false
})

$('btn-log').addEventListener('click', async () => {
  const tail = await window.deskAPI.getLog()
  console.log('[DeepSeek Desktop log]', tail)
  alert(tail || '（无日志）')
})

// ---------- 快捷键 ----------

window.deskAPI.onShortcut((name) => {
  if (name === 'tab-chat') switchTab('chat')
  else if (name === 'tab-harness') switchTab('harness')
  else if (name === 'reload-active') {
    if (state.activeTab === 'harness' && state.harnessUrl) viewHarness.src = state.harnessUrl
    else viewChat.reload()
  }
})

// ---------- 初始化 ----------

window.deskAPI.getState().then((s) => {
  viewChat.src = s.chatUrl
  // 应用状态快照（防止与推送事件竞态）
  if (s.status === 'running' && s.port) {
    state.harnessPort = s.port
    state.harnessUrl = `http://127.0.0.1:${s.port}`
    viewHarness.src = state.harnessUrl
    setStatus(s.status, s.detail)
  } else if (s.status && s.status !== 'connecting') {
    setStatus(s.status, s.detail)
  }
  requestAnimationFrame(syncAllViews)
  setTimeout(syncAllViews, 500)
})
