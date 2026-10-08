/**
 * List asar entry NAMES matching a substring.
 *
 * `tools/asar-tool.mjs list` prints only the first page, and its content search
 * greps file bodies rather than paths, so neither finds a skill directory by name.
 * This walks the header directly.
 *
 *   node tools/find-asar-paths.mjs <asar> <substring> [limit]
 */
import { readFileSync } from 'node:fs'

const [asarPath, needleRaw, limitRaw] = process.argv.slice(2)
const needle = String(needleRaw ?? '').toLowerCase()
const limit = Number(limitRaw ?? 80)

const fd = readFileSync(asarPath)
// asar: 4-byte pickup size, 4-byte header size, then a JSON header with a string table.
const headerSize = fd.readUInt32LE(4)
const headerJsonSize = fd.readUInt32LE(12)
const header = JSON.parse(fd.subarray(16, 16 + headerJsonSize).toString('utf8'))

const matches = []
function walk(node, prefix) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const full = prefix === '' ? name : `${prefix}/${name}`
    if (value.files !== undefined) walk(value, full)
    else if (full.toLowerCase().includes(needle)) matches.push({ path: full, size: value.size ?? 0 })
  }
}
walk(header, '')

console.log(`总条目匹配 "${needleRaw}": ${matches.length}`)
for (const entry of matches.slice(0, limit)) {
  console.log(`  ${String(entry.size).padStart(8)}  ${entry.path}`)
}
if (matches.length > limit) console.log(`  … 还有 ${matches.length - limit} 条`)
