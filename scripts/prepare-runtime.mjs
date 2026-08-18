#!/usr/bin/env node
/**
 * 将 dsh 运行时（@deepseek-ai/dsh 及其依赖）准备到 dsh-runtime/，
 * 供 electron-builder afterPack 钩子打包进应用。
 *
 * 来源解析顺序：
 *   1. $DSH_DESKTOP_DSH 环境变量（显式指定）
 *   2. PATH 中的 dsh
 *   3. ~/.npm/_npx/<hash>/node_modules/.bin/dsh（取最新的）
 *   4. 临时目录 npm install @deepseek-ai/dsh（CI 等无本机 dsh 的环境）
 *
 * 说明：.bin/dsh 在 mac/linux 是符号链接、Windows 是普通文件，
 * 因此不依赖 realpath 深度，改为从入口向上查找包含
 * node_modules/@deepseek-ai/dsh 的安装根目录。
 *
 * 步骤：定位安装根 → 平台化裁剪 → 复制到 dsh-runtime/。
 */
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const destRoot = path.join(projectRoot, 'dsh-runtime')

// 保留哪些平台的原生预编译：默认当前平台；多架构打包时用 DSH_RUNTIME_ARCHES 指定
// 例如 DSH_RUNTIME_ARCHES="darwin-arm64,darwin-x64"（macOS 双架构安装包）
const keepArches = (process.env.DSH_RUNTIME_ARCHES || `${process.platform}-${process.arch}`)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const archPattern = keepArches.map((a) => `${a}($|[/\\\\])`).join('|')

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
  return bin
}

/**
 * 从 dsh 入口向上查找安装根目录（包含 node_modules/@deepseek-ai/dsh 的最深目录）。
 * 兼容符号链接（mac/linux）与普通文件（windows）两种 .bin/dsh。
 */
function findInstallRoot(bin) {
  let dir = path.dirname(fs.realpathSync(bin))
  let found = null
  for (;;) {
    const probe = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    if (fs.existsSync(probe)) found = dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return found
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

/** 裁剪：sourcemap、文档、非当前平台的原生预编译 */
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
      new RegExp(`^node_modules[/\\\\]node-pty[/\\\\]prebuilds[/\\\\](?!(${archPattern}))`).test(rel)
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

/**
 * 重写 node_modules/.bin 里的绝对路径符号链接为相对链接。
 * npx 缓存安装的 bin 链接指向本机绝对路径（如 ~/.npm/_npx/<hash>/...），
 * 打包分发到其他机器后目标不存在、链接失效；相对链接（../pkg/bin/x）随处可用。
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
    // 绝对目标 → 解析出相对 node_modules 的包路径，再转成相对 .bin 的链接
    const norm = path.normalize(target)
    const idx = norm.indexOf(`${path.sep}node_modules${path.sep}`)
    if (idx === -1) continue
    const pkgRel = norm.slice(idx + 'node_modules/'.length)
    const relative = path.join('..', pkgRel)
    fs.rmSync(link, { force: true })
    fs.symlinkSync(relative, link)
    rewritten++
  }
  return rewritten
}

// ---------- 定位来源 ----------

let bin = findDshBin()
let srcRoot = null
if (bin) {
  try {
    srcRoot = findInstallRoot(bin)
  } catch { /* ignore */ }
}
if (!srcRoot) {
  const versionHint = bin ? readDshVersion(path.dirname(bin)) : null
  bin = installFresh(versionHint)
  srcRoot = findInstallRoot(bin)
}
if (!srcRoot || srcRoot === projectRoot) {
  console.error(`无法定位 dsh 安装根目录（srcRoot=${srcRoot}）`)
  process.exit(1)
}

console.log(`来源: ${srcRoot}`)
console.log(`目标: ${destRoot}`)

const destDshPkg = path.join(destRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const srcVer = readDshVersion(srcRoot)
const destVer = readDshVersion(destRoot)
const needRefresh = !fs.existsSync(destDshPkg) || (srcVer && destVer && srcVer !== destVer)
if (needRefresh) {
  console.log('dsh-runtime 缺失或版本不一致，重建中…')
  fs.rmSync(destRoot, { recursive: true, force: true })
  fs.mkdirSync(destRoot, { recursive: true })
  fs.cpSync(srcRoot, destRoot, { recursive: true })
} else {
  console.log(`dsh-runtime 已存在且版本一致（${destVer}），跳过重建`)
}

if (!fs.existsSync(path.join(destRoot, 'node_modules', '@deepseek-ai', 'dsh'))) {
  console.error('复制后校验失败：dsh-runtime 缺少 @deepseek-ai/dsh')
  process.exit(1)
}

// 只裁剪副本，绝不修改用户本机的 dsh 安装
const { removed, removedBytes } = prune(destRoot)
console.log(`裁剪: ${removed} 个文件，约 ${(removedBytes / 1024 / 1024).toFixed(1)} MB`)

// 重写 .bin 绝对链接为相对链接（跨机器可用）
const rewritten = rewriteBinLinks(destRoot)
if (rewritten > 0) console.log(`重写 .bin 符号链接: ${rewritten} 个（绝对路径 → 相对路径）`)

const sizeMb = (dirSize(destRoot) / 1024 / 1024).toFixed(0)
console.log(`dsh-runtime 最终大小: ${sizeMb} MB（解压后，保留架构: ${keepArches.join(', ')}）`)
fs.rmSync(path.join(projectRoot, '.runtime-install'), { recursive: true, force: true })
console.log('完成 ✅')
