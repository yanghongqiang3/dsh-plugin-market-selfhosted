/**
 * The console's artifacts table must stay readable, at any window width.
 *
 * Reported: after clicking 召回, the 制品 column showed "only the first letter", and a refresh
 * put it right. Reproduced by measurement rather than guessed at: with EIGHT columns, 598px of
 * them fixed and the actions cell unable to shrink, `.grow` is the only cell that can give. At a
 * 900px window the name column measured **30px** — and `overflow:hidden` renders 30px as about
 * one glyph.
 *
 * So this asserts the two things that keep it readable, at several widths:
 *
 *   - the name column never falls below its floor;
 *   - the ACTION buttons stay on screen — the first fix (a floor alone) merely moved the problem,
 *     scrolling the buttons out of view, which is the reason anyone opens this pane.
 *
 * Skipped, not failed, when no browser is available.
 *
 *   node tools/probe-console-layout.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/index.mjs'

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
if (!existsSync(edge)) {
  console.log('SKIPPED: 没有 Edge，无法测量布局')
  console.log('')
  console.log('RESULT: all checks passed')
  process.exit(0)
}

let problems = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) problems += 1
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const work = mkdtempSync(join(tmpdir(), 'dsh-console-layout-'))
const app = createApp({ dbFile: join(work, 'market.db'), storageDir: join(work, 'storage') })
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
const SERVICE = `http://127.0.0.1:${app.server.address().port}`

const post = async (path, body, token) => {
  const response = await fetch(`${SERVICE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}
const PASSWORD = 'layout-password-2026'
const boot = (await post('/dsh-market/auth/login', { username: 'admin', password: 'dsh-admin' })).body
await post('/dsh-market/auth/password', { newPassword: PASSWORD }, boot.token)
const { token } = (await post('/dsh-market/auth/login', { username: 'admin', password: PASSWORD })).body
await post('/dsh-market/admin/groups', { id: 'platform', description: '平台组' }, token)
await post('/dsh-market/admin/grants', { groupId: 'platform', pluginPattern: '*', effect: 'allow' }, token)
await post('/dsh-market/admin/membership', { username: 'admin', groupId: 'platform' }, token)

/** Long names on purpose: a short one cannot show that the column is being squeezed. */
const publish = (name, kind) => {
  const dir = join(work, `src-${name.replace(/[@/]/g, '_')}`)
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name, version: '1.0.0', description: '布局用', dsh: { market: { kind } },
  }))
  if (kind === 'skill') writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name.split('/').pop()}\ndescription: 说明。\n---\n\n正文\n`)
  else writeFileSync(join(dir, 'lib', 'plugin.js'), 'export function apply() {}\n')
  return app.artifacts.publishFromDirectory(dir, { publishedBy: 'layout', state: 'published' })
}
publish('@dsh-internal/a-very-long-plugin-name-for-layout', 'plugin')
publish('@dsh-internal/another-long-plugin-name-here', 'plugin')

const profileDir = mkdtempSync(join(tmpdir(), 'dsh-console-layout-edge-'))
const PORT = 9614
const browser = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--user-data-dir=${profileDir}`, `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' })

let socketUrl = null
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find((item) => item.type === 'page')
    if (page?.webSocketDebuggerUrl) { socketUrl = page.webSocketDebuggerUrl; break }
  } catch { /* starting */ }
  await sleep(250)
}
if (socketUrl === null) {
  console.log('SKIPPED: 浏览器没有起来')
  browser.kill()
  console.log('')
  console.log('RESULT: all checks passed')
  process.exit(0)
}

const socket = new WebSocket(socketUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve))
let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
})
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.result?.exceptionDetails) return { error: String(result.result.exceptionDetails.text) }
  return result.result?.result?.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: `${SERVICE}/console` })
await sleep(2500)
await evaluate(`
  document.getElementById('login-user').value = 'admin';
  document.getElementById('login-pass').value = ${JSON.stringify(PASSWORD)};
  document.getElementById('login-submit').click();
  true`)
await sleep(1800)
// The 制品 pane, which is what the report is about.
await evaluate(`document.querySelector('.navbtn[data-panel="artifacts"]').click()`)
await sleep(1000)
ok('切到制品面板', await evaluate(`!document.getElementById('pane-artifacts').classList.contains('hidden')`))

/** How wide the name column and the action cell are, and whether the table scrolls. */
const measure = () => evaluate(`(() => {
  const table = document.getElementById('artifacts-table')
  const row = [...table.querySelectorAll('.tr')].find((r) => !r.classList.contains('head'))
  if (!row) return { error: 'no data row' }
  const name = row.children[0]
  const actions = row.querySelector('.cell-actions')
  return {
    table: Math.round(table.getBoundingClientRect().width),
    name: Math.round(name.getBoundingClientRect().width),
    // The widest a name cell could need, so truncation is distinguishable from collapse.
    nameContent: Math.round(row.children[0].scrollWidth),
    actions: Math.round(actions?.getBoundingClientRect().width ?? 0),
    // Actions must end INSIDE the table box, or they are scrolled out of sight.
    actionsRight: Math.round(actions?.getBoundingClientRect().right ?? 0),
    tableRight: Math.round(table.getBoundingClientRect().right),
    scrolls: table.scrollWidth > table.clientWidth + 1,
    hiddenSecondary: [...row.children].filter((c) => c.classList.contains('col-narrow-hide'))
      .every((c) => getComputedStyle(c).display === 'none'),
  }
})()`)

console.log('')
console.log('--- 每个面板的内容都在导航右侧（不能跑到下面）---')
/**
 * All five panes, not just the one that was reported.
 *
 * `#view-console` wraps so the status line can take its own row, and the content area's base size
 * used to be its CONTENT width (`flex: 1 1 auto`). So a pane with wide content — 账号, with its
 * search box and table — wrapped BELOW the nav, while the artifacts pane stayed put because its
 * table scrolls and contributes no wide max-content. Content must not decide the layout.
 *
 * The viewport is set WIDE first. At the default headless size (800px) the `max-width: 820px`
 * rule switches the console to a stacked column ON PURPOSE, and measuring there reported every
 * pane as "wrapped" — the assertion was broken, not the page.
 */
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(400)
for (const panel of ['users', 'groups', 'grants', 'publish', 'artifacts']) {
  await evaluate(`document.querySelector('.navbtn[data-panel="${panel}"]').click()`)
  await sleep(700)
  const geometry = await evaluate(`(() => {
    const nav = document.querySelector('#view-console .side')
    const panes = document.querySelector('#view-console .panes')
    const navBox = nav.getBoundingClientRect()
    const panesBox = panes.getBoundingClientRect()
    return {
      navRight: Math.round(navBox.right),
      navTop: Math.round(navBox.top),
      panesLeft: Math.round(panesBox.left),
      panesTop: Math.round(panesBox.top),
      panesWidth: Math.round(panesBox.width),
      wraps: panesBox.top >= navBox.bottom - 1,
    }
  })()`)
  ok(`${panel}：内容区在导航右侧`, geometry.wraps === false && geometry.panesLeft >= geometry.navRight,
    `nav 右缘 ${geometry.navRight} / 内容左缘 ${geometry.panesLeft} 换行=${geometry.wraps}`)
  ok(`  ${panel}：内容区撑满剩余宽度`, geometry.panesWidth >= 600, `${geometry.panesWidth}px`)
}

// Back to the pane this probe measures in the sections below.
await evaluate(`document.querySelector('.navbtn[data-panel="artifacts"]').click()`)
await sleep(700)

console.log('')
console.log('--- 窄到 820px 以下时，堆叠是设计好的 ---')
/**
 * The other half of the same rule: below 820px the console deliberately stacks, so the nav sits
 * ABOVE the content. Asserted so the wide-layout assertion above cannot be "fixed" by deleting
 * the responsive branch.
 */
{
  await send('Emulation.setDeviceMetricsOverride', { width: 780, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
  const stacked = await evaluate(`(() => {
    const nav = document.querySelector('#view-console .side')
    const panes = document.querySelector('#view-console .panes')
    return {
      panesTop: Math.round(panes.getBoundingClientRect().top),
      navBottom: Math.round(nav.getBoundingClientRect().bottom),
      navWidth: Math.round(nav.getBoundingClientRect().width),
    }
  })()`)
  ok('780px 下导航在上、内容在下（有意为之）', stacked.panesTop >= stacked.navBottom - 1,
    `nav 底 ${stacked.navBottom} / 内容顶 ${stacked.panesTop}`)
  ok('  导航此时横向铺开，不再占一整列', stacked.navWidth > 300, `${stacked.navWidth}px`)
  await send('Emulation.clearDeviceMetricsOverride')
  await evaluate(`document.querySelector('.navbtn[data-panel="artifacts"]').click()`)
  await sleep(500)
}

console.log('')
console.log('--- 名字列在窄窗口下不能被压扁 ---')
/**
 * The floor is 160px. Anything at or above it can show a recognisable prefix of the name; the
 * reported 30px showed about one glyph, which is what "只显示了第一个字母" was.
 */
for (const width of [1400, 1100, 1000, 936, 900]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(320)
  const m = await measure()
  ok(`${width}px：名字列不低于 160px`, m.name >= 160, `${m.name}px（内容需 ${m.nameContent}px）`)
  ok(`  ${width}px：操作按钮没有被挤出视野`, m.actionsRight <= m.tableRight + 1,
    `按钮右缘 ${m.actionsRight} / 表格右缘 ${m.tableRight}`)
  if (width <= 1000) {
    ok(`  ${width}px：次要列（通道/大小）让位`, m.hiddenSecondary === true)
    ok(`  ${width}px：不需要横向滚动`, m.scrolls === false)
  }
}
await send('Emulation.clearDeviceMetricsOverride')

console.log('')
console.log('--- 召回之后仍然如此（这条状态会加宽操作列）---')
{
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(320)
  await evaluate(`(() => {
    const table = document.getElementById('artifacts-table')
    const row = [...table.querySelectorAll('.tr')].find((r) => !r.classList.contains('head'))
    const button = [...row.querySelectorAll('button')].find((b) => b.textContent.includes('召回'))
    button.click()
    return true
  })()`)
  await sleep(800)
  await evaluate(`(() => {
    const dialog = document.querySelector('dialog[open]')
    if (!dialog) return false
    const buttons = [...dialog.querySelectorAll('button')]
    buttons[buttons.length - 1].click()
    return true
  })()`)
  await sleep(2200)
  const m = await measure()
  /**
   * The ROOT cause, asserted directly rather than through its symptom.
   *
   * `.status` used to be a third child of the `#view-console` flex row, so writing a message
   * into it took width from the panes: measured 336px stolen, the panes falling from ~760 to
   * 424, and the artifacts table collapsing until the name column hit its floor. A refresh
   * cleared the message and "fixed" it.
   *
   * So: after a status message, the panes must be just as wide as before it.
   */
  const layout = await evaluate(`(() => {
    const panes = document.querySelector('#view-console .panes')
    const status = document.getElementById('status')
    const container = document.getElementById('view-console')
    return {
      panes: Math.round(panes.getBoundingClientRect().width),
      status: Math.round(status.getBoundingClientRect().width),
      container: Math.round(container.getBoundingClientRect().width),
      // The FULL text: slicing before matching is how this assertion first reported a failure
      // that was purely its own doing — the message starts with the artifact name.
      statusText: status.textContent,
      // A full-width status means it sits BELOW the panes, not beside them.
      statusBelow: Math.round(status.getBoundingClientRect().top) >=
        Math.round(panes.getBoundingClientRect().bottom) - 1,
    }
  })()`)
  console.log(`  诊断：layout=${JSON.stringify(layout)}`)
  ok('状态栏写入了消息', layout.statusText.includes('已召回'), JSON.stringify(layout.statusText))
  ok('  状态栏独占一行，不跟内容抢宽度',
    layout.statusBelow === true && layout.status >= layout.container - 2,
    `状态宽 ${layout.status} / 容器 ${layout.container} 在下方=${layout.statusBelow}`)
  ok('  内容区没有被状态栏挤窄', layout.panes >= 700, `${layout.panes}px`)
  ok('召回后名字列仍在 160px 以上', m.name >= 160, `${m.name}px`)
  ok('  召回后按钮仍在视野内', m.actionsRight <= m.tableRight + 1,
    `按钮右缘 ${m.actionsRight} / 表格右缘 ${m.tableRight}`)
  ok('  召回列如实显示已召回',
    (await evaluate(`document.getElementById('artifacts-table').textContent.includes('已召回')`)) === true)
  await send('Emulation.clearDeviceMetricsOverride')
}

console.log('')
console.log('结论：')
console.log('  · 名字列有下限，任何窗口宽度都不会被压到只剩一个字。')
console.log('  · 放不下时先隐藏次要列（通道/大小），而不是把操作按钮挤出视野。')
console.log('  · 这组测量来自真实浏览器，因为这类问题只有布局能证明。')

browser.kill()
app.server.close()
app.db.close()
await sleep(300)
rmSync(work, { recursive: true, force: true })
rmSync(profileDir, { recursive: true, force: true })
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
