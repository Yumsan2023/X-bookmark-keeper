// 无依赖 PNG 图标生成器:原创图标(靛蓝圆角方块 + 白色书签丝带 + 对勾缺口)
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

function crc32(buf) {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x / size, y / size, size)
      const o = y * (size * 4 + 1) + 1 + x * 4
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}
function inRoundRect(u, v, r) {
  const x = Math.min(u, 1 - u), y = Math.min(v, 1 - v)
  if (x >= r || y >= r) return true
  return (r - x) ** 2 + (r - y) ** 2 <= r * r
}
function pixel(u, v) {
  if (!inRoundRect(u, v, 0.22)) return [0, 0, 0, 0]
  // 背景渐变
  const t = (u + v) / 2
  const bg = [Math.round(79 + 40 * t), Math.round(70 + 20 * t), Math.round(229 - 30 * t), 255]
  // 书签丝带: x∈[0.3,0.7], y∈[0.15,0.85], 底部 V 形缺口
  if (u >= 0.3 && u <= 0.7 && v >= 0.15 && v <= 0.85) {
    const d = Math.abs(u - 0.5) / 0.2 // 0 中心..1 边缘
    const notchTop = 0.65 + d * 0.2 // 缺口上边界随离中心距离下移
    if (v >= notchTop) return bg // 缺口(透出背景)
    // 丝带内星形高光: 小圆点
    if ((u - 0.5) ** 2 + (v - 0.38) ** 2 < 0.012) return [99, 102, 241, 255]
    return [255, 255, 255, 255]
  }
  return bg
}
mkdirSync('public/icons', { recursive: true })
for (const s of [16, 48, 128]) writeFileSync(`public/icons/icon${s}.png`, png(s, pixel))
console.log('icons generated')
