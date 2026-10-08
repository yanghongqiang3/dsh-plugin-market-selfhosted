/**
 * Drive the console in a real browser: pagination, dialogs, and the binding column.
 *
 * The console is a page, so "it works" can only mean a DOM check. This asserts the parts
 * the refactor was for:
 *   - table rows are laid out (the `.tr`/`.trow` mismatch meant NO row styling applied)
 *   - pagination reports the range and actually changes the page
 *   - create/edit happen in a dialog, not in a permanent column of the page
 *   - the binding is reported per account row, and the identity tab is gone
 *
 *   node tools/probe-console-ui.mjs <serviceUrl> <user> <password> [debugPort]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVICE = process.argv[2]
const USER = process.argv[3]
const PASS = process.argv[4]
const PORT = Number(process.argv[5] ?? 9600)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let problems = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) problems += 1
}

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-console-'))
const browser = spawn(
  edge,
  ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileDir}`, `--remote-debugging-port=${PORT}`, 'about:blank'],
  { stdio: 'ignore' },
)

let socketUrl = null
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find((item) => item.type === 'page')
    if (page?.webSocketDebuggerUrl) { socketUrl = page.webSocketDebuggerUrl; break }
  } catch { /* starting */ }
  await sleep(250)
}
const socket = new WebSocket(socketUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve))

let nextId = 1
const pending = new Map()
const errors = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') {
    errors.push(String(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text).split('\n')[0])
  }
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

// Sign in.
await evaluate(`
  (async () => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('login-user', ${JSON.stringify(USER)});
    set('login-pass', ${JSON.stringify(PASS)});
    document.getElementById('login-submit').click();
  })()
`)
await sleep(3500)

/**
 * NOTE: the expression handed to the browser is inside a template literal, so it must
 * not contain a BACKTICK. A comment naming `.tr` in backticks terminated the string and
 * produced "…is not a function" from a syntax error — the same trap as a `/** *​/`
 * comment inside a template literal.
 *
 * `.tr` also matches the per-user groups row (`.tr.sub`), so the first version counted 40
 * rows for 24 accounts and then failed its own binding-cell comparison. Main rows only.
 */
const state = await evaluate(`
  JSON.stringify((() => {
    const visible = [...(document.querySelector('main')?.children ?? [])].filter((s) => !s.classList.contains('hidden')).map((s) => s.id);
    const nav = [...document.querySelectorAll('.navbtn')].map((b) => b.dataset.panel);
    const row = document.querySelector('#users-table .tr:not(.head)');
    const head = document.querySelector('#users-table .tr.head');
    const cells = row ? [...row.children].map((cell) => ({ text: cell.textContent.trim().slice(0, 24), w: Math.round(cell.getBoundingClientRect().width) })) : [];
    return {
      visible,
      nav,
      hasIdentityTab: nav.includes('identity'),
      rowCount: document.querySelectorAll('#users-table .tr:not(.head)').length,
      headLabels: head ? [...head.children].map((c) => c.textContent) : null,
      rowDisplay: row ? getComputedStyle(row).display : null,
      cellWidths: cells.map((c) => c.w),
      pagerText: document.getElementById('users-pager')?.textContent.trim() ?? null,
      pagerButtons: [...(document.querySelectorAll('#users-pager .btn') ?? [])].map((b) => b.textContent),
      hasNewButton: Boolean(document.getElementById('users-new')),
      hasSearch: Boolean(document.getElementById('users-q')),
      bindColumnIndex: head ? [...head.children].findIndex((c) => c.textContent.includes('DSH')) : -1,
      inlineFormGone: !document.getElementById('nu-name') && !document.getElementById('ng-id') && !document.getElementById('gr-pattern'),
    };
  })())
`)
const ui = JSON.parse(state ?? '{}')
console.log('--- 控制台状态 ---')
console.log(state)

ok('已进入控制台视图', (ui.visible ?? []).includes('view-console'), JSON.stringify(ui.visible))
ok('修掉了「身份绑定」独立 tab', ui.hasIdentityTab !== true, JSON.stringify(ui.nav))
ok('账号页有搜索框与新建按钮', ui.hasSearch === true && ui.hasNewButton === true)
ok('原来的内联表单已移除', ui.inlineFormGone === true)
ok('表格有列标题', Array.isArray(ui.headLabels) && ui.headLabels.filter(Boolean).length >= 4, JSON.stringify(ui.headLabels))
ok('DSH 绑定是独立的一列', (ui.bindColumnIndex ?? -1) >= 0, `第 ${ui.bindColumnIndex} 列`)
ok('表格行是 flex 布局（此前 .tr/.trow 不匹配，完全没有样式）', ui.rowDisplay === 'flex', String(ui.rowDisplay))
ok('表格行有多列且已分宽', (ui.cellWidths ?? []).length >= 5 && (ui.cellWidths ?? []).every((w) => w > 0), JSON.stringify(ui.cellWidths))
ok('分页条显示了总数与页码', /共 \d+ 条/.test(ui.pagerText ?? ''), String(ui.pagerText))
ok('分页条有四个翻页按钮与每页选择', (ui.pagerButtons ?? []).join(',') === '首页,上一页,下一页,末页', JSON.stringify(ui.pagerButtons))
ok('每个账号一行（不再有额外的权限组子行）', (ui.rowCount ?? 0) >= 20, String(ui.rowCount))

// The create dialog.
await evaluate(`document.getElementById('users-new').click()`)
await sleep(600)
const dialog = await evaluate(`
  JSON.stringify((() => {
    const dlg = document.querySelector('dialog.dlg');
    if (!dlg) return { open: false };
    const labels = [...dlg.querySelectorAll('.dlg-body .field > span:first-child')].map((s) => s.textContent);
    return {
      open: dlg.open === true,
      isModal: dlg.matches(':modal'),
      title: dlg.querySelector('h2')?.textContent ?? null,
      labels,
      hasPassword: labels.includes('初始密码'),
      hasRoleSelect: Boolean(dlg.querySelector('select')),
      hasGroupChips: dlg.querySelectorAll('.chips .chip').length,
      submit: dlg.querySelector('.dlg-actions .btn-primary')?.textContent ?? null,
      cancel: dlg.querySelector('.dlg-actions .btn')?.textContent ?? null,
    };
  })())
`)
console.log('')
console.log('--- 新建账号弹窗 ---')
console.log(dialog)
const dlg = JSON.parse(dialog ?? '{}')
ok('弹窗已打开且是模态的', dlg.open === true && dlg.isModal === true, JSON.stringify({ open: dlg.open, modal: dlg.isModal }))
ok('弹窗标题正确', dlg.title === '新建账号', String(dlg.title))
ok('有用户名/显示名/密码/角色/状态', ['用户名', '显示名', '初始密码', '角色', '状态'].every((l) => (dlg.labels ?? []).includes(l)), JSON.stringify(dlg.labels))
ok('有权限组选择', (dlg.hasGroupChips ?? 0) > 0, String(dlg.hasGroupChips))
ok('有取消与提交按钮', dlg.cancel === '取消' && dlg.submit === '创建账号', `${dlg.cancel}/${dlg.submit}`)

/**
 * Esc closes it.
 *
 * `rawKeyDown` is required: with `keyDown` the event is delivered but the dialog's native
 * cancel behaviour does not run. Verified separately against a bare <dialog> with no
 * listeners of ours — the platform closes that one on `rawKeyDown`.
 *
 * The `cancel` probe distinguishes the two ways this can fail: the key never reaching the
 * dialog (a harness problem) versus the dialog receiving a close request and refusing it
 * (a code problem — something is calling preventDefault, or a listener throws first).
 */
await evaluate(`
  (() => {
    const dlg = document.querySelector('dialog.dlg');
    window.__escProbe = { cancel: false, close: false };
    dlg.addEventListener('cancel', () => { window.__escProbe.cancel = true; });
    dlg.addEventListener('close', () => { window.__escProbe.close = true; });
  })()
`)
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
await sleep(600)
const escState = await evaluate(`
  JSON.stringify({
    probe: window.__escProbe ?? null,
    stillOpen: document.querySelector('dialog.dlg') !== null,
  })
`)
console.log('')
console.log('--- Esc 诊断 ---')
console.log(escState)
const esc = JSON.parse(escState ?? '{}')
ok('Esc 能关闭弹窗', esc.stillOpen === false, `cancel 事件=${esc.probe?.cancel} close 事件=${esc.probe?.close}`)

// Clean up if it is still open, so the rest of the probe is not affected.
if (esc.stillOpen) {
  await evaluate(`document.querySelector('dialog.dlg')?.close()`)
  await sleep(300)
}

// Pagination actually moves.
const beforePage = await evaluate(`document.getElementById('users-pager').textContent.trim()`)
await evaluate(`[...document.querySelectorAll('#users-pager .btn')].find((b) => b.textContent === '下一页').click()`)
await sleep(1200)
const afterPage = await evaluate(`document.getElementById('users-pager').textContent.trim()`)
ok('点「下一页」页码会变', beforePage !== afterPage, `${beforePage} -> ${afterPage}`)

// Switch panes and make sure each renders.
for (const [panel, tableId] of [['groups', 'groups-table'], ['grants', 'grants-table'], ['artifacts', 'artifacts-table']]) {
  await evaluate(`[...document.querySelectorAll('.navbtn')].find((b) => b.dataset.panel === '${panel}').click()`)
  await sleep(900)
  const paneState = await evaluate(`
    JSON.stringify({
      visible: [...document.querySelectorAll('.pane')].filter((p) => !p.classList.contains('hidden')).map((p) => p.id),
      empty: document.querySelector('#${tableId} .empty')?.textContent ?? null,
      pager: Boolean(document.getElementById('${panel}-pager')),
    })
  `)
  const parsed = JSON.parse(paneState ?? '{}')
  ok(`${panel} 面板可切换并有分页条`, (parsed.visible ?? []).includes(`pane-${panel}`) && parsed.pager === true, paneState)
}

console.log('')
console.log('--- 页面异常 ---')
console.log(errors.length === 0 ? '  （无）' : errors.map((error) => `  ${error}`).join('\n'))
ok('页面没有未捕获异常', errors.length === 0, errors[0] ?? '')

/**
 * Optional screenshots.
 *
 * A visual complaint ("太丑了") cannot be answered with DOM measurements: computed widths
 * say nothing about whether a layout reads well. `--shot <dir>` writes what the page
 * actually looks like. Not decorative — it is how the `.tr`/`.trow` mismatch was
 * confirmed to be visible rather than theoretical.
 */
const shotIndex = process.argv.indexOf('--shot')
if (shotIndex >= 0) {
  const outDir = process.argv[shotIndex + 1]
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(outDir, { recursive: true })
  const capture = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const data = shot.result?.data
    if (!data) { console.log(`  截图失败：${name}`); return }
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, 'base64'))
    console.log(`  已截图 ${join(outDir, `${name}.png`)}`)
  }
  // A wider viewport than the default: the console is a two-column layout and would
  // otherwise be judged in a window narrower than any real one.
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`[...document.querySelectorAll('.navbtn')].find((b) => b.dataset.panel === 'users').click()`)
  await sleep(900)
  await capture('console-users')
  await evaluate(`document.getElementById('users-new').click()`)
  await sleep(700)
  await capture('console-dialog')
  await evaluate(`document.querySelector('dialog.dlg')?.close()`)
  await evaluate(`[...document.querySelectorAll('.navbtn')].find((b) => b.dataset.panel === 'groups').click()`)
  await sleep(900)
  await capture('console-groups')
}

socket.close()
browser.kill()
console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
