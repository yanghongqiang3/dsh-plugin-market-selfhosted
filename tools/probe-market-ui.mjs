/**
 * Drive the INSTALL PAGE in a real browser: kind tabs, paging, and the card badge.
 *
 * The page is served by the DSH host plugin, which needs DSH running and a signed-in
 * account. So this harness stands up a scratch service and a tiny proxy that plays the
 * plugin's part for the three routes the page asks its OWN origin for
 * (`/dsh-market/config`, `/installed`, `/session`), then serves the real `web/market.html`
 * and the real `web/` assets unmodified. Everything else is proxied to the service.
 *
 * What that buys over a source-level assertion: the tabs, the pager and the badge are
 * rendered by the real code against real data. A `.tr`/`.trow` class mismatch once meant a
 * whole table had NO styling at all, and only a screenshot showed it.
 *
 *   node tools/probe-market-ui.mjs [--shot <dir>] [--debug-port <port>]
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../server/index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', 'web')

const argv = process.argv.slice(2)
const shotIndex = argv.indexOf('--shot')
const SHOT_DIR = shotIndex >= 0 ? argv[shotIndex + 1] : null
const portIndex = argv.indexOf('--debug-port')
const DEBUG_PORT = Number(portIndex >= 0 ? argv[portIndex + 1] : 9611)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let problems = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) problems += 1
}

// ---------------------------------------------------------------- the service
const work = mkdtempSync(join(tmpdir(), 'dsh-marketui-'))
const app = createApp({ dbFile: join(work, 'market.db'), storageDir: join(work, 'storage') })
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
const apiPort = app.server.address().port
const API = `http://127.0.0.1:${apiPort}`

const call = async (method, path, body, token) => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

const adminLogin = await call('POST', '/dsh-market/auth/login', { username: 'admin', password: 'dsh-admin' })
await call('POST', '/dsh-market/auth/password', { newPassword: 'admin-password-2026' }, adminLogin.body.token)
const admin = (await call('POST', '/dsh-market/auth/login', { username: 'admin', password: 'admin-password-2026' })).body.token
await call('POST', '/dsh-market/admin/users', { username: 'alice', password: 'alice-initial-2026' }, admin)
const aliceFirst = await call('POST', '/dsh-market/auth/login', { username: 'alice', password: 'alice-initial-2026' })
await call('POST', '/dsh-market/auth/password', { newPassword: 'alice-password-2026' }, aliceFirst.body.token)
await call('POST', '/dsh-market/admin/groups', { id: 'platform', description: '平台' }, admin)
await call('POST', '/dsh-market/admin/grants', { groupId: 'platform', pluginPattern: '@dsh-internal/*', effect: 'allow' }, admin)
await call('POST', '/dsh-market/admin/membership', { username: 'alice', groupId: 'platform' }, admin)

/** 14 packages over two pages: 8 plugins, 1 bundle, 5 skills. */
const publish = (name, kind) => {
  const dir = mkdtempSync(join(work, 'src-'))
  const dsh = kind === 'skill'
    ? { market: { kind: 'skill', owner: 'platform', summary: `${name} 的技能摘要` } }
    : kind === 'bundle'
      ? { bundle: { patch: 'cordis.patch.yml' }, market: { owner: 'platform', summary: `${name} 的摘要` } }
      : { market: { owner: 'platform', summary: `${name} 的摘要` } }
  // The publish path takes the summary from market.json or package.json's `description`;
  // putting it only in `dsh.market.summary` made every card read 「（无摘要）」, which is a
  // fixture mistake that would have hidden how the cards actually look.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name, version: '1.0.0', description: `供测试用的摘要：${name.split('/').pop()}`, dsh,
  }))
  if (kind === 'skill') {
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name.split('/').pop()}\ndescription: 技能说明。\n---\n\n正文\n`)
  } else {
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'plugin.js'), 'export function apply() {}\n')
  }
  if (kind === 'bundle') writeFileSync(join(dir, 'cordis.patch.yml'), '- name: x\n')
  return app.artifacts.publishFromDirectory(dir, { publishedBy: 'alice', state: 'published' })
}
for (let i = 1; i <= 8; i += 1) publish(`@dsh-internal/plugin-${String(i).padStart(2, '0')}`, 'plugin')
publish('@dsh-internal/bundle-01', 'bundle')
for (let i = 1; i <= 5; i += 1) publish(`@dsh-internal/skill-${String(i).padStart(2, '0')}`, 'skill')

// ------------------------------------------------------------------ the proxy
/**
 * Plays the plugin's part for the routes the page asks its OWN origin for, and forwards
 * everything else to the service. The page is served unmodified — if it needed a change to
 * work under this harness, the harness would be testing the wrong thing.
 */
const PAGE_ROUTES = new Map([
  ['/market', ['market.html', 'text/html; charset=utf-8']],
  ['/dsh-market/assets/market.css', ['market.css', 'text/css; charset=utf-8']],
  ['/dsh-market/assets/console.css', ['console.css', 'text/css; charset=utf-8']],
  ['/dsh-market/assets/shared.js', ['shared.js', 'text/javascript; charset=utf-8']],
])

let proxyPort = 0
const proxy = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${proxyPort}`)
  const route = PAGE_ROUTES.get(url.pathname)
  if (route !== undefined) {
    const file = join(WEB, route[0])
    if (!existsSync(file)) { res.writeHead(404).end('missing'); return }
    res.writeHead(200, { 'content-type': route[1] })
    res.end(readFileSync(file))
    return
  }
  if (url.pathname === '/dsh-market/config') {
    // The plugin's answer, so the page boots and talks to this origin.
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      serviceUrl: `http://127.0.0.1:${proxyPort}`,
      configured: true,
      profileDir: join(work, 'profile'),
      envVar: 'MARKET_SERVICE_URL',
    }))
    return
  }
  if (url.pathname === '/dsh-market/installed') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, profileDir: join(work, 'profile'), patchFile: '', entries: [] }))
    return
  }
  if (url.pathname === '/dsh-market/session' || url.pathname === '/dsh-market/link') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, session: null, hasSecret: false }))
    return
  }
  // Everything else belongs to the service.
  const body = await new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
  try {
    const upstream = await fetch(`${API}${req.url}`, {
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${apiPort}` },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    })
    const text = await upstream.text()
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    res.end(text)
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, code: 'E_PROXY', detail: String(error?.message ?? error) }))
  }
})
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
proxyPort = proxy.address().port
const PAGE = `http://127.0.0.1:${proxyPort}/market`

// -------------------------------------------------------------------- browser
const edge = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((candidate) => existsSync(candidate))
if (edge === undefined) {
  console.log('  跳过：找不到 Edge（这个探针需要真实浏览器）')
  console.log('')
  console.log('RESULT: SKIPPED — 没有浏览器，界面未验证')
  proxy.close(); app.server.close(); app.db.close(); rmSync(work, { recursive: true, force: true })
  process.exit(0)
}

const browserProfile = mkdtempSync(join(tmpdir(), 'dsh-marketui-browser-'))
const browser = spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--user-data-dir=${browserProfile}`, `--remote-debugging-port=${DEBUG_PORT}`, 'about:blank',
], { stdio: 'ignore' })

let socketUrl = null
for (let attempt = 0; attempt < 80 && socketUrl === null; attempt += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
    const page = list.find((item) => item.type === 'page')
    if (page?.webSocketDebuggerUrl) socketUrl = page.webSocketDebuggerUrl
  } catch { /* still starting */ }
  if (socketUrl === null) await sleep(250)
}
if (socketUrl === null) {
  console.log('  FAIL  无法连接浏览器调试端口')
  browser.kill(); proxy.close(); app.server.close(); app.db.close()
  rmSync(work, { recursive: true, force: true }); rmSync(browserProfile, { recursive: true, force: true })
  process.exit(1)
}

const socket = new WebSocket(socketUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve))
let nextId = 1
const pending = new Map()
const pageErrors = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') {
    pageErrors.push(String(message.params.exceptionDetails.exception?.description
      ?? message.params.exceptionDetails.text).split('\n')[0])
  }
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
})
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.result?.exceptionDetails) {
    return { __error: String(result.result.exceptionDetails.exception?.description ?? '').split('\n')[0] }
  }
  return result.result?.result?.value
}
/** Poll until `expression` is truthy; returns its final value. */
const waitFor = async (expression, tries = 60, gap = 250) => {
  let value
  for (let i = 0; i < tries; i += 1) {
    value = await evaluate(expression)
    if (value) return value
    await sleep(gap)
  }
  return value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: PAGE })
await waitFor("document.readyState === 'complete'")

// Sign in: the page shows the login view until it has a token.
await waitFor("document.getElementById('login-user') !== null")
await evaluate(`(() => {
  document.getElementById('login-user').value = 'alice'
  document.getElementById('login-pass').value = 'alice-password-2026'
  document.getElementById('login-submit').click()
  return true
})()`)
const signedIn = await waitFor("document.getElementById('view-market') && !document.getElementById('view-market').classList.contains('hidden')")
ok('登录后进入市场视图', signedIn === true, String(signedIn))

await waitFor("document.querySelectorAll('#grid .card').length > 0")
await sleep(500)

console.log('')
console.log('--- 三个 tab ---')
const tabs = await evaluate(`[...document.querySelectorAll('#kind-tabs .tab')].map((b) => ({
  kind: b.dataset.kind, text: b.textContent.trim(), on: b.classList.contains('is-on'),
}))`)
ok('有三个 tab', Array.isArray(tabs) && tabs.length === 3, JSON.stringify(tabs?.map((t) => t.kind)))
ok('  顺序是 全部 / 插件 / 技能', JSON.stringify(tabs?.map((t) => t.kind)) === '["all","plugin","skill"]',
  JSON.stringify(tabs?.map((t) => t.kind)))
ok('  默认选中「全部」', tabs?.[0]?.on === true && tabs[1].on === false && tabs[2].on === false,
  JSON.stringify(tabs?.map((t) => t.on)))
// Counts come from the service, so the label cannot disagree with what the tab filters.
ok('  标签带上服务端给的计数', /\d/.test(tabs?.[0]?.text ?? ''), JSON.stringify(tabs?.map((t) => t.text)))
ok('  技能 tab 显示 5', (tabs?.[2]?.text ?? '').includes('5'), String(tabs?.[2]?.text))
ok('  插件 tab 显示 9（含组合包）', (tabs?.[1]?.text ?? '').includes('9'), String(tabs?.[1]?.text))

console.log('')
console.log('--- 分页 ---')
const firstPage = await evaluate(`(() => {
  const names = [...document.querySelectorAll('#grid .card .name')].map((n) => n.textContent)
  const info = document.querySelector('#pager .meta')?.textContent ?? ''
  return { names, info, count: document.getElementById('count').textContent }
})()`)
ok('第一页有内容', (firstPage?.names?.length ?? 0) > 0, String(firstPage?.names?.length))
ok('  每页 10 条', firstPage?.names?.length === 10, String(firstPage?.names?.length))
ok('  分页控件报告总数与页码', /共 14 条/.test(firstPage?.info ?? '') && /第 1 \/ 2 页/.test(firstPage?.info ?? ''),
  JSON.stringify(firstPage?.info))
const nextButton = await evaluate(`(() => {
  const b = [...document.querySelectorAll('#pager button')].find((x) => x.textContent === '下一页')
  if (!b) return null
  b.click()
  return true
})()`)
ok('存在「下一页」', nextButton === true)
await sleep(700)
const secondPage = await evaluate(`(() => {
  const names = [...document.querySelectorAll('#grid .card .name')].map((n) => n.textContent)
  return { names, info: document.querySelector('#pager .meta')?.textContent ?? '' }
})()`)
ok('翻页后内容变化', JSON.stringify(secondPage?.names) !== JSON.stringify(firstPage?.names),
  `${secondPage?.names?.length} 条`)
ok('  第二页只剩 4 条', secondPage?.names?.length === 4, String(secondPage?.names?.length))
ok('  页码显示第 2 / 2 页', /第 2 \/ 2 页/.test(secondPage?.info ?? ''), JSON.stringify(secondPage?.info))
const noOverlap = (secondPage?.names ?? []).every((name) => !(firstPage?.names ?? []).includes(name))
ok('  两页不重叠', noOverlap, JSON.stringify(secondPage?.names))

console.log('')
console.log('--- 卡片标明是技能还是插件 ---')
await evaluate(`[...document.querySelectorAll('#pager button')].find((x) => x.textContent === '首页')?.click()`)
await sleep(700)
const badges = await evaluate(`[...document.querySelectorAll('#grid .card')].map((card) => ({
  name: card.querySelector('.name')?.textContent,
  badges: [...card.querySelectorAll('.meta .tag')].map((t) => ({ text: t.textContent, cls: t.className })),
}))`)
const kindOf = (card) => card.badges.find((b) => b.text === '技能' || b.text === '插件')
ok('每张卡片都有类型徽标', (badges ?? []).every((card) => kindOf(card) !== undefined),
  JSON.stringify((badges ?? []).filter((c) => kindOf(c) === undefined).map((c) => c.name)))
ok('  徽标是第一个标签（先说明是什么）', (badges ?? []).every((card) => kindOf(card) !== undefined && card.badges[0] === kindOf(card)),
  JSON.stringify((badges ?? []).map((c) => c.badges[0]?.text)))
ok('  技能用 tag-kind-skill 样式', (badges ?? []).some((c) => kindOf(c)?.cls?.includes('tag-kind-skill')),
  JSON.stringify((badges ?? []).filter((c) => kindOf(c)?.text === '技能').map((c) => kindOf(c)?.cls)))
ok('  插件用 tag-kind-plugin 样式', (badges ?? []).some((c) => kindOf(c)?.cls?.includes('tag-kind-plugin')))
// The badge classes must be STYLED, or the distinction is invisible in practice.
const styled = await evaluate(`(() => {
  const skill = document.querySelector('.tag-kind-skill')
  const plugin = document.querySelector('.tag-kind-plugin')
  if (!skill || !plugin) return null
  return {
    skillColor: getComputedStyle(skill).color,
    pluginColor: getComputedStyle(plugin).color,
    skillBorder: getComputedStyle(skill).borderTopColor,
  }
})()`)
ok('  两种徽标颜色确实不同', styled !== null && styled.skillColor !== styled.pluginColor,
  JSON.stringify(styled))
ok('  技能徽标有品牌色边框（不是默认灰）', styled !== null && styled.skillBorder !== 'rgb(230, 232, 236)',
  String(styled?.skillBorder))

console.log('')
console.log('--- 点「技能」只剩技能 ---')
await evaluate(`[...document.querySelectorAll('#kind-tabs .tab')].find((b) => b.dataset.kind === 'skill').click()`)
await sleep(900)
const skillView = await evaluate(`(() => ({
  kinds: [...document.querySelectorAll('#grid .card .meta .tag')]
    .map((t) => t.textContent).filter((t) => t === '技能' || t === '插件'),
  cards: document.querySelectorAll('#grid .card').length,
  on: [...document.querySelectorAll('#kind-tabs .tab')].filter((b) => b.classList.contains('is-on')).map((b) => b.dataset.kind),
  info: document.querySelector('#pager .meta')?.textContent ?? '',
  count: document.getElementById('count').textContent,
}))()`)
ok('只剩技能卡', skillView?.cards === 5, String(skillView?.cards))
ok('  没有混进插件', (skillView?.kinds ?? []).every((k) => k === '技能'), JSON.stringify([...new Set(skillView?.kinds ?? [])]))
ok('  只有「技能」被选中', JSON.stringify(skillView?.on) === '["skill"]', JSON.stringify(skillView?.on))
ok('  分页总数变成 5', /共 5 条/.test(skillView?.info ?? ''), JSON.stringify(skillView?.info))
ok('  计数显示 5 / 14', /5 \/ 14/.test(skillView?.count ?? ''), JSON.stringify(skillView?.count))

console.log('')
console.log('--- 搜索在服务端做（分页后仍能搜到别的页）---')
await evaluate(`(() => {
  const tab = [...document.querySelectorAll('#kind-tabs .tab')].find((b) => b.dataset.kind === 'all')
  tab.click()
  return true
})()`)
await sleep(900)
// `skill-05` sorts onto the second page of 全部; a browser-side filter over page 1 would miss it.
await evaluate(`(() => {
  const input = document.getElementById('query')
  input.value = 'skill-05'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
const searched = await waitFor("document.querySelectorAll('#grid .card').length === 1 && document.querySelector('#grid .card .name')?.textContent === '@dsh-internal/skill-05'", 30, 250)
ok('能搜到不在第一页的条目', searched === true, String(await evaluate("document.querySelector('#grid .card .name')?.textContent")))

console.log('')
console.log('--- 页面没有未捕获异常 ---')
ok('没有未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)))

if (SHOT_DIR !== null) {
  mkdirSync(SHOT_DIR, { recursive: true })
  // A default 754x487 viewport cuts a card off above its meta row, so the kind badge — the
  // whole point of the change — was never visible. Capture tall enough to show whole cards.
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1100, height: 1400, deviceScaleFactor: 1, mobile: false,
  })
  await sleep(300)
  // Clear the search so the screenshot shows the real grid.
  await evaluate(`(() => {
    const input = document.getElementById('query')
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(900)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOT_DIR, 'market-tabs.png'), Buffer.from(shot.result.data, 'base64'))
  console.log(`  截图: ${join(SHOT_DIR, 'market-tabs.png')}`)
}

console.log('')
console.log('结论：')
console.log('  · 三个 tab 覆盖两种桶：组合包归入「插件」，计数由服务端给出。')
console.log('  · 分页是服务端的（每页 10 条，共 14 条，2 页，不重叠）。')
console.log('  · 卡片第一个标签就说明是技能还是插件，且两种样式在浏览器里确实不同。')
console.log('  · 搜索走服务端，能搜到不在第一页的条目。')

/**
 * Best-effort cleanup, and it must never decide the exit code.
 *
 * This ran `browser.kill()` and then deleted the browser profile immediately. On Windows
 * Edge is still holding those files for a moment, so `rmSync` threw EBUSY — AFTER the
 * RESULT line had already printed — and the process exited 1. A suite that verified
 * everything would report as crashed, intermittently, which is worse than useless.
 */
try { socket.close() } catch { /* already gone */ }
try { proxy.close() } catch { /* already gone */ }
try { app.server.close() } catch { /* already gone */ }
try { app.db.close() } catch { /* already gone */ }
try { browser.kill() } catch { /* already gone */ }
await sleep(500)
for (const dir of [work, browserProfile]) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(500) }
  }
}
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
