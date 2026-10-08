/**
 * Run every suite and refuse to call a CRASH a pass.
 *
 * This exists because of a concrete mistake. A summary script counted `ok` and `FAIL` lines
 * and nothing else, so when `probe-skill-install.mjs` died on its first line — during a
 * change that made publish-time validation reject its own fixtures — the suite reported
 * `ok=0 FAIL=0`. The summary printed "565 passed, 0 failed" and the total had gone DOWN by
 * 15 even though 27 assertions had just been added. **A suite that produces no output is
 * not a suite that passed**; it is a suite that never ran.
 *
 * So a suite counts as failed when ANY of these hold:
 *   - its exit code is non-zero,
 *   - it never printed a `RESULT:` line,
 *   - it printed a `FAIL` line.
 *
 * Usage:
 *   node tools/run-all.mjs                 # every suite
 *   node tools/run-all.mjs skill kind      # only suites whose name matches
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/**
 * The suite list, read from the files themselves where possible.
 *
 * `verify-install.mjs` takes a profile path and is the only one needing an argument; it is
 * also the only one that inspects a REAL profile, so it stays last.
 */
const SUITES = [
  ['宿主', 'test-host.mjs', []],
  ['服务端', 'test-server.mjs', []],
  ['发布上传', 'test-publish.mjs', []],
  ['文档', 'check-docs.mjs', []],
  ['绑定表', 'test-bindings.mjs', []],
  ['绑定HTTP', 'test-binding-http.mjs', []],
  ['绑定范围', 'probe-binding-scope.mjs', []],
  ['暴露面', 'probe-exposure.mjs', []],
  ['授权链', 'probe-grant-flow.mjs', []],
  ['控制台来源', 'probe-console-source.mjs', []],
  ['版本序', 'probe-version-order.mjs', []],
  ['更新流', 'probe-update-flow.mjs', []],
  ['换版机制', 'probe-swap-mechanics.mjs', []],
  ['自更新', 'probe-self-update.mjs', []],
  ['包可导入', 'probe-package-import.mjs', []],
  ['分页与编辑', 'probe-paging.mjs', []],
  ['刷新令牌', 'probe-refresh.mjs', []],
  ['自动登录', 'probe-autologin.mjs', []],
  ['技能安装', 'probe-skill-install.mjs', []],
  ['制品类型', 'probe-artifact-kind.mjs', []],
  ['zip 发布', 'probe-zip-publish.mjs', []],
  ['技能免 manifest', 'probe-skill-synthesis.mjs', []],
  ['目录筛选分页', 'probe-catalog-paging.mjs', []],
  ['撤回可见性', 'probe-revoked-visibility.mjs', []],
  ['召回', 'probe-recall.mjs', []],
  // Needs a real browser; it reports SKIPPED rather than pretending to pass.
  ['控制台布局', 'probe-console-layout.mjs', []],
  ['安装页界面', 'probe-market-ui.mjs', []],
]

/** The last thing to run: it reads the installed profile rather than a scratch database. */
const PREFLIGHT = ['预检', 'verify-install.mjs', [process.env.DSH_PROFILE_DIR
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'profiles',
    process.env.DSH_PROFILE ?? 'desktop')]]

const filters = process.argv.slice(2)
const wanted = (label, file) => filters.length === 0
  || filters.some((f) => label.includes(f) || file.includes(f))

const rows = []
let totalOk = 0
let totalFail = 0
const broken = []

/**
 * Parse every tool before running any of them.
 *
 * A line that begins with `/` is DIVISION, not a regex, so a line after `foo(...)` that
 * starts with a regex literal is a syntax error. That has been written into these files four
 * times during ordinary editing, and the failure mode is nasty: the file is never loaded, so
 * nothing reports anything until someone happens to run that one tool — while a summary that
 * only counts `ok`/`FAIL` lines cheerfully calls the result "0 failures".
 *
 * `node --check` on each file costs a couple of seconds and turns that into an immediate,
 * named error.
 */
{
  const scripts = readdirSync(HERE).filter((entry) => entry.endsWith('.mjs')).sort()
  const bad = []
  for (const entry of scripts) {
    const result = spawnSync(process.execPath, ['--check', join(HERE, entry)], { encoding: 'utf8' })
    if (result.status !== 0) {
      const message = String(result.stderr ?? '').split('\n').find((line) => /Error/.test(line)) ?? 'parse error'
      bad.push(`${entry}: ${message.trim()}`)
    }
  }
  if (bad.length > 0) {
    console.log('语法检查未通过 —— 这些文件根本不会被加载：')
    for (const line of bad) console.log(`  · ${line}`)
    console.log('')
    console.log('RESULT: INCOMPLETE')
    process.exit(1)
  }
  console.log(`语法检查：${scripts.length} 个测试脚本全部通过`)
  console.log('')
}

const runOne = (label, file, args) => {
  const path = join(HERE, file)
  if (!existsSync(path)) {
    broken.push(`${label}: 文件不存在 ${file}`)
    rows.push({ label, ok: 0, fail: 0, verdict: '缺失' })
    return
  }
  const result = spawnSync(process.execPath, [path, ...args], { cwd: ROOT, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const ok = (output.match(/^ok /gm) ?? []).length
  const fail = (output.match(/^FAIL /gm) ?? []).length
  const hasResult = /^RESULT:/m.test(output)
  totalOk += ok
  totalFail += fail

  /**
   * A `RESULT` line alone is not enough — `RESULT: SKIPPED` has one too, and a suite that
   * skipped its checks has not verified anything. Read what the line actually says.
   */
  const resultLine = (/^RESULT: (.*)$/m.exec(output) ?? [])[1] ?? ''
  let verdict = '通过'
  if (result.status !== 0) verdict = `崩溃(exit=${result.status})`
  else if (!hasResult) verdict = '没有 RESULT 行'
  else if (fail > 0) verdict = `${fail} 项失败`
  else if (resultLine !== 'all checks passed') verdict = `未验证（${resultLine}）`

  if (verdict !== '通过') {
    broken.push(`${label} — ${verdict}`)
    // Print the tail: for a crash that is the stack, for a failure the FAIL lines.
    const tail = output.trimEnd().split('\n').slice(-14).map((line) => `      ${line}`).join('\n')
    console.log(`${label}\n      --- ${verdict} ---\n${tail}`)
  }
  rows.push({ label, ok, fail, verdict })
}

for (const [label, file, args] of SUITES) {
  if (wanted(label, file)) runOne(label, file, args)
}
if (wanted(PREFLIGHT[0], PREFLIGHT[1])) runOne(...PREFLIGHT)

console.log('')
console.log('套件                                  ok    失败  结果')
for (const row of rows) {
  console.log(`  ${row.label.padEnd(12)}${String(row.ok).padStart(8)}${String(row.fail).padStart(7)}   ${row.verdict}`)
}
console.log('')
console.log(`总断言: ${totalOk}   失败: ${totalFail}`)

/**
 * The exit code is what a caller (or a person) should trust. Printing a passing total while
 * a suite never ran is exactly the failure this file was written to stop.
 */
if (broken.length > 0) {
  console.log('')
  console.log('有套件没有正常跑完 —— 总数不可信：')
  for (const line of broken) console.log(`  · ${line}`)
  console.log('')
  console.log('RESULT: INCOMPLETE')
  process.exit(1)
}
console.log('')
console.log('RESULT: all checks passed')
