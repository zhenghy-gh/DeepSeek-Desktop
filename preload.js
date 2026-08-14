'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('deskAPI', {
  getState: () => ipcRenderer.invoke('desk:get-state'),
  switchTab: (name) => ipcRenderer.invoke('desk:switch-tab', name),
  openExternal: (url) => ipcRenderer.invoke('desk:open-external', url),
  restartHarness: () => ipcRenderer.invoke('desk:restart-harness'),
  copyText: (text) => ipcRenderer.invoke('desk:copy-text', text),
  getLog: () => ipcRenderer.invoke('desk:get-log'),
  onStatus: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('harness-status', h)
    return () => ipcRenderer.removeListener('harness-status', h)
  },
  onTabChanged: (cb) => {
    const h = (_e, name) => cb(name)
    ipcRenderer.on('tab-changed', h)
    return () => ipcRenderer.removeListener('tab-changed', h)
  },
  updateCheck: () => ipcRenderer.invoke('desk:update-check'),
  updateDownload: () => ipcRenderer.invoke('desk:update-download'),
  updateInstall: () => ipcRenderer.invoke('desk:update-install'),
  onUpdateStatus: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('update-status', h)
    return () => ipcRenderer.removeListener('update-status', h)
  },
})
