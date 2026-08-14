'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('deskAPI', {
  getState: () => ipcRenderer.invoke('desk:get-state'),
  openExternal: (url) => ipcRenderer.invoke('desk:open-external', url),
  restartHarness: () => ipcRenderer.invoke('desk:restart-harness'),
  getLog: () => ipcRenderer.invoke('desk:get-log'),
  onStatus: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('harness-status', h)
    return () => ipcRenderer.removeListener('harness-status', h)
  },
  onShortcut: (cb) => {
    const h = (_e, name) => cb(name)
    ipcRenderer.on('shortcut', h)
    return () => ipcRenderer.removeListener('shortcut', h)
  },
})
