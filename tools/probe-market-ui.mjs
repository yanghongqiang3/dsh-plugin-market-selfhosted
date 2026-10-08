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

/**
 * What the plugin's `/dsh-market/installed` route reports for this machine.
 *
 * Mutable so a later section can re-run the page's own reload path with a skill already
 * installed — which is the only way to reach the 更新/卸载 branch that a null version broke.
 */
let installedStub = []

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
    res.end(JSON.stringify({ ok: true, profileDir: join(work, 'profile'), patchFile: '', entries: installedStub }))
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
console.log('--- 顶部紧凑、卡片滚动、分页固定在页脚 ---')
/**
 * The point of the layout: with more results than fit, the CARDS scroll and the pager stays
 * put. Before this everything scrolled together, so the pager — the one control you need when
 * the list is long — was the first thing pushed off screen.
 *
 * Asserted on geometry rather than on class names: a rule that exists but does not take
 * effect looks identical to a working one from the source.
 */
{
  const layout = await evaluate(`(() => {
    const grid = document.getElementById('grid')
    const foot = document.querySelector('.market-foot')
    const pager = document.getElementById('pager')
    const note = document.getElementById('note')
    const detail = document.getElementById('note-detail')
    const gr = grid.getBoundingClientRect()
    const fr = foot.getBoundingClientRect()
    return {
      viewport: window.innerHeight,
      footBottom: Math.round(fr.bottom),
      footTop: Math.round(fr.top),
      gridBottom: Math.round(gr.bottom),
      cards: document.querySelectorAll('#grid .card').length,
      gridScrollable: grid.scrollHeight > grid.clientHeight + 1,
      gridOverflowY: getComputedStyle(grid).overflowY,
      bodyOverflow: getComputedStyle(document.body).overflow,
      pagerInsideFooter: foot.contains(pager),
      pagerBottom: Math.round(pager.getBoundingClientRect().bottom),
      detailVisible: detail.getBoundingClientRect().height > 0,
      noteHeight: Math.round(note.getBoundingClientRect().height),
      // Debug fields: measure before judging.
      detailsOpen: document.querySelector('.note-more').open,
      detailDisplay: getComputedStyle(detail).display,
      detailHeight: Math.round(detail.getBoundingClientRect().height),
      detailText: (detail.textContent || '').length,
      lineHeight: Math.round(document.getElementById('note-line').getBoundingClientRect().height),
      summaryHeight: Math.round(document.querySelector('.note-more summary').getBoundingClientRect().height),
    }
  })()`)
  ok('页脚完整落在视口内（不用滚动就能看到分页）',
    layout.footBottom <= layout.viewport + 1 && layout.footTop > 0,
    `页脚 ${layout.footTop}–${layout.footBottom} / 视口 ${layout.viewport}`)
  ok('  分页在页脚里，而不是卡片区之后', layout.pagerInsideFooter === true)
  ok('  卡片区自己滚动', layout.gridOverflowY === 'auto', String(layout.gridOverflowY))
  ok('  内容确实超出（这个断言才有意义）', layout.gridScrollable === true,
    `${layout.cards} 张卡片`)
  ok('  页面本身不滚动（只有卡片区滚）', layout.bodyOverflow === 'hidden', String(layout.bodyOverflow))
  /**
   * Folded by default: the whole point is to give the space to the cards.
   *
   * Judged by `details.open`, NOT by the detail's height. Chromium hides a closed details'
   * content with `content-visibility`, so the box is still laid out and
   * `getBoundingClientRect().height` reports ~96px for content nobody can see. Measuring it
   * that way reported "not folded" for a page whose screenshot plainly showed it folded.
   */
  ok('顶部说明默认折起', layout.detailsOpen === false, `open=${layout.detailsOpen}`)
  ok('  紧凑行只占一行（不是六行说明）', layout.lineHeight > 0 && layout.lineHeight <= 25,
    `${layout.lineHeight}px`)

  // Scrolling the cards must not move the footer.
  const beforeTop = layout.footTop
  await evaluate(`document.getElementById('grid').scrollTop = 240`)
  await sleep(250)
  const afterTop = await evaluate(`Math.round(document.querySelector('.market-foot').getBoundingClientRect().top)`)
  ok('  滚动卡片时页脚不动', afterTop === beforeTop, `${beforeTop} -> ${afterTop}`)

  // Expanding the explanation takes space from the grid, not from the footer.
  await evaluate(`document.querySelector('.note-more').open = true`)
  await sleep(250)
  const expanded = await evaluate(`(() => {
    const grid = document.getElementById('grid')
    const foot = document.querySelector('.market-foot')
    return {
      detailsOpen: document.querySelector('.note-more').open,
      noteHeight: Math.round(document.getElementById('note').getBoundingClientRect().height),
      footBottom: Math.round(foot.getBoundingClientRect().bottom),
      gridScrollable: grid.scrollHeight > grid.clientHeight + 1,
      viewport: window.innerHeight,
    }
  })()`)
  ok('  展开后「说明」的状态为打开', expanded.detailsOpen === true, `open=${expanded.detailsOpen}`)
  // The note must actually get taller when opened, or the toggle does nothing visible.
  ok('  展开后顶部确实变高（说明真的显示出来了）',
    expanded.noteHeight > layout.noteHeight + 40, `${layout.noteHeight} -> ${expanded.noteHeight}px`)
  ok('  展开后页脚仍在视口内', expanded.footBottom <= expanded.viewport + 1,
    `${expanded.footBottom} / ${expanded.viewport}`)
  ok('  展开后卡片区仍可滚动（空间是从卡片区让出来的）', expanded.gridScrollable === true)
  await evaluate(`document.querySelector('.note-more').open = false`)
  await sleep(200)
}

console.log('')
console.log('--- 宽屏不留大块空白 ---')
/**
 * Measured, because the complaint was geometric.
 *
 * `.wrap` carried `max-width:1180px`, which is right for a page of prose and wrong for a card
 * grid: on a wide window it left a third of the screen empty on the right. A stylesheet that
 * stops applying looks exactly like one that was never written, so this checks the geometry
 * rather than the presence of a rule.
 */
{
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1800, height: 900, deviceScaleFactor: 1, mobile: false,
  })
  await sleep(400)
  const wide = await evaluate(`(() => {
    const wrap = document.querySelector('.wrap')
    const cards = [...document.querySelectorAll('#grid .card')]
    const rights = cards.map((c) => c.getBoundingClientRect().right)
    return {
      viewport: window.innerWidth,
      wrapWidth: Math.round(wrap.getBoundingClientRect().width),
      cards: cards.length,
      lastCardRight: rights.length ? Math.round(Math.max(...rights)) : 0,
      columns: new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left))).size,
    }
  })()`)
  ok('内容区占满窗口宽度（右侧不留大块空白）',
    wide.wrapWidth >= wide.viewport - 40,
    `wrap ${wide.wrapWidth} / 视口 ${wide.viewport}`)
  // The trailing allowance is the grid's scrollbar gutter plus the page padding.
  ok('  卡片一直排到内容区右侧', wide.viewport - wide.lastCardRight <= 40,
    `最右卡片 ${wide.lastCardRight}，右侧剩 ${wide.viewport - wide.lastCardRight}px`)
  ok('  多出来的宽度变成更多列，而不是更宽的卡片', wide.columns >= 4, `${wide.columns} 列`)
  await send('Emulation.clearDeviceMetricsOverride')
  await sleep(300)
}

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
console.log('--- 已安装的卡片：同版本不提供更新 ---')
/**
 * The reported bug: a skill installed at 1.0.0 was offered 「更新到 1.0.0」.
 *
 * Cause: skill entries reported `version: null` from the plugin, so the page's
 * `installedHere.version !== entry.version` was `null !== '1.0.0'` — true.
 *
 * Driven through the page's own reload path (the 刷新目录 button → `refreshCatalog` →
 * `/dsh-market/installed`), so this exercises the real code rather than a stub of it. Both
 * directions are asserted: no update at the same version, and an update when one is due.
 */
{
  const reloadAndRead = async (stub) => {
    installedStub = stub
    await evaluate(`document.getElementById('refresh').click()`)
    await sleep(900)
    return evaluate(`(() => {
      const card = [...document.querySelectorAll('#grid .card')]
        .find((c) => c.querySelector('.name')?.textContent === '@dsh-internal/skill-01')
      if (!card) return null
      return {
        tags: [...card.querySelectorAll('.meta .tag')].map((t) => t.textContent),
        buttons: [...card.querySelectorAll('.actions button')].map((b) => b.textContent),
      }
    })()`)
  }

  const fresh = await reloadAndRead([])
  ok('未安装时提供「安装」', fresh?.buttons?.includes('安装') === true, JSON.stringify(fresh?.buttons))

  const same = await reloadAndRead([
    { name: '@dsh-internal/skill-01', version: '1.0.0', kind: 'skill', skillName: 'skill-01' },
  ])
  ok('已安装时标明「已安装到本机」', same?.tags?.includes('已安装到本机') === true, JSON.stringify(same?.tags))
  ok('  提供「卸载」', same?.buttons?.includes('卸载') === true, JSON.stringify(same?.buttons))
  // The whole point: the SAME version must not be offered as an update.
  const sameUpdate = (same?.buttons ?? []).find((label) => label.startsWith('更新到'))
  ok('  同一版本不提供更新', sameUpdate === undefined, String(sameUpdate))

  const older = await reloadAndRead([
    { name: '@dsh-internal/skill-01', version: '0.9.0', kind: 'skill', skillName: 'skill-01' },
  ])
  ok('本机版本更旧时提供更新', (older?.buttons ?? []).includes('更新到 1.0.0'), JSON.stringify(older?.buttons))

  // An unreadable manifest must not resurrect the bug: unknown installed version, no update.
  const unknown = await reloadAndRead([
    { name: '@dsh-internal/skill-01', version: null, kind: 'skill', skillName: 'skill-01' },
  ])
  const unknownUpdate = (unknown?.buttons ?? []).find((label) => label.startsWith('更新到'))
  ok('本机版本未知时不提供更新（不猜）', unknownUpdate === undefined, String(unknownUpdate))

  installedStub = []
  await evaluate(`document.getElementById('refresh').click()`)
  await sleep(700)
}

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
  /**
   * A viewport-sized capture as well.
   *
   * The tall one above is useful for seeing whole cards, but it cannot show the thing this
   * layout is FOR: with a realistic window the footer must stay visible while the cards
   * scroll. Judging that needs a window that is actually too short for the results.
   */
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1100, height: 620, deviceScaleFactor: 1, mobile: false,
  })
  await sleep(400)
  const small = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOT_DIR, 'market-fold.png'), Buffer.from(small.result.data, 'base64'))
  console.log(`  截图: ${join(SHOT_DIR, 'market-fold.png')}`)
  /**
   * And a WIDE one.
   *
   * `max-width:1180px` is invisible on a narrow window and glaring on a wide one — which is
   * how it survived: every check and every screenshot had been taken at a width where it did
   * nothing.
   */
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1800, height: 900, deviceScaleFactor: 1, mobile: false,
  })
  await sleep(400)
  const wide = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOT_DIR, 'market-wide.png'), Buffer.from(wide.result.data, 'base64'))
  console.log(`  截图: ${join(SHOT_DIR, 'market-wide.png')}`)
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
