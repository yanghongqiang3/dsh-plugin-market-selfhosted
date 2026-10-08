/**
 * Market server — artifact packing.
 *
 * One implementation of the archive format, used by every producer and consumer:
 * the CLI packs with it, the HTTP upload route unpacks with it, and the tests
 * round-trip through it. Packing is deterministic (fixed mtime, sorted entries),
 * so the same directory always yields the same sha256 — which is what makes the
 * "republish the same tree" idempotence check meaningful.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, normalize, resolve, sep } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

const BLOCK = 512

export class ArchiveError extends Error {}

// ------------------------------------------------------------------ packing

/** Relative paths of everything worth publishing, sorted for determinism. */
export function collectFiles(root, prefix = '', out = []) {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    // Dependencies and VCS internals are never part of a published artifact.
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    if (entry.isDirectory()) collectFiles(root, relative, out)
    else if (entry.isFile()) out.push(relative)
  }
  return out
}

/** Build a deterministic .tar.gz of `root` containing exactly `files`. */
export function packTarGz(root, files) {
  const blocks = []
  for (const relative of [...files].sort()) {
    const data = readFileSync(join(root, relative))
    blocks.push(tarHeader(relative, data.length), data, padding(data.length))
  }
  blocks.push(Buffer.alloc(1024)) // two zero blocks terminate the archive
  return gzipSync(Buffer.concat(blocks), { level: 9 })
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

// ----------------------------------------------------------------- unpacking

/** Parse a .tar.gz into a Map of relative path -> Buffer (null marks a directory). */
export function readTarGz(buffer) {
  let tar
  try {
    tar = gunzipSync(buffer)
  } catch (error) {
    throw new ArchiveError(`不是有效的 gzip 数据：${error?.message ?? error}`)
  }

  const files = new Map()
  let offset = 0
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (isZeroBlock(header)) break

    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const sizeField = readString(header, 124, 12).trim()
    const size = sizeField === '' ? 0 : Number.parseInt(sizeField, 8)
    const typeFlag = String.fromCharCode(header[156] || 48)

    if (!Number.isFinite(size) || size < 0) throw new ArchiveError(`条目 ${name} 的大小字段无效`)
    if (checksumMismatch(header)) throw new ArchiveError(`条目 ${name} 的校验和不匹配`)

    const full = prefix ? `${prefix}/${name}` : name
    const start = offset + BLOCK
    const data = tar.subarray(start, start + size)

    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') files.set(full, data)
    else if (typeFlag === '5') files.set(full.endsWith('/') ? full : `${full}/`, null)
    else if (typeFlag === 'x' || typeFlag === 'g' || typeFlag === 'L') {
      /* pax/gnu metadata: ignored, never written */
    } else {
      throw new ArchiveError(`归档含有不支持的条目类型 "${typeFlag}"（${full}）`)
    }

    offset = start + size + ((BLOCK - (size % BLOCK)) % BLOCK)
  }
  return files
}

/** Read entries into memory, refusing anything that is not a plain file or dir. */
export function unpackToMap(buffer) {
  return readTarGz(buffer)
}

/**
 * Sanity-check an uploaded archive without touching the filesystem: it must be a
 * readable tar.gz whose `package.json` is valid JSON with a name and version, and
 * no entry may escape the archive root.
 */
export function inspectArchive(buffer) {
  const files = readTarGz(buffer)
  for (const entry of files.keys()) {
    if (entry.startsWith('/') || /^[a-zA-Z]:/.test(entry)) {
      return { ok: false, code: 'E_ABSOLUTE_PATH', detail: `归档条目为绝对路径：${entry}` }
    }
    const normalised = normalize(entry)
    if (normalised.startsWith('..') || normalised.includes(`..${sep}`)) {
      return { ok: false, code: 'E_PATH_ESCAPE', detail: `归档条目包含上级引用：${entry}` }
    }
  }
  const pkgBytes = files.get('package.json') ?? files.get('./package.json')
  if (!pkgBytes) return { ok: false, code: 'E_NOT_PACKAGE', detail: '归档内没有 package.json' }

  let pkg
  try {
    pkg = JSON.parse(pkgBytes.toString('utf8'))
  } catch {
    return { ok: false, code: 'E_BAD_PACKAGE_JSON', detail: 'package.json 不是有效 JSON' }
  }
  if (!pkg.name || !pkg.version) {
    return { ok: false, code: 'E_BAD_PACKAGE_JSON', detail: 'package.json 缺少 name 或 version' }
  }

  const marketBytes = files.get('market.json') ?? files.get('./market.json')
  let meta = {}
  if (marketBytes) {
    try {
      meta = JSON.parse(marketBytes.toString('utf8'))
    } catch {
      return { ok: false, code: 'E_BAD_MARKET_JSON', detail: 'market.json 不是有效 JSON' }
    }
  }

  const bundleDecl = pkg?.dsh?.bundle?.patch
  const requiresOwnFiles = [bundleDecl].flat().filter(Boolean)
  for (const relative of requiresOwnFiles) {
    if (!files.has(relative)) {
      return {
        ok: false,
        code: 'E_BUNDLE_PATCH_MISSING',
        detail: `声明 dsh.bundle.patch=${relative}，但归档内没有该文件`,
      }
    }
  }

  return {
    ok: true,
    pkg,
    meta,
    files: [...files.keys()].filter((name) => files.get(name) !== null),
    bytes: buffer.length,
  }
}

/** Round-trippable diagnostic used by tests: list the entries of an archive. */
export function listEntries(buffer) {
  return [...readTarGz(buffer).keys()]
}

/** Used by tests to prove an archive round-trips. */
export function extractTarGz(buffer) {
  return readTarGz(buffer)
}

// -------------------------------------------------------------- tar internals

function tarHeader(name, size) {
  const header = Buffer.alloc(BLOCK)
  const write = (offset, length, value) => header.write(value, offset, length, 'utf8')
  if (Buffer.byteLength(name) > 100) throw new ArchiveError(`路径过长，tar 不支持：${name}`)
  write(0, 100, name)
  write(100, 8, '0000644\0')
  write(108, 8, '0000000\0')
  write(116, 8, '0000000\0')
  write(124, 12, `${size.toString(8).padStart(11, '0')}\0`)
  write(136, 12, '00000000000\0') // mtime fixed at 0: the hash must not depend on the clock
  write(148, 8, '        ')
  write(156, 1, '0')
  write(257, 6, 'ustar\0')
  write(263, 2, '00')
  let sum = 0
  for (const byte of header) sum += byte
  write(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  return header
}

function padding(size) {
  const remainder = size % BLOCK
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder)
}

function isZeroBlock(block) {
  for (const byte of block) if (byte !== 0) return false
  return true
}

function readString(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/, '')
}

function checksumMismatch(header) {
  const stored = Number.parseInt(readString(header, 148, 8).trim() || '0', 8)
  if (!Number.isFinite(stored) || stored === 0) return false
  let sum = 0
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : header[index]
  }
  return sum !== stored
}
