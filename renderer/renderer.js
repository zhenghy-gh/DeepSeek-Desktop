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

window.deskAPI.onStatus(({ status, detail }) => {
  setStatus(status, detail)
})

// ---------- 工具栏按钮 ----------

$('openBrowser').addEventListener('click', () => {
  const url = state.activeTab === 'harness'
    ? 'http://127.0.0.1:3080'
    : 'https://chat.deepseek.com'
  window.deskAPI.openExternal(url)
})

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

// ---------- 初始化 ----------

window.deskAPI.getState().then((s) => {
  if (s.status && s.status !== 'connecting') setStatus(s.status, s.detail)
  if (s.activeTab) setActiveTab(s.activeTab)
})
