// Scan every bundled client half inside app.asar for slot registrations that
// target the seats the marketplace plugin needs.
//
// Header parsing is deterministic: brace-match the JSON object inside the
// header buffer (ASCII-safe), then VALIDATE the resulting data offset by reading
// an indexed file back as JSON. Same approach as tools/asar-tool.mjs.
import fs from 'node:fs'

const ARCHIVE = process.argv[2]
const NEEDLES = process.argv.slice(3)
if (!ARCHIVE || NEEDLES.length === 0) {
  console.error('usage: scan-slots.mjs <archive> <needle...>')
  process.exit(2)
}

function headerEndInBuffer(buf) {
  let depth = 0
  let inStr = false
  let esc = false
  let started = false
  for (let i = 0; i < buf.length; i += 1) {
    const c = buf[i] // numeric byte
    if (esc) { esc = false; continue }
    if (inStr) {
      if (c === 0x5c) esc = true
      else if (c === 0x22) inStr = false
      continue
    }
    if (c === 0x22) inStr = true
    else if (c === 0x7b) { depth += 1; started = true }
    else if (c === 0x7d) {
      depth -= 1
      if (started && depth === 0) return i + 1
    }
  }
  return -1
}

function load() {
  const fd = fs.openSync(ARCHIVE, 'r')
  const size = fs.fstatSync(fd).size
  const declared = Buffer.alloc(4)
  fs.readSync(fd, declared, 0, 4, 8)
  const want = declared.readUInt32LE(0)
  const chunk = Buffer.alloc(Math.min(want + 4096, size - 16))
  fs.readSync(fd, chunk, 0, chunk.length, 16)
  const end = headerEndInBuffer(chunk)
  if (end < 0) throw new Error('header end not found')
  const header = JSON.parse(chunk.subarray(0, end).toString('utf8'))

  const files = []
  ;(function walk(node, prefix) {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name
      if (entry.files) walk(entry, p)
      else files.push({ path: p, size: Number(entry.size), offset: Number(entry.offset) })
    }
  })(header, '')

  const witness = files.find((f) => f.path.endsWith('dsh/package.json')) ?? files.find((f) => f.path.endsWith('package.json'))
  const candidates = [16 + end, 8 + (16 + end - 16), 16 + end + 4, 16 + end - 4, 12 + end]
  let baseOffset = null
  let witnessName = null
  for (const c of candidates) {
    if (c <= 0 || c >= size) continue
    try {
      const buf = Buffer.alloc(witness.size)
      fs.readSync(fd, buf, 0, witness.size, c + witness.offset)
      const parsed = JSON.parse(buf.toString('utf8'))
      if (parsed && typeof parsed.name === 'string') { baseOffset = c; witnessName = parsed.name; break }
    } catch { /* try next */ }
  }
  if (baseOffset === null) throw new Error('no candidate data offset validated')
  return { fd, files, baseOffset, witnessName }
}

const { fd, files, baseOffset, witnessName } = load()
const targets = files.filter((f) => /lib\/(client|types\/client\/index)\.js$/.test(f.path))
console.error(`[scan] baseOffset=${baseOffset} witness=${witnessName} clientHalves=${targets.length}`)

let found = 0
for (const f of targets) {
  if (f.size > 4_000_000) continue
  const buf = Buffer.alloc(f.size)
  fs.readSync(fd, buf, 0, f.size, baseOffset + f.offset)
  const text = buf.toString('utf8')
  for (const needle of NEEDLES) {
    let idx = text.indexOf(needle)
    while (idx !== -1) {
      found += 1
      const from = Math.max(0, idx - 140)
      const to = Math.min(text.length, idx + 300)
      console.log(`\n=== ${f.path}   <<${needle}>>`)
      console.log(text.slice(from, to).replace(/\s+/g, ' '))
      idx = text.indexOf(needle, idx + needle.length)
      if (found >= 30) { console.error('\n(capped at 30)'); process.exit(0) }
    }
  }
}
console.error(`[scan] hits=${found}`)
