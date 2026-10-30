/**
 * 零依赖二维码（QR Code）编码器 + PNG 输出。
 *
 * 来源：复制自 `channel-wechat-ilink/src/ilink-qr.ts`（同一份零依赖实现，仓库没有
 * qrcode 依赖）。@littly/bili 与 @littly/channel-wechat-ilink 是两个独立插件，
 * 这里复制而不是跨包 import，避免 B 站插件被动依赖微信渠道（装配顺序/启用与否解耦）。
 * 需要改编码器行为时两处同步（见 docs/BILI-INTEGRATION.md「实现边界」）。
 */

import { deflateSync } from 'node:zlib'

// --- 容量表（ECC M，版本 1–10） ---

/** 每个版本的总码字数（数据 + 纠错）。 */
const TOTAL_CODEWORDS: readonly number[] = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346]
/** 每个版本的数据码字数（ECC M）。 */
const DATA_CODEWORDS: readonly number[] = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216]
/** 每个版本的纠错码字数/块（ECC M）。 */
const EC_PER_BLOCK: readonly number[] = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
/** 块分组：[组1块数, 组1数据码字, 组2块数, 组2数据码字]（ECC M）。 */
const BLOCKS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0, 0, 0], // v0 占位
  [1, 16, 0, 0],
  [1, 28, 0, 0],
  [1, 44, 0, 0],
  [2, 32, 0, 0],
  [2, 43, 0, 0],
  [4, 27, 0, 0],
  [4, 31, 0, 0],
  [2, 38, 2, 39],
  [3, 36, 2, 37],
  [4, 43, 1, 44],
]
/** 对齐图案中心坐标（版本 1 无）。 */
const ALIGNMENT: ReadonlyArray<readonly number[]> = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]

/** 纠错等级 M 的两个格式位（L=01, M=00, Q=11, H=10）。 */
const ECC_M_BITS = 0
/** 最大支持的版本（容量表上限）。 */
const MAX_VERSION = 10

// --- GF(256) / Reed-Solomon ---

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x >= 256) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!
}

/** GF(256) 乘法。 */
function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!
}

/**
 * 生成多项式：∏(x - α^i), i=0..degree-1，系数从高次到低次。
 * @param degree - 纠错码字数。
 * @returns 生成多项式系数数组。
 */
function rsGenerator(degree: number): number[] {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ poly[j]!
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(poly[j]!, GF_EXP[i]!)
    }
    poly = next
  }
  return poly
}

/**
 * Reed-Solomon 纠错码字。
 * @param data - 数据码字。
 * @param ecLen - 纠错码字数。
 * @returns 纠错码字。
 */
function rsEncode(data: readonly number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen)
  const remainder = new Array<number>(ecLen).fill(0)
  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0)
    remainder.shift()
    remainder.push(0)
    for (let i = 0; i < ecLen; i++) {
      remainder[i] = (remainder[i] ?? 0) ^ gfMul(gen[i + 1] ?? 0, factor)
    }
  }
  return remainder
}

// --- 位流 ---

/** LSB-first 位写入器（QR 码字按高位在前组字节，数据位按 MSB-first 写入每个码字）。 */
class BitBuffer {
  private readonly bits: number[] = []
  /** 追加 value 的低 length 位（高位先）。 */
  append(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1)
  }
  get length(): number {
    return this.bits.length
  }
  /** 补 0 到 8 的倍数，返回码字数组。 */
  toCodewords(): number[] {
    while (this.bits.length % 8 !== 0) this.bits.push(0)
    const out: number[] = []
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] ?? 0)
      out.push(byte)
    }
    return out
  }
}

// --- 主编码 ---

/** 编码结果：模块矩阵（true=深色）+ 版本。 */
export interface QrMatrix {
  /** 边长（模块数，含静区在内不含）。 */
  size: number
  version: number
  /** modules[y][x] = true 表示深色。 */
  modules: boolean[][]
}

/**
 * 把文本编码成 QR 矩阵（byte 模式，ECC M，版本自动 1–10，掩码罚分选优）。
 * @param text - 待编码文本（UTF-8）。
 * @returns 模块矩阵。
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text)
  const version = pickVersion(bytes.length)
  const dataCodewords = DATA_CODEWORDS[version]!
  const countBits = version <= 9 ? 8 : 16
  const capacityBits = dataCodewords * 8
  const neededBits = 4 + countBits + bytes.length * 8
  if (neededBits > capacityBits) throw new Error(`qrcode: 文本过长（${String(bytes.length)} 字节，v${String(version)} 容量不足）`)

  // 1) 位流：模式(0100) + 字符数 + 数据 + 终止符 + 字节对齐 + 填充码字
  const buffer = new BitBuffer()
  buffer.append(0b0100, 4)
  buffer.append(bytes.length, countBits)
  for (const byte of bytes) buffer.append(byte, 8)
  const terminator = Math.min(4, capacityBits - buffer.length)
  buffer.append(0, terminator)
  const data = buffer.toCodewords()
  const padBytes = [0xec, 0x11]
  let padIndex = 0
  while (data.length < dataCodewords) {
    data.push(padBytes[padIndex % 2]!)
    padIndex++
  }

  // 2) 分块 + 纠错 + 交织
  const ecLen = EC_PER_BLOCK[version]!
  const [g1Count, g1Data, g2Count, g2Data] = BLOCKS[version]!
  const blocks: Array<{ data: number[]; ec: number[] }> = []
  let offset = 0
  for (let i = 0; i < g1Count; i++) {
    const chunk = data.slice(offset, offset + g1Data)
    offset += g1Data
    blocks.push({ data: chunk, ec: rsEncode(chunk, ecLen) })
  }
  for (let i = 0; i < g2Count; i++) {
    const chunk = data.slice(offset, offset + g2Data)
    offset += g2Data
    blocks.push({ data: chunk, ec: rsEncode(chunk, ecLen) })
  }
  const maxData = Math.max(...blocks.map((b) => b.data.length))
  const interleaved: number[] = []
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) {
      const value = block.data[i]
      if (value !== undefined) interleaved.push(value)
    }
  }
  for (let i = 0; i < ecLen; i++) {
    for (const block of blocks) interleaved.push(block.ec[i] ?? 0)
  }
  if (interleaved.length !== TOTAL_CODEWORDS[version]!) {
    throw new Error('qrcode: 交织码字数异常（内部错误）')
  }

  // 3) 画功能图案 → 放数据 → 8 种掩码选最优
  const size = 17 + version * 4
  const base = createBaseMatrix(size, version)
  // 数据位（未掩码）
  const dataBits: number[] = []
  for (const codeword of interleaved) {
    for (let i = 7; i >= 0; i--) dataBits.push((codeword >>> i) & 1)
  }
  drawData(base.mat, base.fn, size, dataBits)

  let best: boolean[][] | null = null
  let bestPenalty = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask++) {
    const candidate = base.mat.map((row) => row.slice())
    applyMask(candidate, base.fn, size, mask)
    drawFormatInfo(candidate, size, mask)
    const penalty = penaltyScore(candidate, size)
    if (penalty < bestPenalty) {
      bestPenalty = penalty
      best = candidate
    }
  }
  return { size, version, modules: best ?? base.mat }
}

/** 选最小可用版本（byte 模式，ECC M）。 */
function pickVersion(byteLength: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const countBits = v <= 9 ? 8 : 16
    const dataBits = DATA_CODEWORDS[v]! * 8
    if (4 + countBits + byteLength * 8 <= dataBits) return v
  }
  throw new Error(`qrcode: 内容过长（${String(byteLength)} 字节超过 v${String(MAX_VERSION)}-M 容量）`)
}

/** 创建只含功能图案的矩阵（数据区先填 false，并用 fn 标记保留位）。 */
function createBaseMatrix(size: number, version: number): { mat: boolean[][]; fn: boolean[][] } {
  const mat: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const setFn = (x: number, y: number, dark: boolean): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    mat[y]![x] = dark
    fn[y]![x] = true
  }

  // 定位图案（三个角）+ 分隔符（白边一圈）
  const drawFinder = (cx: number, cy: number): void => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= size || y >= size) continue
        const inRing = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6
        const dark = inRing && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4))
        setFn(x, y, dark)
      }
    }
  }
  drawFinder(0, 0)
  drawFinder(size - 7, 0)
  drawFinder(0, size - 7)

  // 定时图案（第 6 行/列，黑白相间）
  for (let i = 8; i < size - 8; i++) {
    setFn(i, 6, i % 2 === 0)
    setFn(6, i, i % 2 === 0)
  }

  // 对齐图案
  const centers = ALIGNMENT[version] ?? []
  for (const cy of centers) {
    for (const cx of centers) {
      // 跳过与定位图案重叠的三处
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1
          setFn(cx + dx, cy + dy, dark)
        }
      }
    }
  }

  // 预留格式信息区（先填 false，稍后按掩码重画）+ 固定的深色模块
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFn(8, i, false)
      setFn(i, 8, false)
    }
  }
  for (let i = 0; i < 8; i++) {
    setFn(size - 1 - i, 8, false)
    setFn(8, size - 1 - i, false)
  }
  setFn(8, size - 8, true)

  // v7+ 版本信息区（18 位 × 2 处）
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      setFn(a, b, false)
      setFn(b, a, false)
    }
  }
  return { mat, fn }
}

/** 按 ISO 18004 的之字形顺序把数据位填入非功能模块。 */
function drawData(mat: boolean[][], fn: boolean[][], size: number, bits: readonly number[]): void {
  let index = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    const upward = ((right + 1) & 2) === 0
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert
      for (let j = 0; j < 2; j++) {
        const x = right - j
        if (x < 0 || fn[y]![x] === true) continue
        mat[y]![x] = index < bits.length ? bits[index] === 1 : false
        index++
      }
    }
  }
}

/** 应用掩码到非功能模块。 */
function applyMask(mat: boolean[][], fn: boolean[][], size: number, mask: number): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (fn[y]![x] === true) continue
      if (maskBit(mask, x, y)) mat[y]![x] = !mat[y]![x]
    }
  }
}

/** 掩码条件（0–7）。 */
function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (x + y) % 3 === 0
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
    default:
      return false
  }
}

/** 画格式信息（ECC M + mask，BCH(15,5)，异或 0x5412，两处副本）。 */
function drawFormatInfo(mat: boolean[][], size: number, mask: number): void {
  let bits = ((ECC_M_BITS << 3) | mask) << 10
  const generator = 0x537
  let remainder = bits
  for (let i = 14; i >= 10; i--) {
    if (((remainder >>> i) & 1) === 1) remainder ^= generator << (i - 10)
  }
  bits = (((ECC_M_BITS << 3) | mask) << 10) | remainder
  bits ^= 0x5412
  const getBit = (i: number): boolean => ((bits >>> i) & 1) === 1

  // 第一处：左上环绕
  for (let i = 0; i <= 5; i++) mat[i]![8] = getBit(i)
  mat[7]![8] = getBit(6)
  mat[8]![8] = getBit(7)
  mat[8]![7] = getBit(8)
  for (let i = 9; i < 15; i++) mat[8]![14 - i] = getBit(i)
  // 第二处：右上 + 左下
  for (let i = 0; i < 8; i++) mat[8]![size - 1 - i] = getBit(i)
  for (let i = 8; i < 15; i++) mat[size - 15 + i]![8] = getBit(i)
  mat[size - 8]![8] = true // 固定深色模块
}

// --- 罚分（选掩码） ---

/** 计算整张矩阵的掩码罚分（4 条规则）。 */
function penaltyScore(mat: boolean[][], size: number): number {
  let score = 0
  // 规则 1：行/列中连续 ≥5 个同色
  for (let y = 0; y < size; y++) score += runPenalty(mat[y]!)
  for (let x = 0; x < size; x++) score += runPenalty(mat.map((row) => row[x]!))
  // 规则 2：2×2 同色块
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = mat[y]![x]
      if (c === mat[y]![x + 1] && c === mat[y + 1]![x] && c === mat[y + 1]![x + 1]) score += 3
    }
  }
  // 规则 3：行/列中出现 1011101 且一侧有 4 个浅色（11 位模式，两种朝向）
  const patterns = [0b10111010000, 0b00001011101]
  for (let y = 0; y < size; y++) score += patternPenalty(mat[y]!, patterns)
  for (let x = 0; x < size; x++) score += patternPenalty(mat.map((row) => row[x]!), patterns)
  // 规则 4：深色比例偏离 50%
  let dark = 0
  for (const row of mat) for (const cell of row) if (cell) dark++
  const percent = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(percent - 50) / 5) * 10
  return score
}

/** 规则 1 罚分：连续同色段。 */
function runPenalty(line: readonly boolean[]): number {
  let score = 0
  let run = 1
  for (let i = 1; i < line.length; i++) {
    if (line[i] === line[i - 1]) {
      run++
    } else {
      if (run >= 5) score += 3 + (run - 5)
      run = 1
    }
  }
  if (run >= 5) score += 3 + (run - 5)
  return score
}

/** 规则 3 罚分：11 位模式匹配次数 × 40。 */
function patternPenalty(line: readonly boolean[], patterns: readonly number[]): number {
  let score = 0
  for (let i = 0; i + 11 <= line.length; i++) {
    let value = 0
    for (let j = 0; j < 11; j++) value = (value << 1) | (line[i + j] === true ? 1 : 0)
    if (patterns.includes(value)) score += 40
  }
  return score
}

// --- PNG 输出 ---

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE: number[] = (() => {
  const table: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC32（PNG chunk 校验）。 */
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 组一个 PNG chunk。 */
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** 把 QR 矩阵渲染成 PNG 字节（8-bit 灰度，scale 像素/模块，margin 模块静区）。 */
export function qrToPng(matrix: QrMatrix, options: { scale?: number; margin?: number } = {}): Buffer {
  const scale = Math.max(1, Math.round(options.scale ?? 8))
  const margin = Math.max(0, Math.round(options.margin ?? 4))
  const dimension = (matrix.size + margin * 2) * scale
  const raw = Buffer.alloc(dimension * (dimension + 1), 0)
  for (let py = 0; py < dimension; py++) {
    const rowStart = py * (dimension + 1)
    raw[rowStart] = 0 // filter type: none
    const my = Math.floor(py / scale) - margin
    for (let px = 0; px < dimension; px++) {
      const mx = Math.floor(px / scale) - margin
      const dark = my >= 0 && my < matrix.size && mx >= 0 && mx < matrix.size && matrix.modules[my]![mx] === true
      raw[rowStart + 1 + px] = dark ? 0x00 : 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(dimension, 0)
  ihdr.writeUInt32BE(dimension, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // color type: grayscale
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 文本 → PNG data URL（控制台直接 <img src>）。 */
export function qrTextToPngDataUrl(text: string, options: { scale?: number; margin?: number } = {}): string {
  return `data:image/png;base64,${qrToPng(encodeQr(text), options).toString('base64')}`
}

/** 判断一段文本是否 base64。 */
function looksBase64(text: string): boolean {
  const compact = text.replace(/\s+/g, '')
  return compact.length >= 64 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)
}

/** 图片魔数 → MIME。 */
function imageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

/** 归一化结果：可直接给前端的 data URL（以及原始待编码文本，便于排障）。 */
export interface QrDataUrlResult {
  dataUrl: string
  /** 服务端实际编码进二维码的文本（qrcode_img_content 原值或解 base64 后的文本）。 */
  payload: string
  /** 来源形态：已经是图片 / 文本编码。 */
  source: 'image' | 'text'
}

/**
 * 把 iLink `qrcode_img_content` 归一化为 data URL。
 *
 * 实测真实 API 返回文本 URL；SDK 的 mock 说明里提到可能返回 base64 图片。
 * 两种都兼容：图片直接透传，文本用自研 QR 编码器渲染成 PNG。
 * @param content - iLink 返回的 qrcode_img_content。
 * @returns data URL 与编码载荷。
 */
export function qrContentToDataUrl(content: string): QrDataUrlResult {
  const text = content.trim()
  if (text === '') throw new Error('qrcode: 二维码内容为空')
  // 1) 已经是 data URL
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(text)) {
    return { dataUrl: text, payload: text, source: 'image' }
  }
  // 2) 可能是裸 base64 图片
  if (looksBase64(text)) {
    try {
      const bytes = Buffer.from(text.replace(/\s+/g, ''), 'base64')
      const mime = imageMime(bytes)
      if (mime !== null) return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, payload: text, source: 'image' }
      // base64 解出来是文本 → 那就是真正要编码的载荷
      const decoded = bytes.toString('utf8')
      if (/^[\x20-\x7e\r\n]+$/.test(decoded) && decoded.trim() !== '') {
        return { dataUrl: qrTextToPngDataUrl(decoded.trim()), payload: decoded.trim(), source: 'text' }
      }
    } catch {
      // 落到文本编码
    }
  }
  // 3) 普通文本（真实 API 的形态）→ 自绘二维码
  return { dataUrl: qrTextToPngDataUrl(text), payload: text, source: 'text' }
}
