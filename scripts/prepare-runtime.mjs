#!/usr/bin/env node
/**
 * 将 dsh 运行时（@deepseek-ai/dsh 及其依赖）准备到 dsh-runtime/，
 * 供 electron-builder 作为 extraResources 打包进应用。
 *
 * 来源解析顺序：
 *   1. $DSH_DESKTOP_DSH 环境变量（显式指定）
 *   2. PATH 中的 dsh
 *   3. ~/.npm/_npx/<hash>/node_modules/.bin/dsh（取最新的）
 *   4. 临时目录 npm install @deepseek-ai/dsh（CI 等无本机 dsh 的环境）
 *
 * 复制后做轻量裁剪：*.map、*.md/README/CHANGELOG/LICENSE、
 * node-pty 非当前平台预编译、sharp-wasm32。
 */
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const destRoot = path.join(projectRoot, 'dsh-runtime')

const platformDir = `${process.platform}-${process.arch}` // darwin-arm64 / win32-x64 / linux-x64 ...

function findDshBin() {
  if (process.env.DSH_DESKTOP_DSH && fs.existsSync(process.env.DSH_DESKTOP_DSH)) {
    return process.env.DSH_DESKTOP_DSH
  }
  try {
    const p = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
    if (p) return p
  } catch { /* not on PATH */ }
  const npxDir = path.join(os.homedir(), '.npm', '_npx')
  if (fs.existsSync(npxDir)) {
    let best = null
    let bestTime = 0
    for (const entry of fs.readdirSync(npxDir)) {
      const p = path.join(npxDir, entry, 'node_modules', '.bin', 'dsh')
      try {
        const st = fs.statSync(p)
        if (st.mtimeMs > bestTime) {
          bestTime = st.mtimeMs
          best = p
        }
      } catch { /* ignore */ }
    }
    if (best) return best
  }
  return null
}

function readDshVersion(srcRoot) {
  try {
    const p = path.join(srcRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    return JSON.parse(fs.readFileSync(p, 'utf8')).version
  } catch {
    return null
  }
}

/** CI 等没有本机 dsh 的环境：临时 npm install 一个 */
function installFresh(versionHint) {
  const tmpRoot = path.join(projectRoot, '.runtime-install')
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  fs.mkdirSync(tmpRoot, { recursive: true })
  const spec = versionHint ? `@deepseek-ai/dsh@${versionHint}` : '@deepseek-ai/dsh'
  console.log(`本机未找到 dsh，临时安装 ${spec} …`)
  execSync(`npm install --no-audit --no-fund --prefix "${tmpRoot}" "${spec}"`, {
    stdio: 'inherit',
  })
  const bin = path.join(tmpRoot, 'node_modules', '.bin', 'dsh')
  if (!fs.existsSync(bin)) {
    console.error('npm 安装 dsh 失败')
    process.exit(1)
  }
  return fs.realpathSync(bin)
}

function *walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) yield * walk(p)
    else yield p
  }
}

function dirSize(root) {
  let total = 0
  for (const p of walk(root)) {
    try {
      total += fs.statSync(p).size
    } catch { /* ignore */ }
  }
  return total
}

function prune(root) {
  let removed = 0
  let removedBytes = 0
  for (const p of walk(root)) {
    const base = path.basename(p)
    const rel = path.relative(root, p)
    const remove =
      base.endsWith('.map') ||
      /\.(md|markdown)$/i.test(base) ||
      /^(readme|changelog|history|notice|authors|copying|license)(\.|$)/i.test(base) ||
      /^node_modules[/\\]@img[/\\]sharp-wasm32($|[/\\])/.test(rel) ||
      new RegExp(
        `^node_modules[/\\\\]node-pty[/\\\\]prebuilds[/\\\\](?!${platformDir}($|[/\\\\]))`
      ).test(rel)
    if (remove) {
      try {
        const st = fs.statSync(p)
        removedBytes += st.size
        fs.rmSync(p, { recursive: true, force: true })
        removed++
      } catch { /* ignore */ }
    }
  }
  return { removed, removedBytes }
}

let bin = findDshBin()
let srcRoot = null
if (bin) {
  const realBin = fs.realpathSync(bin) // .../node_modules/@deepseek-ai/dsh/lib/bin.js
  srcRoot = path.resolve(realBin, '..', '..', '..', '..', '..') // 回到安装根
  if (!fs.existsSync(path.join(srcRoot, 'node_modules'))) srcRoot = null
}
if (!srcRoot) {
  const versionHint = bin ? readDshVersion(path.resolve(bin, '..', '..')) : null
  bin = installFresh(versionHint)
  const realBin = fs.realpathSync(bin)
  srcRoot = path.resolve(realBin, '..', '..', '..', '..', '..')
}

console.log(`来源: ${srcRoot}`)
console.log(`目标: ${destRoot}`)
fs.rmSync(destRoot, { recursive: true, force: true })
fs.mkdirSync(destRoot, { recursive: true })
fs.cpSync(srcRoot, destRoot, { recursive: true })

const { removed, removedBytes } = prune(destRoot)
console.log(`裁剪: ${removed} 个文件，约 ${(removedBytes / 1024 / 1024).toFixed(1)} MB`)

const sizeMb = (dirSize(destRoot) / 1024 / 1024).toFixed(0)
console.log(`dsh-runtime 最终大小: ${sizeMb} MB（解压后，${platformDir}）`)
fs.rmSync(path.join(projectRoot, '.runtime-install'), { recursive: true, force: true })
console.log('完成 ✅')
