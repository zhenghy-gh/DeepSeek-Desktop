#!/usr/bin/env node
/**
 * electron-builder afterPack 钩子：把 dsh-runtime 复制进打包后的应用。
 * （extraResources 的 FileMatcher 会默认排除 node_modules，所以不用它）
 */
import fs from 'node:fs'
import path from 'node:path'

function dirSize(root) {
  let total = 0
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name)
    if (entry.isDirectory()) total += dirSize(p)
    else {
      try {
        total += fs.statSync(p).size
      } catch { /* ignore */ }
    }
  }
  return total
}

export default async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context
  const src = path.join(packager.projectDir, 'dsh-runtime')
  if (!fs.existsSync(src)) {
    console.warn('afterPack: 未找到 dsh-runtime，跳过（先运行 npm run prepare:runtime）')
    return
  }
  // mac 上 appOutDir 是平台目录（dist/mac-arm64），bundle 在其中的 *.app 里；
  // win/linux 上 appOutDir 即解包目录（dist/win-unpacked 等）
  let resourcesDir
  if (electronPlatformName === 'darwin') {
    let bundle = appOutDir.endsWith('.app') ? appOutDir : null
    if (!bundle) {
      const entry = fs.readdirSync(appOutDir).find((e) => e.endsWith('.app'))
      if (entry) bundle = path.join(appOutDir, entry)
    }
    if (!bundle) throw new Error('afterPack: 未找到 .app bundle')
    resourcesDir = path.join(bundle, 'Contents', 'Resources')
  } else {
    resourcesDir = path.join(appOutDir, 'resources')
  }
  const dest = path.join(resourcesDir, 'dsh-runtime')
  fs.rmSync(dest, { recursive: true, force: true })
  fs.cpSync(src, dest, { recursive: true })
  const mb = (dirSize(dest) / 1024 / 1024).toFixed(0)
  console.log(`afterPack: 已复制 dsh-runtime（${mb} MB）→ ${dest}`)
}
