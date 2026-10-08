// Search every text file inside app.asar for a needle and print surrounding context.
// Read-only. Used to locate the loader/plugin-manager validation messages.
//
//   node grep-asar.mjs <archive> <needle> [contextChars] [maxHits]
import fs from 'node:fs'

const ARCHIVE = process.argv[2]
const NEEDLE = process.argv[3]
const CONTEXT = Number(process.argv[4] ?? 400)
const MAX_HITS = Number(process.argv[5] ?? 10)
if (!ARCHIVE || !NEEDLE) {
  console.error('usage: grep-asar.mjs <archive> <needle> [context] [maxHits]')
  process.exit(2)
}

function headerEndInBuffer(buf) {
  let depth = 0, inStr = false, esc = false, started = false
  for (let i = 0; i < buf.length; i += 1) {
    const c = buf[i]
    if (esc) { esc = false; continue }
    if (inStr) { if (c === 0x5c) esc = true; else if (c === 0x22) inStr = false; continue }
    if (c === 0x22) inStr = true
    else if (c === 0x7b) { depth += 1; started = true }
    else if (c === 0x7d) { depth -= 1; if (started && depth === 0) return i + 1 }
  }
  return -1
}

const fd = fs.openSync(ARCHIVE, 'r')
const size = fs.fstatSync(fd).size
const declaredBuf = Buffer.alloc(4)
fs.readSync(fd, declaredBuf, 0, 4, 8)
const chunk = Buffer.alloc(Math.min(declaredBuf.readUInt32LE(0) + 4096, size - 16))
fs.readSync(fd, chunk, 0, chunk.length, 16)
const end = headerEndInBuffer(chunk)
const header = JSON.parse(chunk.subarray(0, end).toString('utf8'))

const files = []
;(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, p)
    else files.push({ path: p, size: Number(entry.size), offset: Number(entry.offset) })
  }
})(header, '')

const witness = files.find((f) => f.path.endsWith('dsh/package.json'))
let baseOffset = null
for (const c of [16 + end, 16 + end + 4, 16 + end - 4, 12 + end]) {
  try {
    const buf = Buffer.alloc(witness.size)
    fs.readSync(fd, buf, 0, witness.size, c + witness.offset)
    if (JSON.parse(buf.toString('utf8')).name) { baseOffset = c; break }
  } catch { /* next */ }
}
if (baseOffset === null) throw new Error('offset resolution failed')

const needle = Buffer.from(NEEDLE, 'utf8')
let hits = 0
let scanned = 0
for (const f of files) {
  if (f.size === 0 || f.size > 12_000_000) continue
  if (!/\.(js|mjs|cjs|json|ts|map)$/.test(f.path)) continue
  scanned += 1
  const buf = Buffer.alloc(f.size)
  fs.readSync(fd, buf, 0, f.size, baseOffset + f.offset)
  let idx = buf.indexOf(needle)
  while (idx !== -1) {
    hits += 1
    const from = Math.max(0, idx - CONTEXT)
    const to = Math.min(buf.length, idx + CONTEXT)
    console.log(`\n########## ${f.path}  @${idx}`)
    console.log(buf.subarray(from, to).toString('utf8').replace(/\s+/g, ' '))
    if (hits >= MAX_HITS) {
      console.error(`\n[grep] capped at ${MAX_HITS} hits (scanned ${scanned} files)`)
      process.exit(0)
    }
    idx = buf.indexOf(needle, idx + needle.length)
  }
}
console.error(`\n[grep] hits=${hits} scanned=${scanned}/${files.length}`)
