/**
 * Render the injected shell entry against a sidebar-shaped skeleton and measure
 * where it lands, so its placement can be judged (and regressions caught) without
 * restarting the desktop app.
 *
 *   node tools/shoot-entry.mjs <debugPort> [outDir]
 *
 * Boots tools/serve-local.mjs, loads the skeleton with the real taps applied, and
 * screenshots it.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PORT = Number(process.argv[2] ?? 9377)
const OUT = resolve(process.argv[3] ?? 'preview/shots')
const LOCAL_PORT = 17997
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const server = spawn(process.execPath, ['tools/serve-local.mjs', String(LOCAL_PORT)], {
  cwd: 'E:\\workspace\\dsh',
  env: { ...process.env, MARKET_SERVICE_URL: 'http://127.0.0.1:8787' },
})

async function target() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* starting */
    }
    await sleep(250)
  }
  throw new Error(`no debuggable page on ${PORT}`)
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    /** Page-side errors, so a throwing injected script cannot stay invisible. */
    this.errors = []
    socket.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (message.method === 'Runtime.exceptionThrown') {
        const d = message.params.exceptionDetails
        this.errors.push(`${d.text} ${d.exception?.description ?? ''}`.trim())
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.errors.push(
          message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '),
        )
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      }
    })
  }
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)) }, 20000)
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'page threw')
    return result.result?.value
  }
  async shoot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' })
    mkdirSync(OUT, { recursive: true })
    writeFileSync(join(OUT, name), Buffer.from(result.data, 'base64'))
    console.log(`wrote ${name}`)
  }
}

const socket = new WebSocket(await target())
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', () => reject(new Error('websocket failed')))
})
const cdp = new Cdp(socket)
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 620, deviceScaleFactor: 2, mobile: false })

await cdp.send('Page.navigate', { url: `http://127.0.0.1:${LOCAL_PORT}/?shell=sidebar` })
await sleep(1500)

// The real shell always carries `body.chrome` — the page adds it on seeing
// `globalThis.dshDesktopBoot` — and it reserves the window-control strip. Without
// it this mock's content sits 40px higher, which changes which slot fits and made
// an earlier run fail for the wrong reason.
await cdp.eval(`document.body.classList.add('chrome')`)
await sleep(300)

console.log('--- 页面异常 ---')
if (cdp.errors.length === 0) console.log('  （无）')
else for (const line of cdp.errors) console.log('  ' + line)
console.log('')

const report = await cdp.eval(`
  (() => {
    const entry = document.getElementById('dsh-marketplace-entry');
    if (!entry) return JSON.stringify({ found: false });
    const r = entry.getBoundingClientRect();
    const sec = document.getElementById('workspace-section');
    const sr = sec ? sec.getBoundingClientRect() : null;
    const side = document.querySelector('.side');
    const foot = document.querySelector('.side .foot');
    const fr = foot ? foot.getBoundingClientRect() : null;
    const sideR = side ? side.getBoundingClientRect() : null;

    // Every other sidebar row: the entry must not overlap any of them.
    const rows = [...document.querySelectorAll('.side .nav, .side .sec, .side .row')].map((el) => {
      const b = el.getBoundingClientRect();
      return { text: el.textContent.trim(), top: Math.round(b.top), bottom: Math.round(b.bottom) };
    });
    const overlaps = rows.filter((row) => r.top < row.bottom && r.bottom > row.top);

    return JSON.stringify({
      found: true,
      entry: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) },
      workspaceSection: sr ? { top: Math.round(sr.top), bottom: Math.round(sr.bottom), left: Math.round(sr.left), right: Math.round(sr.right) } : null,
      side: sideR ? { top: Math.round(sideR.top), bottom: Math.round(sideR.bottom), left: Math.round(sideR.left), right: Math.round(sideR.right) } : null,
      foot: fr ? { top: Math.round(fr.top), bottom: Math.round(fr.bottom) } : null,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      debug: globalThis.__MARKET_ENTRY_DEBUG__ ?? null,
      placed: entry.hasAttribute('data-placed'),
      inlineTop: entry.style.top,
      rows,
      overlaps: overlaps.map((row) => row.text),
      gapAboveHeading: sr ? Math.round(sr.top - r.bottom) : null,
      gapBelowLastRow: (() => {
        const above = rows.filter((row) => row.bottom <= r.top).sort((a, b) => b.bottom - a.bottom)[0];
        return above ? Math.round(r.top - above.bottom) : null;
      })(),
      style: { position: getComputedStyle(entry).position, display: getComputedStyle(entry).display },
    }, null, 2);
  })()
`)
console.log(report)

const parsed = JSON.parse(String(report))
let problems = 0
const ok = (label, condition, extra = '') => {
  if (condition) console.log(`ok    ${label}${extra ? `  ${extra}` : ''}`)
  else {
    problems += 1
    console.error(`FAIL  ${label}${extra ? `  ${extra}` : ''}`)
  }
}

console.log('')
// Visibility is asserted first and separately: an earlier version of this check
// reported "placed" for an element that was `display:none`, and a hidden entry is
// indistinguishable from a broken plugin.
ok('入口可见（display 不为 none）', parsed.style?.display === 'flex', `display=${parsed.style?.display}`)
ok('入口已测量到尺寸', (parsed.entry?.height ?? 0) > 0, `height=${parsed.entry?.height}`)
ok('没有压在其它侧边栏行上', (parsed.overlaps ?? []).length === 0, (parsed.overlaps ?? []).join(', '))
ok('落在左栏范围内', (parsed.entry?.left ?? 999) < 140, `left=${parsed.entry?.left}`)
ok('完整落在窗口内', (parsed.entry?.bottom ?? 9999) <= 620, `bottom=${parsed.entry?.bottom}`)

// The measured slot is preferred but not required: when the sidebar cannot be
// measured (collapsed, or markup changed) the entry falls back to a fixed slot
// rather than disappearing, so this is reported rather than asserted.
console.log('')
const debug = parsed.debug ?? null
if (debug === null || debug.headingFound === false) {
  console.log('note  未测得「工作区」标题，入口使用兜底位置')
} else {
  console.log(`note  已测得：lastRow=${debug.lastRow} footTop=${debug.footTop} 选中=${debug.chosen}`)
  ok('在上一行下方留有空隙', (parsed.gapBelowLastRow ?? -1) >= 0, `gap=${parsed.gapBelowLastRow}`)
}

await cdp.shoot('entry-sidebar.png')

console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
socket.close()
server.kill()
process.exit(problems ? 1 : 0)


