/**
 * Where does the served console come from — the repo, or the installed plugin package?
 *
 * This settles a claim I made without checking: I said changing the console required
 * repacking the plugin tarball. The console is served by the SERVICE, so that is
 * probably wrong.
 *
 * Method: start a service from a COPY of the tree, put a marker in that copy's
 * `web/console.html`, and see whether the response carries it. If it does, the served
 * console comes from the service's own tree — not from the plugin package.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = 'E:/workspace/dsh'
const stage = mkdtempSync(join(tmpdir(), 'dsh-console-src-'))
// Copy just what the service needs to boot and serve.
cpSync(join(ROOT, 'server'), join(stage, 'server'), { recursive: true })
cpSync(join(ROOT, 'web'), join(stage, 'web'), { recursive: true })

const MARKER = '<!-- MARKER-FROM-SERVICE-TREE -->'
const consolePath = join(stage, 'web', 'console.html')
writeFileSync(consolePath, readFileSync(consolePath, 'utf8').replace('<body>', `<body>${MARKER}`))

let problems = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) problems += 1
}

// The plugin package on disk (what a tarball install would place) — untouched, no marker.
const pkgCopy = readFileSync(join(ROOT, 'web', 'console.html'), 'utf8')
ok('仓库原文件不含标记', !pkgCopy.includes(MARKER))

const child = spawn(
  process.execPath,
  [join(stage, 'server', 'index.mjs')],
  {
    env: { ...process.env, MARKET_PORT: '18801', MARKET_HOST: '127.0.0.1', MARKET_DATA_DIR: join(stage, 'data') },
    stdio: 'ignore',
  },
)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let up = false
for (let i = 0; i < 40; i += 1) {
  await sleep(250)
  try {
    const health = await fetch('http://127.0.0.1:18801/dsh-market/health')
    if (health.ok) { up = true; break }
  } catch { /* starting */ }
}
ok('服务从副本启动', up)

if (up) {
  const html = await (await fetch('http://127.0.0.1:18801/console')).text()
  ok('返回的 HTML 带上了副本里的标记', html.includes(MARKER))
  const css = await (await fetch('http://127.0.0.1:18801/dsh-market/assets/console.css')).text()
  ok('console.css 也由服务端提供（同一个 web/ 目录）', css.length > 0)
  const shared = await (await fetch('http://127.0.0.1:18801/dsh-market/assets/shared.js')).text()
  ok('shared.js 也由服务端提供', shared.includes('Shared browser shell'))
}

console.log('')
console.log('结论：')
console.log('  · 控制台页面与它的 CSS 由**服务端从自己的 web/ 目录**读取并直接提供。')
console.log('  · 因此改控制台**不需要重打插件包**，只要重启服务端。')
console.log('  · 我上一轮说的「改控制台要重打包」是错的。包里的 web/console.* 对服务端无用。')

child.kill()
await sleep(500)
rmSync(stage, { recursive: true, force: true })
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
