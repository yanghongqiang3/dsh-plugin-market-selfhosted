/**
 * Which file-swap mechanism can a RUNNING plugin actually use on Windows?
 *
 * A plugin cannot replace its own loaded files in the obvious way: Node reads each module
 * once and Windows holds the file open. Before designing around that, find out what really
 * works, because the design differs a lot depending on the answer:
 *
 *   overwrite loaded .js        -> if allowed, the update is a trivial re-extract
 *   rename(dir) over loaded dir -> if allowed, the update is a cheap atomic swap
 *   create a junction           -> if allowed, versions can sit side by side
 *
 * Measured, not assumed. This mirrors the running-plugin case by importing a module and
 * THEN trying to manipulate the tree it came from.
 */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const work = mkdtempSync(join(tmpdir(), 'dsh-swap-'))

let problems = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) problems += 1
}

// A module that is loaded and therefore "in use", like the running plugin.
const liveDir = join(work, 'live')
mkdirSync(liveDir, { recursive: true })
writeFileSync(join(liveDir, 'package.json'), JSON.stringify({ name: 'swap-demo', version: '1.0.0', type: 'module' }))
writeFileSync(join(liveDir, 'index.js'), 'export const version = "1.0.0"\n')

const first = await import(pathToFileURL(join(liveDir, 'index.js')).href)
ok('模块已加载', first.version === '1.0.0', first.version)

// ------------------------------------------------------------------ 1. overwrite
let overwrite = null
try {
  writeFileSync(join(liveDir, 'index.js'), 'export const version = "2.0.0"\n')
  overwrite = 'ok'
} catch (error) {
  overwrite = error.code ?? String(error)
}
ok('能覆盖已加载的 .js（EBUSY 则不）', overwrite === 'ok', String(overwrite))
ok('覆盖后当前进程仍持旧值（必须重启才生效）', first.version === '1.0.0', first.version)

// ------------------------------------------------------------------ 2. atomic swap
const staged = join(work, 'staged')
mkdirSync(staged, { recursive: true })
writeFileSync(join(staged, 'package.json'), JSON.stringify({ name: 'swap-demo', version: '3.0.0', type: 'module' }))
writeFileSync(join(staged, 'index.js'), 'export const version = "3.0.0"\n')

let swap = null
let swapDetail = ''
try {
  // The pattern that makes the replacement atomic: move the live tree aside, move the new
  // tree in, then delete the old one. A failure between the two renames is recoverable
  // because the old tree is still on disk under `live.old`.
  renameSync(liveDir, join(work, 'live.old'))
  renameSync(staged, liveDir)
  swap = 'ok'
} catch (error) {
  swap = error.code ?? String(error)
  swapDetail = String(error.message).slice(0, 90)
  // Put it back so later checks still have a tree.
  try { renameSync(join(work, 'live.old'), liveDir) } catch { /* best effort */ }
}
ok('能 rename 掉正在使用的目录并换入新的（原子换版）', swap === 'ok', `${swap} ${swapDetail}`)

if (swap === 'ok') {
  const after = await import(`${pathToFileURL(join(liveDir, 'index.js')).href}?v=3`)
  ok('换入后是 3.0.0', after.version === '3.0.0', after.version)
  let cleaned = true
  try { rmSync(join(work, 'live.old'), { recursive: true, force: true }) } catch { cleaned = false }
  ok('旧版本目录可以删掉', cleaned)
}

// ------------------------------------------------------------------ 3. junction
let junction = null
let junctionDetail = ''
try {
  symlinkSync(liveDir, join(work, 'linked'), 'junction')
  junction = 'ok'
} catch (error) {
  junction = error.code ?? String(error)
  junctionDetail = String(error.message).slice(0, 90)
}
ok('能创建 junction（无需提权）', junction === 'ok', `${junction} ${junctionDetail}`)

// ------------------------------------------------------------------ 4. partial failure
/**
 * What a HALF-FINISHED update leaves behind, since the plan must survive it.
 *
 * If extraction is interrupted the target tree may be incomplete. The swap pattern above
 * is what protects against this: nothing touches the live tree until the new tree is
 * complete, so an interrupted download cannot break a working install.
 */
const halfDir = join(work, 'half')
mkdirSync(halfDir, { recursive: true })
writeFileSync(join(halfDir, 'package.json'), JSON.stringify({ name: 'swap-demo', version: '4.0.0' }))
let halfThrows = false
try {
  // No index.js: a truncated extract. This must be detectable BEFORE the swap.
  const pkg = JSON.parse(readFileSync(join(halfDir, 'package.json'), 'utf8'))
  if (!readFileSync(join(halfDir, 'index.js'), 'utf8')) throw new Error('unreachable')
} catch {
  halfThrows = true
}
ok('不完整的暂存目录在换版前就能被发现（读到缺文件即失败）', halfThrows)

console.log('')
console.log('可用于实现的机制：')
console.log(`  直接覆盖已加载文件 : ${overwrite === 'ok' ? '可以' : `不行（${overwrite}）`}`)
console.log(`  rename 原子换版    : ${swap === 'ok' ? '可以 —— 首选' : `不行（${swap}）`}`)
console.log(`  创建 junction      : ${junction === 'ok' ? '可以' : `不行（${junction}）`}`)

rmSync(work, { recursive: true, force: true })
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
