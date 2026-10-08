/**
 * Minimal ZIP reader, for the publish upload path only.
 *
 * Windows users zip a folder by right-clicking it; `.tar.gz` needs extra tooling. So the
 * market accepts a zip — but NOT as a second supported format. It is read once, at publish
 * time, and normalised into the canonical tar.gz. Storage, hashing, the catalog, the
 * download route and the client's extractor therefore all keep seeing exactly one format.
 *
 * Node has no zip reader (zlib gives `inflateRaw` and nothing else), so the container is
 * parsed here. Deliberately narrow: the two methods every zip tool writes (stored and
 * deflate), no encryption, no zip64. Anything else is REFUSED with a message that says what
 * was found, rather than being misparsed into a confusing failure later.
 */
import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

/** The first four bytes of any zip: `PK\x03\x04`. */
export const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

export class ZipError extends Error {
  constructor(message, code = 'E_ZIP') {
    super(message)
    this.name = 'ZipError'
    this.code = code
  }
}

/** True when the buffer starts with the local-file-header signature. */
export function looksLikeZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.subarray(0, 4).equals(ZIP_MAGIC)
}

/**
 * Locate the end-of-central-directory record.
 *
 * Scanned backwards because a zip may carry a trailing comment of up to 65535 bytes, and the
 * record is only identifiable by its signature.
 */
function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - 22 - 0xffff)
  for (let at = buffer.length - 22; at >= earliest; at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) return at
  }
  return -1
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Read a zip into an ordered name -> bytes map.
 *
 * Sizes and the CRC come from the CENTRAL directory, never the local header: when the
 * "data descriptor" flag is set (bit 3, which streaming writers use) the local header's
 * sizes are zero and the real values follow the data. Trusting the local header there
 * yields a zero-length or truncated entry.
 *
 * @returns {{ ok: true, entries: Map<string, Buffer> } | { ok: false, code: string, detail: string }}
 */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    return { ok: false, code: 'E_ZIP_TRUNCATED', detail: 'zip 数据太短，连目录记录都不完整' }
  }
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd < 0) {
    return { ok: false, code: 'E_ZIP_TRUNCATED', detail: '找不到 zip 的中央目录结尾记录（文件可能被截断）' }
  }

  const total = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (centralOffset === 0xffffffff || centralSize === 0xffffffff || total === 0xffff) {
    // Saying so beats a misparse: zip64 stores the real values in an extra record that this
    // reader does not follow, and silently reading the sentinel would look like corruption.
    return {
      ok: false,
      code: 'E_ZIP64_UNSUPPORTED',
      detail: '这是 zip64 归档（条目过多或过大），暂不支持；请用 tar.gz，或用 CLI 从目录发布',
    }
  }
  if (centralOffset + centralSize > buffer.length) {
    return { ok: false, code: 'E_ZIP_TRUNCATED', detail: 'zip 的中央目录超出文件末尾（文件可能被截断）' }
  }

  const entries = new Map()
  let at = centralOffset
  for (let index = 0; index < total; index += 1) {
    if (at + 46 > buffer.length) {
      return { ok: false, code: 'E_ZIP_TRUNCATED', detail: `中央目录在第 ${index + 1} 个条目处中断` }
    }
    if (buffer.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      return { ok: false, code: 'E_ZIP_BAD_CENTRAL', detail: `第 ${index + 1} 个条目的目录记录签名不对` }
    }
    const flags = buffer.readUInt16LE(at + 8)
    const method = buffer.readUInt16LE(at + 10)
    const expectedCrc = buffer.readUInt32LE(at + 16)
    const compressedSize = buffer.readUInt32LE(at + 20)
    const uncompressedSize = buffer.readUInt32LE(at + 24)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const localOffset = buffer.readUInt32LE(at + 42)
    const nameBytes = buffer.subarray(at + 46, at + 46 + nameLength)

    if ((flags & 0x0001) !== 0) {
      return {
        ok: false,
        code: 'E_ZIP_ENCRYPTED',
        detail: `条目 ${nameBytes.toString('utf8')} 是加密的，无法读取`,
      }
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      return {
        ok: false,
        code: 'E_ZIP64_UNSUPPORTED',
        detail: '这是 zip64 归档（条目过多或过大），暂不支持；请用 tar.gz，或用 CLI 从目录发布',
      }
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      return { ok: false, code: 'E_ZIP_BAD_CENTRAL', detail: `条目 ${nameBytes.toString('utf8')} 的本地头无效` }
    }

    /**
     * The local header repeats the name and carries its OWN extra field, whose length
     * routinely differs from the central one. The data offset must be computed from the
     * local lengths — using the central ones lands inside the file and produces garbage.
     */
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressedSize > buffer.length) {
      return { ok: false, code: 'E_ZIP_TRUNCATED', detail: `条目 ${nameBytes.toString('utf8')} 的数据超出文件末尾` }
    }
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)

    let content
    if (method === 0) {
      content = Buffer.from(raw)
    } else if (method === 8) {
      try {
        content = inflateRawSync(raw)
      } catch (error) {
        return {
          ok: false,
          code: 'E_ZIP_INFLATE',
          detail: `条目 ${nameBytes.toString('utf8')} 解压失败：${error?.message ?? error}`,
        }
      }
    } else {
      return {
        ok: false,
        code: 'E_ZIP_METHOD',
        detail: `条目 ${nameBytes.toString('utf8')} 使用了不支持的压缩方式 ${method}（只支持 0 存储与 8 deflate）`,
      }
    }

    // Verify before trusting the bytes: a corrupt entry must be reported here, not turned
    // into a package that fails later with a misleading message.
    if (crc32(content) !== expectedCrc) {
      return { ok: false, code: 'E_ZIP_CRC', detail: `条目 ${nameBytes.toString('utf8')} 的 CRC 校验不匹配（归档已损坏）` }
    }
    if (content.length !== uncompressedSize) {
      return {
        ok: false,
        code: 'E_ZIP_CRC',
        detail: `条目 ${nameBytes.toString('utf8')} 解压后大小不符（期望 ${uncompressedSize}，实际 ${content.length}）`,
      }
    }

    // Zip names always use `/`, but archives made on Windows have been seen with `\`.
    const name = nameBytes.toString('utf8').replace(/\\/g, '/')
    // Directory entries carry no data and must not become files.
    if (name.endsWith('/')) {
      at += 46 + nameLength + extraLength + commentLength
      continue
    }
    entries.set(name, content)
    at += 46 + nameLength + extraLength + commentLength
  }

  if (entries.size === 0) {
    return { ok: false, code: 'E_ZIP_EMPTY', detail: 'zip 里没有任何文件' }
  }
  return { ok: true, entries }
}
