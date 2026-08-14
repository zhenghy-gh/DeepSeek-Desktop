#!/usr/bin/env node
/**
 * electron-builder afterPack 钩子：
 *  1. 把 dsh-runtime 复制进打包后的应用
 *  2. macOS：对 bundle 做 ad-hoc 重签
 *     —— electron-builder 修改 Info.plist/资源后，Electron 自带签名的
 *        资源封印会失效，导致「应用已损坏或不完整」；重签后签名与内容一致。
 */
import { execFileSync } from 'node:child_process'
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

/**
 * 重写 node_modules/.bin 里的绝对路径符号链接为相对链接。
 * electron-builder 的 rebuild 步骤会把链接重建为绝对路径，
 * 打包后目标不存在会破坏签名校验（invalid destination for symbolic link）。
 */
function rewriteBinLinks(root) {
  const binDir = path.join(root, 'node_modules', '.bin')
  if (!fs.existsSync(binDir)) return 0
  let rewritten = 0
  for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue
    const link = path.join(binDir, entry.name)
    let target
    try {
      target = fs.readlinkSync(link)
    } catch { /* ignore */ }
    if (!target || !path.isAbsolute(target)) continue
    const norm = path.normalize(target)
    const idx = norm.indexOf(`${path.sep}node_modules${path.sep}`)
    if (idx === -1) continue
    const pkgRel = norm.slice(idx + 'node_modules/'.length)
    fs.rmSync(link, { force: true })
    fs.symlinkSync(path.join('..', pkgRel), link)
    rewritten++
  }
  return rewritten
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
  // 包内 .bin 链接相对化（rebuild 步骤会重建为绝对路径，必须最后再重写一次）
  const rewritten = rewriteBinLinks(dest)
  console.log(`afterPack: 已复制 dsh-runtime（${mb} MB，重写链接 ${rewritten} 个）→ ${dest}`)

  // macOS：ad-hoc 重签，修复「已损坏或不完整」
  if (electronPlatformName === 'darwin') {
    const appBundle =
      appOutDir.endsWith('.app')
        ? appOutDir
        : path.join(appOutDir, fs.readdirSync(appOutDir).find((e) => e.endsWith('.app')))
    try {
      // --deep：递归重签 bundle 内所有组件（x64 交叉构建时部分 Helper 未签名）
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appBundle], {
        stdio: 'inherit',
      })
      console.log(`afterPack: ad-hoc 重签完成 → ${appBundle}`)
    } catch (e) {
      console.warn(`afterPack: 重签失败（继续构建）: ${String(e.message).slice(0, 200)}`)
    }
  }
}
