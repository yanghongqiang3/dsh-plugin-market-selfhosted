// Read-only asar inspector with EMPIRICAL base-offset resolution.
// The Electron asar header is a V8-pickled buffer whose exact padding we do not
// assume: we try candidate data offsets and keep the one that reads an indexed
// file back as valid JSON / valid UTF-8.
//
//   node asar-tool.mjs <archive> list <substring> [limit]
//   node asar-tool.mjs <archive> cat  <innerPath>
import fs from 'node:fs'

const PROBE = 32

function load(archive) {
  const fd = fs.openSync(archive, 'r')
  const probe = Buffer.alloc(PROBE)
  fs.readSync(fd, probe, 0, PROBE, 0)
  const pickleSize = probe.readUInt32LE(0)
  const declaredJson = probe.readUInt32LE(8)

  // Locate the real end of the JSON object by brace matching from the first '{'.
  const scanLen = Math.min(declaredJson + 64, fs.fstatSync(fd).size)
  const scan = Buffer.alloc(scanLen)
  fs.readSync(fd, scan, 0, scanLen, 16)
  const text = scan.toString('utf8')
  let depth = 0
  let inStr = false
  let esc = false
  let jsonEnd = -1
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (esc) { esc = false; continue }
    if (inStr) {
      if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) { jsonEnd = i + 1; break }
    }
  }
  if (jsonEnd < 0) throw new Error('could not find end of asar JSON header')
  const header = JSON.parse(text.slice(0, jsonEnd))
  const jsonStart = 16

  // Candidate data offsets; validate the one that reproduces an indexed file.
  const candidates = [
    8 + pickleSize,
    16 + pickleSize,
    4 + pickleSize,
    jsonStart + jsonEnd + 4,
    jsonStart + jsonEnd,
  ]
  let chosen = null
  let witness = null
  for (const c of candidates) {
    if (c < 0 || c >= fs.fstatSync(fd).size) continue
    const got = readAt(fd, c, header)
    if (got) { chosen = c; witness = got; break }
  }
  if (chosen === null) throw new Error('no candidate offset validated')
  return { fd, header, baseOffset: chosen, witness, jsonBytes: jsonEnd }
}

function findFile(node, prefix, target) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name
    if (entry.files) {
      const hit = findFile(entry, path, target)
      if (hit) return hit
    } else if (path === target) {
      return { ...entry, path }
    }
  }
  return null
}

function readAt(fd, baseOffset, header) {
  // Witness = the first indexed package.json; a correct offset yields valid JSON.
  const target = findFile(header, '', 'dsh/package.json') ?? findFile(header, '', 'package.json')
  if (!target) return null
  try {
    const buf = Buffer.alloc(Number(target.size))
    fs.readSync(fd, buf, 0, Number(target.size), baseOffset + Number(target.offset))
    const parsed = JSON.parse(buf.toString('utf8'))
    return parsed && typeof parsed.name === 'string' ? parsed.name : null
  } catch {
    return null
  }
}

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, path, out)
    else out.push({ path, size: Number(entry.size ?? 0), offset: Number(entry.offset) })
  }
}

const [, , archive, command, arg, extra] = process.argv
const { fd, header, baseOffset, witness } = load(archive)
const files = []
walk(header, '', files)
console.error(`[asar] baseOffset=${baseOffset} witness(dsh/package.json).name=${witness} files=${files.length}`)

if (command === 'list') {
  const needle = arg ?? ''
  const limit = Number(extra ?? 80)
  const hits = files.filter((f) => f.path.includes(needle)).slice(0, limit)
  console.log(`showing ${hits.length} of ${files.filter((f) => f.path.includes(needle)).length} matching "${needle}"`)
  for (const f of hits) console.log(`${String(f.size).padStart(9)}  ${f.path}`)
} else if (command === 'cat') {
  const hit = files.find((f) => f.path === arg)
  if (!hit) { console.error(`not found: ${arg}`); process.exit(1) }
  const buf = Buffer.alloc(hit.size)
  fs.readSync(fd, buf, 0, hit.size, baseOffset + hit.offset)
  process.stdout.write(buf)
} else {
  console.error('usage: list <substring> [limit] | cat <innerPath>')
  process.exit(2)
}
