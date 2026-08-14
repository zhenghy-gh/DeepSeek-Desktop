#!/usr/bin/env node
/**
 * 生成 1024x1024 应用图标（纯 Node 实现，无外部依赖）：
 * 深蓝渐变圆角方块 + 白色对话气泡 + 蓝色闪电。
 * 输出 assets/icon-master.png，再由 make-icns.sh 转成 .icns。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const assetsDir = path.join(__dirname, '..', 'assets')

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
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ---------- 绘制 ----------

// SDF：圆角矩形距离
function roundedRectDist(x, y, cx, cy, halfW, halfH, r) {
  const dx = Math.max(Math.abs(x - cx) - (halfW - r), 0)
  const dy = Math.max(Math.abs(y - cy) - (halfH - r), 0)
  return Math.hypot(dx, dy) - r
}

// 点在多边形内（射线法）
function inPolygon(x, y, pts) {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// 颜色混合
function lerp(a, b, t) {
  return a + (b - a) * t
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)

  // 闪电多边形（相对气泡坐标）
  const bolt = [
    [0.36, 0.30], [0.62, 0.30], [0.50, 0.47], [0.66, 0.47],
    [0.34, 0.78], [0.44, 0.56], [0.28, 0.56],
  ]

  for (let y = 0; y < size; y++) {
    const ny = y / size
    for (let x = 0; x < size; x++) {
      const nx = x / size
      const i = (y * size + x) * 4
      let r = 0, g = 0, b = 0, a = 0

      // 背景：圆角方块 + 对角渐变
      const d = roundedRectDist(x + 0.5, y + 0.5, size / 2, size / 2, size * 0.5 - 8, size * 0.5 - 8, 232 * (size / 1024))
      if (d < 0) {
        const t = (nx + ny) / 2
        r = lerp(0x4d, 0x0b, t)
        g = lerp(0x6b, 0x1e, t)
        b = lerp(0xfe, 0x4d, t)
        a = 1
        // 顶部高光
        const glow = Math.max(0, 1 - ny * 3.2)
        r = lerp(r, 0x6f, glow * 0.35)
        g = lerp(g, 0x8b, glow * 0.35)
        b = lerp(b, 0xff, glow * 0.35)
      }

      // 气泡（白色圆角矩形 + 小尾巴）
      if (a > 0) {
        const bd = roundedRectDist(x + 0.5, y + 0.5, size / 2, size / 2 - 18 * (size / 1024), 268 * (size / 1024), 216 * (size / 1024), 84 * (size / 1024))
        const tail = inPolygon(x + 0.5, y + 0.5, [
          [size / 2 - 110 * (size / 1024), size / 2 + 172 * (size / 1024)],
          [size / 2 - 18 * (size / 1024), size / 2 + 172 * (size / 1024)],
          [size / 2 - 118 * (size / 1024), size / 2 + 262 * (size / 1024)],
        ])
        if (bd < 0 || tail) {
          r = 0xf5; g = 0xf7; b = 0xfb
        } else {
          // 气泡内部：闪电
          const bx0 = size / 2 - 196 * (size / 1024)
          const by0 = size / 2 - 220 * (size / 1024)
          const pts = bolt.map(([px, py]) => [bx0 + px * 392 * (size / 1024), by0 + py * 300 * (size / 1024)])
          if (inPolygon(x + 0.5, y + 0.5, pts)) {
            r = 0x4d; g = 0x6b; b = 0xfe
          }
        }
      }

      rgba[i] = Math.round(r)
      rgba[i + 1] = Math.round(g)
      rgba[i + 2] = Math.round(b)
      rgba[i + 3] = Math.round(a * 255)
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
