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
    socket.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(event.data) } catch { return }
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

const report = await cdp.eval(`
  (() => {
    const entry = document.getElementById('dsh-marketplace-entry');
    if (!entry) return JSON.stringify({ found: false });
    const r = entry.getBoundingClientRect();
    const sec = document.getElementById('workspace-section');
    const sr = sec ? sec.getBoundingClientRect() : null;

    // Every other sidebar row: the entry must not overlap any of them.
    const rows = [...document.querySelectorAll('.side .nav, .side .sec, .side .row')].map((el) => {
      const b = el.getBoundingClientRect();
      return { text: el.textContent.trim(), top: Math.round(b.top), bottom: Math.round(b.bottom) };
    });
    const overlaps = rows.filter((row) => r.top < row.bottom && r.bottom > row.top);

    return JSON.stringify({
      found: true,
      entry: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) },
      workspaceSection: sr ? { top: Math.round(sr.top), bottom: Math.round(sr.bottom) } : null,
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
ok('入口被放置（data-placed）', parsed.found === true)
ok('没有压在其它侧边栏行上', (parsed.overlaps ?? []).length === 0, (parsed.overlaps ?? []).join(', '))
ok('在上一行下方留有空隙', (parsed.gapBelowLastRow ?? -1) > 0, `gap=${parsed.gapBelowLastRow}`)
ok('落在左栏范围内', (parsed.entry?.left ?? 999) < 140, `left=${parsed.entry?.left}`)
ok('在侧边栏底部区域内', (parsed.entry?.bottom ?? 0) < 700, `bottom=${parsed.entry?.bottom}`)

await cdp.shoot('entry-sidebar.png')

console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
socket.close()
server.kill()
process.exit(problems ? 1 : 0)
