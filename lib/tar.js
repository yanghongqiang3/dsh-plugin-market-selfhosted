/**
 * Minimal tar.gz reader for installing published artifacts.
 *
 * `tar.exe` exists on modern Windows but is not guaranteed on every host and its
 * flags differ from GNU tar, so the published format (ustar, regular files, no
 * links, no GNU extensions) is read directly. Two safety properties matter more
 * than completeness:
 *
 *   1. every entry path is refused if it escapes the destination;
 *   2. only regular files and explicit directories are accepted — no symlinks,
 *      hardlinks, devices or FIFOs, which is how an archive would otherwise
 *      write outside its own directory.
 */
import { gunzipSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, resolve, sep } from 'node:path'

const BLOCK = 512

class TarError extends Error {}

/** Parse a .tar.gz buffer into a Map of relative path -> Buffer. */
export function readTarGz(buffer) {
  let tar
  try {
    tar = gunzipSync(buffer)
  } catch (error) {
    throw new TarError(`不是有效的 gzip 数据：${error?.message ?? error}`)
  }

  const files = new Map()
  let offset = 0
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (isZeroBlock(header)) break

    const name = readString(header, 0, 100)
    const sizeField = readString(header, 124, 12).trim()
    const size = sizeField === '' ? 0 : Number.parseInt(sizeField, 8)
    const typeFlag = String.fromCharCode(header[156] || 48)
    const prefix = readString(header, 345, 155)

    if (!Number.isFinite(size) || size < 0) throw new TarError(`条目 ${name} 的大小字段无效`)
    if (checksumMismatch(header)) throw new TarError(`条目 ${name} 的校验和不匹配`)

    const full = prefix ? `${prefix}/${name}` : name
    const start = offset + BLOCK
    const data = tar.subarray(start, start + size)

    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      files.set(full, data)
    } else if (typeFlag === '5') {
      files.set(full.endsWith('/') ? full : `${full}/`, null) // directory marker
    } else if (typeFlag === 'x' || typeFlag === 'g' || typeFlag === 'L') {
      // pax/gnu metadata: consumed and ignored, but never written to disk
    } else {
      throw new TarError(`归档含有不支持的条目类型 "${typeFlag}"（${full}）`)
    }

    offset = start + size + ((BLOCK - (size % BLOCK)) % BLOCK)
  }
  return files
}

/**
 * Write a parsed archive into `destination`, refusing any path that escapes it.
 * Returns the list of files written.
 *
 * `stripPrefix` removes one leading directory from every entry, which is what the npm
 * tarball layout needs: `npm pack` and pnpm put the whole package under `package/`, so
 * extracting such an archive verbatim would bury it one level too deep.
 *
 * The prefix is removed ONLY IF EVERY FILE ENTRY HAS IT. A partially prefixed archive is
 * ambiguous — the same file could arrive with and without the prefix — and the
 * destination here is a live plugin directory rather than a scratch space, so an
 * ambiguous archive is refused instead of guessed at.
 */
export function extractTarGz(buffer, destination, { stripPrefix = '' } = {}) {
  const root = resolve(destination)
  const files = readTarGz(buffer)
  const written = []

  if (stripPrefix !== '') {
    for (const [entry, data] of files) {
      if (data === null) continue
      if (!entry.startsWith(stripPrefix)) {
        throw new TarError(`归档条目 ${entry} 不在 ${stripPrefix} 下，布局不一致`)
      }
    }
  }

  for (const [entry, data] of files) {
    const relative = stripPrefix !== '' ? entry.slice(stripPrefix.length) : entry
    if (relative === '') continue
    // A tar path is untrusted text: reject absolute paths, drive letters and any
    // traversal that normalizes outside the destination root.
    if (relative.startsWith('/') || /^[a-zA-Z]:/.test(relative)) {
      throw new TarError(`归档条目为绝对路径：${relative}`)
    }
    const target = resolve(root, normalize(relative))
    if (target !== root && !target.startsWith(root + sep)) {
      throw new TarError(`归档条目逃逸出目标目录：${relative}`)
    }
    if (data === null) {
      mkdirSync(target, { recursive: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    written.push(relative)
  }
  return written
}

/** Convenience for callers that only need one file out of the archive. */
export function readEntry(buffer, path) {
  const files = readTarGz(buffer)
  const direct = files.get(path)
  if (direct) return direct
  for (const [name, data] of files) {
    if (name.replace(/^\.\//, '') === path) return data
  }
  return undefined
}

export { TarError }

function isZeroBlock(block) {
  for (const byte of block) if (byte !== 0) return false
  return true
}

function readString(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/, '')
}

function checksumMismatch(header) {
  const stored = Number.parseInt(readString(header, 148, 8).trim() || '0', 8)
  if (!Number.isFinite(stored) || stored === 0) return false // checksum absent: accept
  let sum = 0
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : header[index]
  }
  return sum !== stored
}
