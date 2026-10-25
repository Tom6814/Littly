/**
 * 角色卡 PNG 通道：tEXt / zTXt / iTXt 中 keyword='chara' 的 SillyTavern 卡片存取。
 * 最小 PNG chunk 读写器（node:zlib 只用于 zTXt / iTXt 解压）。
 */
import { inflateSync, deflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE: number[] = (() => {
  const table: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

interface PngChunk {
  type: string
  data: Buffer
}

/** 解析 PNG 全部 chunk；非 PNG 返回 null。 */
export function readPngChunks(data: Buffer): PngChunk[] | null {
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  const chunks: PngChunk[] = []
  let pos = 8
  while (pos + 8 <= data.length) {
    const length = data.readUInt32BE(pos)
    const type = data.subarray(pos + 4, pos + 8).toString('latin1')
    const dataStart = pos + 8
    if (dataStart + length + 4 > data.length) return null
    chunks.push({ type, data: Buffer.from(data.subarray(dataStart, dataStart + length)) })
    pos = dataStart + length + 4
    if (type === 'IEND') break
  }
  return chunks
}

function encodeChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crcInput = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(crcInput), 0)
  return Buffer.concat([head, data, crc])
}

/** 从 tEXt / zTXt / iTXt chunk 抽出 keyword 对应的文本。 */
function textFromChunk(chunk: PngChunk): { keyword: string; text: string } | null {
  if (chunk.type === 'tEXt') {
    const nul = chunk.data.indexOf(0)
    if (nul === -1) return null
    return { keyword: chunk.data.subarray(0, nul).toString('latin1'), text: chunk.data.subarray(nul + 1).toString('latin1') }
  }
  if (chunk.type === 'zTXt') {
    const nul = chunk.data.indexOf(0)
    if (nul === -1 || nul + 2 > chunk.data.length) return null
    try {
      return { keyword: chunk.data.subarray(0, nul).toString('latin1'), text: inflateSync(chunk.data.subarray(nul + 2)).toString('utf8') }
    } catch {
      return null
    }
  }
  if (chunk.type === 'iTXt') {
    const nul = chunk.data.indexOf(0)
    if (nul === -1) return null
    const keyword = chunk.data.subarray(0, nul).toString('utf8')
    // compressionFlag(1) compressionMethod(1) languageTag\0 translatedKeyword\0 text
    const flag = chunk.data[nul + 1]
    let pos = nul + 4
    const langEnd = chunk.data.indexOf(0, pos)
    if (langEnd === -1) return null
    pos = langEnd + 1
    const translatedEnd = chunk.data.indexOf(0, pos)
    if (translatedEnd === -1) return null
    pos = translatedEnd + 1
    const rest = chunk.data.subarray(pos)
    try {
      const text = flag === 1 ? inflateSync(rest).toString('utf8') : rest.toString('utf8')
      return { keyword, text }
    } catch {
      return null
    }
  }
  return null
}

/** 解出角色卡 JSON 文本（base64 → 可选 URI 解码 → JSON）。 */
function decodeCardText(raw: string): string | null {
  const trimmed = raw.trim()
  const tryParse = (candidate: string): string | null => {
    try {
      JSON.parse(candidate) as unknown
      return candidate
    } catch {
      return null
    }
  }
  for (const base64 of [trimmed, trimmed.replace(/\s+/g, '')]) {
    for (const encoding of ['base64', 'base64url']) {
      try {
        const decoded = Buffer.from(base64, encoding as 'base64').toString('utf8')
        const direct = tryParse(decoded)
        if (direct !== null) return direct
        const uriDecoded = tryParse(decodeURIComponent(decoded))
        if (uriDecoded !== null) return uriDecoded
      } catch {
        // 继续尝试
      }
    }
  }
  return null
}

/** 从 PNG 提取 'chara' 卡片 JSON 文本；无卡片返回 null。 */
export function extractCharaCard(png: Buffer): string | null {
  const chunks = readPngChunks(png)
  if (chunks === null) return null
  for (const chunk of chunks) {
    const entry = textFromChunk(chunk)
    if (entry !== null && entry.keyword === 'chara') {
      const decoded = decodeCardText(entry.text)
      if (decoded !== null) return decoded
    }
  }
  return null
}

/** 生成 1x1 透明 PNG。 */
function minimalPng(): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const scanline = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00])
  const idat = deflateSync(scanline)
  return Buffer.concat([
    PNG_SIGNATURE,
    encodeChunk('IHDR', ihdr),
    encodeChunk('IDAT', idat),
    encodeChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 把 'chara' 卡片文本写入 PNG（新增 tEXt chunk，插在 IEND 前）。 */
export function embedCharaCard(png: Buffer, cardJson: string): Buffer | null {
  const chunks = readPngChunks(png)
  if (chunks === null) return null
  const base64 = Buffer.from(cardJson, 'utf8').toString('base64')
  const textData = Buffer.concat([Buffer.from('chara', 'latin1'), Buffer.from([0]), Buffer.from(base64, 'latin1')])
  const out: Buffer[] = [PNG_SIGNATURE]
  for (const chunk of chunks) {
    if (chunk.type === 'IEND') {
      out.push(encodeChunk('tEXt', textData))
      out.push(encodeChunk('IEND', chunk.data))
    } else {
      out.push(encodeChunk(chunk.type, chunk.data))
    }
  }
  return Buffer.concat(out)
}

/** 角色卡导出：优先嵌入现有头像，否则生成最小 PNG。 */
export function buildCharacterPng(avatarPng: Buffer | null, cardJson: string): Buffer {
  const source = avatarPng ?? minimalPng()
  const embedded = embedCharaCard(source, cardJson)
  if (embedded !== null) return embedded
  const fresh = embedCharaCard(minimalPng(), cardJson)
  return fresh ?? minimalPng()
}
