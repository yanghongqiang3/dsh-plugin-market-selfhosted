/**
 * Verify the shell entry reaches BOTH carriers.
 *
 * Why a dedicated test: the entry silently disappeared once, and the reason was
 * architectural rather than a bug in the markup. The desktop shell serves its
 * index from disk (`dsh-app://app` -> dsh-web-frontend/dist/index.html), so it
 * never runs the HTTP render path. Its only injection channel is
 * `webserver/index-inject` shipped over IPC. A regression here is invisible until
 * somebody opens the app and cannot find the entry — which is exactly what
 * happened, twice.
 *
 *   node tools/test-shell-entry.mjs [port]
 *
 * It drives tools/serve-local.mjs, which mirrors both carriers.
 */
import { spawn } from 'node:child_process'

const PORT = Number(process.argv[2] ?? 17990)
const BASE = `http://127.0.0.1:${PORT}`

let problems = 0
const ok = (label, condition, extra = '') => {
  if (condition) console.log(`ok    ${label}${extra ? `  ${extra}` : ''}`)
  else {
    problems += 1
    console.error(`FAIL  ${label}${extra ? `  ${extra}` : ''}`)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const server = spawn(process.execPath, ['tools/serve-local.mjs', String(PORT)], {
  cwd: 'E:\\workspace\\dsh',
  env: { ...process.env, MARKET_SERVICE_URL: 'http://127.0.0.1:1' },
})

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/__shell-injections`)).ok) return true
    } catch {
      /* still starting */
    }
    await sleep(200)
  }
  return false
}

if (!(await waitForServer())) {
  console.error('FAIL  serve-local 未能启动')
  server.kill()
  process.exit(1)
}

console.log(`base: ${BASE}\n`)

// ------------------------------------------------- channel 1: index-inject rows
console.log('--- 通道一：webserver/index-inject（Electron 桌面壳唯一通道）---')

const { rows } = await (await fetch(`${BASE}/__shell-injections`)).json()
ok('插件注册了 index-inject 监听器', Array.isArray(rows), `rows=${Array.isArray(rows) ? rows.length : 'n/a'}`)

const styleRow = rows.find((row) => row.kind === 'style')
const htmlRow = rows.find((row) => row.kind === 'html')
ok('推送了 style 行', Boolean(styleRow), styleRow ? `${styleRow.text.length} 字符` : '')
ok('推送了 html 行', Boolean(htmlRow), htmlRow ? `${htmlRow.html.length} 字符` : '')
ok('html 行的 placement 为 body', htmlRow?.placement === 'body', String(htmlRow?.placement))
ok('style 行用 text 字段（renderRow 要求）', typeof styleRow?.text === 'string')
ok('html 行用 html 字段（renderRow 要求）', typeof htmlRow?.html === 'string')

// Every kind must exist in the renderer's switch, or the whole boot throws
// "web boot: unknown index injection row".
const KNOWN_KINDS = ['global', 'script', 'script-src', 'script-preload', 'style', 'html']
ok(
  '所有行 kind 都在渲染器支持列表内',
  rows.every((row) => KNOWN_KINDS.includes(row.kind)),
  rows.map((row) => row.kind).join(', '),
)

ok('样式选择器指向入口 id', String(styleRow?.text).includes('#dsh-marketplace-entry'))
ok('markup 含入口 id', String(htmlRow?.html).includes('id="dsh-marketplace-entry"'))
ok('markup 是指向 /market 的链接', String(htmlRow?.html).includes('href="/market"'))
ok('入口文案可见（不是纯图标）', String(htmlRow?.html).includes('内部插件市场'))
ok('有 hover 态', String(styleRow?.text).includes(':hover'))
ok('层级压过壳内容', String(styleRow?.text).includes('z-index:2147483647'))
ok('每行都是纯 JSON 可序列化（要过 IPC）', (() => {
  try {
    const round = JSON.parse(JSON.stringify(rows))
    return JSON.stringify(round) === JSON.stringify(rows)
  } catch {
    return false
  }
})())

// --------------------------------------------------- channel 2: HTTP-rendered
console.log('\n--- 通道二：webServer.tapIndex（HTTP 提供的 index）---')

const html = await (await fetch(`${BASE}/`)).text()
ok('HTTP index 含入口 id', html.includes('id="dsh-marketplace-entry"'))
ok('HTTP index 在 </body> 之前插入', html.indexOf('dsh-marketplace-entry') < html.indexOf('</body>'))
ok('HTTP index 仍保留 #root', html.includes('id="root"'))
ok('入口在 #root 之外（否则 React 重渲染会丢掉它）', (() => {
  const rootEnd = html.indexOf('</div>', html.indexOf('id="root"'))
  return html.indexOf('id="dsh-marketplace-entry"') > rootEnd
})())

// ---------------------------------------------------------------- idempotence
console.log('\n--- 幂等性 ---')
const second = await (await fetch(`${BASE}/__shell-injections`)).json()
ok('重复收集不会累积监听器', second.rows.length === rows.length, `${rows.length} -> ${second.rows.length}`)
const html2 = await (await fetch(`${BASE}/`)).text()
ok('重复渲染不会重复插入入口', html2.split('dsh-marketplace-entry').length === html.split('dsh-marketplace-entry').length)

// ------------------------------------------------------------------- page live
console.log('\n--- 页面本身 ---')
const page = await (await fetch(`${BASE}/market`)).text()
ok('/market 页面可访问', page.includes('内部插件市场'))
const config = await (await fetch(`${BASE}/dsh-market/config`)).json()
ok('config 端点报告服务端地址', config.serviceUrl === 'http://127.0.0.1:1', String(config.serviceUrl))

console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
server.kill()
process.exit(problems ? 1 : 0)
