#!/usr/bin/env node
/**
 * 生成 1024x1024 应用图标（纯 Node 实现，无外部依赖）：
 *  - 满幅对角渐变背景（macOS 自动圆角，无需透明底）
 *  - 中央白色 DeepSeek 鲸鱼（直接从官方 chat.svg 提取矢量 path 光栅化）
 *  - 顶部高光 + 气泡装饰
 * 输出 assets/icon-master.png 和 assets/icon-512.png，再由 make-icns.sh 转 icns。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const assetsDir = path.join(__dirname, '..', 'assets')
const whaleSvg = path.join(__dirname, '..', 'renderer', 'icons', 'chat.svg')

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ---------- SVG path 解析与光栅化 ----------

function parsePath(d) {
  const tokens = d.match(/[MmLlCcHhVvZz]|-?\d*\.?\d+(?:[eE][+-]?\d+)?/g) || []
  const commands = []
  let i = 0
  let last = null
  while (i < tokens.length) {
    let cmd = tokens[i]
    if (!/[A-Za-z]/.test(cmd)) {
      if (!last) break
      cmd = last // 隐式重复命令
    } else {
      i++
    }
    if (!/[A-Za-z]/.test(cmd)) break
    const params = []
    while (i < tokens.length && !/[A-Za-z]/.test(tokens[i])) {
      params.push(parseFloat(tokens[i++]))
    }
    commands.push({ cmd, params })
    if (cmd !== 'z' && cmd !== 'Z') last = cmd
  }
  return commands
}

/** 解析为折线子路径列表（每段 = [x,y] 点数组，闭合） */
function pathToPolylines(commands, flat = 0.12) {
  const polylines = []
  let current = []
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  const rel = (cmd) => cmd === cmd.toLowerCase() && cmd !== 'z' && cmd !== 'Z'

  const emitPoint = (x, y) => {
    current.push([x, y])
    cx = x
    cy = y
  }

  const subdivide = (p0, c1, c2, p1) => {
    // 三次贝塞尔自适应细分（平坦阈值 flat，50 单位 viewBox）
    const d1 = Math.hypot(c1[0] - p0[0], c1[1] - p0[1])
    const d2 = Math.hypot(c2[0] - p1[0], c2[1] - p1[1])
    const d3 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
    if (d1 + d2 + d3 < flat || current.length > 40000) {
      emitPoint(p1[0], p1[1])
      return
    }
    const m = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const p01 = m(p0, c1)
    const p12 = m(c1, c2)
    const p23 = m(c2, p1)
    const p012 = m(p01, p12)
    const p123 = m(p12, p23)
    const p0123 = m(p012, p123)
    subdivide(p0, p01, p012, p0123)
    subdivide(p0123, p123, p23, p1)
  }

  for (const { cmd, params } of commands) {
    const r = rel(cmd)
    const u = cmd.toUpperCase()
    if (u === 'M') {
      if (current.length) polylines.push(current)
      current = []
      sx = r ? cx + params[0] : params[0]
      sy = r ? cy + params[1] : params[1]
      emitPoint(sx, sy)
    } else if (u === 'C') {
      const p0 = [cx, cy]
      const c1 = [r ? cx + params[0] : params[0], r ? cy + params[1] : params[1]]
      const c2 = [r ? cx + params[2] : params[2], r ? cy + params[3] : params[3]]
      const p1 = [r ? cx + params[4] : params[4], r ? cy + params[5] : params[5]]
      subdivide(p0, c1, c2, p1)
    } else if (u === 'L') {
      emitPoint(r ? cx + params[0] : params[0], r ? cy + params[1] : params[1])
    } else if (u === 'H') {
      emitPoint(r ? cx + params[0] : params[0], cy)
    } else if (u === 'V') {
      emitPoint(cx, r ? cy + params[0] : params[0])
    } else if (u === 'Z') {
      if (current.length) {
        current.push([sx, sy])
        polylines.push(current)
        current = []
      }
      cx = sx
      cy = sy
    }
  }
  if (current.length) polylines.push(current)
  return polylines.filter((p) => p.length >= 2)
}

/** 扫描线 even-odd 填充折线集 → 填充区间 [y, x0, x1] 列表 */
function scanFill(polylines, size, scale, ox, oy) {
  const edges = []
  for (const poly of polylines) {
    for (let i = 0; i < poly.length - 1; i++) {
      const [ax, ay] = poly[i]
      const [bx, by] = poly[i + 1]
      edges.push([ax * scale + ox, ay * scale + oy, bx * scale + ox, by * scale + oy])
    }
  }
  const spans = []
  for (let y = 0; y < size; y++) {
    const yf = y + 0.5
    const xs = []
    for (const [x0, y0, x1, y1] of edges) {
      if (y0 === y1) continue
      if ((y0 <= yf && yf < y1) || (y1 <= yf && yf < y0)) {
        xs.push(x0 + ((yf - y0) * (x1 - x0)) / (y1 - y0))
      }
    }
    xs.sort((a, b) => a - b)
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const a = Math.max(0, Math.round(xs[i]))
      const b = Math.min(size - 1, Math.round(xs[i + 1]))
      if (a <= b) spans.push([y, a, b])
    }
  }
  return spans
}

// ---------- 图标绘制 ----------

function lerp(a, b, t) {
  return a + (b - a) * t
}

// 圆角矩形 SDF（macOS Big Sur 标准圆角比例 22.4%）
function roundedRectDist(x, y, cx, cy, halfW, halfH, r) {
  const dx = Math.max(Math.abs(x - cx) - (halfW - r), 0)
  const dy = Math.max(Math.abs(y - cy) - (halfH - r), 0)
  return Math.hypot(dx, dy) - r
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const r = size * 0.224 // 圆角半径

  // 圆角渐变背景（圆角外透明）+ 顶部高光
  for (let y = 0; y < size; y++) {
    const ny = y / size
    for (let x = 0; x < size; x++) {
      const nx = x / size
      const i = (y * size + x) * 4
      const d = roundedRectDist(x + 0.5, y + 0.5, size / 2, size / 2, size / 2, size / 2, r)
      if (d >= 0) continue // 圆角外透明
      const t = nx * 0.55 + ny * 0.45
      let rr = lerp(0x5b, 0x14, t)
      let g = lerp(0x7c, 0x27, t)
      let b = lerp(0xff, 0x5e, t)
      // 顶部高光（柔和）
      const glow = Math.max(0, 1 - ny * 3.6)
      rr = lerp(rr, 0x8a, glow * 0.45)
      g = lerp(g, 0xab, glow * 0.45)
      b = lerp(b, 0xff, glow * 0.45)
      rgba[i] = Math.round(rr)
      rgba[i + 1] = Math.round(g)
      rgba[i + 2] = Math.round(b)
      rgba[i + 3] = 255
    }
  }

  // 边缘内阴影（让圆角更有质感）：距离圆角边 0-10px 渐暗
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      if (rgba[i + 3] === 0) continue
      const d = roundedRectDist(x + 0.5, y + 0.5, size / 2, size / 2, size / 2, size / 2, r)
      if (d > -12) {
        const a = Math.max(0, (-d) / 12) // 0 边缘 → 1 内部
        const shade = 1 - (1 - a) * 0.35
        rgba[i] = Math.round(rgba[i] * shade)
        rgba[i + 1] = Math.round(rgba[i + 1] * shade)
        rgba[i + 2] = Math.round(rgba[i + 2] * shade)
      }
    }
  }

  // 中央白色鲸鱼
  const svg = fs.readFileSync(whaleSvg, 'utf8')
  const d = svg.match(/\bd="([^"]+)"/)?.[1]
  if (!d) throw new Error('无法从 chat.svg 提取鲸鱼 path')
  const commands = parsePath(d)
  const polylines = pathToPolylines(commands)
  const scale = (size * 0.74) / 50
  const ox = (size - 50 * scale) / 2
  const oy = (size - 50 * scale) / 2 - size * 0.02
  const spans = scanFill(polylines, size, scale, ox, oy)
  for (const [y, a, b] of spans) {
    for (let x = a; x <= b; x++) {
      const i = (y * size + x) * 4
      rgba[i] = 0xff
      rgba[i + 1] = 0xff
      rgba[i + 2] = 0xff
      rgba[i + 3] = 255
    }
  }

  return rgba
}

// 2x2 平均降采样
function downscale2x(src, srcSize) {
  const dstSize = srcSize / 2
  const dst = Buffer.alloc(dstSize * dstSize * 4)
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      const o = (y * dstSize + x) * 4
      for (let c = 0; c < 4; c++) {
        let sum = 0
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const s = ((y * 2 + dy) * srcSize + x * 2 + dx) * 4 + c
            sum += src[s]
          }
        dst[o + c] = Math.round(sum / 4)
      }
    }
  }
  return dst
}

fs.mkdirSync(assetsDir, { recursive: true })

const master = drawIcon(1024)
fs.writeFileSync(path.join(assetsDir, 'icon-master.png'), encodePNG(1024, master))
const half = downscale2x(master, 1024)
fs.writeFileSync(path.join(assetsDir, 'icon-512.png'), encodePNG(512, half))
console.log(`已生成 ${path.join(assetsDir, 'icon-master.png')} 和 ${path.join(assetsDir, 'icon-512.png')}`)
