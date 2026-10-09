/**
 * Syntax-check an HTML page's inline classic scripts.
 *
 * `node --check` reads JavaScript, not HTML, and these pages are not modules — so the app
 * they carry is parsed by nothing except a browser. `run-all.mjs` runs the same check across
 * every page before running any suite; this entry point exists for checking ONE file while
 * editing it.
 *
 *   node tools/check-html-syntax.mjs web/market.html
 *
 * Worth having because the failure mode is total and silent in the toolchain: a stray
 * character in a regex literal inside the inline script is a SyntaxError, the page renders
 * nothing, and no test that does not open a browser would ever notice.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const file = process.argv[2]
const html = readFileSync(file, 'utf8')
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1])
if (blocks.length === 0) {
  console.log(`${file}: no inline script`)
  process.exit(0)
}
const dir = mkdtempSync(join(tmpdir(), 'dsh-html-check-'))
let bad = 0
blocks.forEach((code, index) => {
  const target = join(dir, `block-${index}.mjs`)
  writeFileSync(target, code)
  const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
  if (result.status === 0) {
    console.log(`ok    ${file} inline script #${index} (${code.split('\n').length} lines)`)
  } else {
    bad += 1
    console.error(`FAIL  ${file} inline script #${index}`)
    console.error(String(result.stderr).split('\n').slice(0, 8).join('\n'))
  }
})
process.exit(bad ? 1 : 0)
