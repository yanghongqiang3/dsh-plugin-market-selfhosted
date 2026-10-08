/**
 * Render the market page as it appears inside the desktop shell, and CHECK that
 * the desktop window controls are not obstructed.
 *
 * Why this exists. The shell window is frameless (titleBarStyle: "hidden") and
 * Electron paints its minimise/maximise/close overlay ON TOP of the renderer
 * (`titleBarOverlay: { height: 40 }` on win32). Two things went wrong in
 * production because of that:
 *
 *   1. the page's own header sat in the top 40px, under the buttons;
 *   2. a drag region (`-webkit-app-region: drag`) spanning the whole strip
 *      swallowed the close button's click, collapsing the whole DSH window.
 *
 * So the strip is reserved for the page's content, and the drag region stops
 * short of the controls' corner.
 *
 *   node tools/shoot-titlebar.mjs <baseUrl> <debugPort> [outDir]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:17995').replace(/\/+$/, '')
const PORT = Number(process.argv[3] ?? 9370)
const OUT = resolve(process.argv[4] ?? 'preview/shots')

/** Typical desktop window, and the overlay geometry Electron uses on win32. */
const VIEWPORT = { width: 1280, height: 720 }
const STRIP_HEIGHT = 40
/** Windows caption buttons: 138 DIP at 100% scaling, wider on high-DPI displays. */
const CONTROLS_WIDTH = 180

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let problems = 0
const ok = (label, condition, extra = '') => {
  if (condition) console.log(`ok    ${label}${extra ? `  ${extra}` : ''}`)
  else {
    problems += 1
    console.error(`FAIL  ${label}${extra ? `  ${extra}` : ''}`)
  }
}

async function target() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* still starting */
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
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: VIEWPORT.width,
  height: VIEWPORT.height,
  deviceScaleFactor: 1,
  mobile: false,
})

await cdp.send('Page.navigate', { url: `${BASE}/market` })
await sleep(1500)

// The window-control strip is only reserved inside the shell; pretend to be it.
await cdp.eval(`document.body.classList.add('chrome')`)

// Drive the page into the market view: the top-right buttons only exist there,
// and THEY are what used to collide with the window controls.
await cdp.eval(`
  (async () => {
    for (const id of ['view-login','view-password','view-activate','viewNoService','view-noService']) {
      document.getElementById(id)?.classList.add('hidden');
    }
    document.getElementById('view-market')?.classList.remove('hidden');
    document.getElementById('refresh')?.classList.remove('hidden');
    document.getElementById('logout')?.classList.remove('hidden');
    const who = document.getElementById('who');
    if (who) who.textContent = '几何检查';
  })()
`)
await sleep(300)

// ------------------------------------------------------------- hit testing
//
// Run BEFORE injecting any visual marker: `elementFromPoint` skips
// `pointer-events:none` elements, so a marker would hide what is being measured.
const hitRaw = await cdp.eval(`
  (() => {
    const W = ${VIEWPORT.width};
    const at = (x, y) => {
      const el = document.elementFromPoint(x, y);
      if (el === null) return { x, y, hit: null };
      return { x, y, hit: el.tagName + (el.className ? '.' + String(el.className).trim().split(/\\s+/).join('.') : '') };
    };
    const controlsCorner = [];
    for (const fraction of [0.2, 0.5, 0.8]) {
      const x = Math.round(W - ${CONTROLS_WIDTH} + ${CONTROLS_WIDTH} * fraction);
      for (const y of [10, 20, 30]) controlsCorner.push(at(x, y));
    }
    const dragStrip = [80, 600, 1000].map((x) => at(x, 20));
    const bar = document.querySelector('.chromebar');
    const rect = bar ? bar.getBoundingClientRect() : null;
    return JSON.stringify({
      controlsCorner,
      dragStrip,
      dragRegion: rect ? { left: Math.round(rect.left), right: Math.round(rect.right), height: Math.round(rect.height) } : null,
      bodyPaddingTop: getComputedStyle(document.body).paddingTop,
    });
  })()
`)
const hit = JSON.parse(String(hitRaw))
console.log(`拖动条范围: ${JSON.stringify(hit.dragRegion)}   body padding-top: ${hit.bodyPaddingTop}`)
console.log('')

// 1. The DRAGGABLE element must not reach the controls.
//
// Checking for "any element" would be wrong: `elementFromPoint` legitimately
// returns the document body over the controls' corner, and the body carries no
// `-webkit-app-region`, so it cannot swallow the click. What would swallow it is
// a drag region covering that corner — so that is what gets asserted.
const claimed = hit.controlsCorner.filter((point) => String(point.hit ?? '').includes('chromebar'))
ok(
  `拖动条未覆盖窗口控件角（${hit.controlsCorner.length} 个命中点）`,
  claimed.length === 0,
  claimed.length === 0 ? '' : `被拖动条覆盖: ${claimed.map((p) => `(${p.x},${p.y})`).join(' ')}`,
)
ok(
  '控件角的其他命中均属于文档背景（不可拖拽）',
  hit.controlsCorner.every((point) => point.hit === null || !String(point.hit).includes('chromebar')),
  [...new Set(hit.controlsCorner.map((p) => String(p.hit)))].join(', '),
)

// 2. The drag region must stop before the controls, or it cannot swallow them.
const dragRight = hit.dragRegion?.right ?? 0
ok(
  '拖动条右边界在控件区之外',
  dragRight <= VIEWPORT.width - CONTROLS_WIDTH + 1,
  `right=${dragRight} 控件起点=${VIEWPORT.width - CONTROLS_WIDTH}`,
)
ok('拖动条覆盖了标题栏高度', (hit.dragRegion?.height ?? 0) === STRIP_HEIGHT, String(hit.dragRegion?.height))

// 3. The strip left of the controls should be draggable (claimed by .chromebar).
const dragOk = hit.dragStrip.filter((point) => String(point.hit ?? '').includes('chromebar'))
ok(
  '控件左侧的条带可拖动',
  dragOk.length === hit.dragStrip.length,
  `${dragOk.length}/${hit.dragStrip.length} 由 .chromebar 认领`,
)

// ------------------------------------------------------------- layout boxes
const layoutRaw = await cdp.eval(`
  (() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return { hidden: true };
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
    };
    return JSON.stringify({
      header: box(document.querySelector('header')),
      title: box(document.querySelector('header h1')),
      refresh: box(document.getElementById('refresh')),
      logout: box(document.getElementById('logout')),
      who: box(document.getElementById('who')),
    });
  })()
`)
const layout = JSON.parse(String(layoutRaw))
console.log('')
console.log('布局:', JSON.stringify(layout, null, 2))
console.log('')

const inStrip = (b) => b && !b.hidden && b.top < STRIP_HEIGHT
const underControls = (b) =>
  b && !b.hidden && b.top < STRIP_HEIGHT && b.right > VIEWPORT.width - CONTROLS_WIDTH

for (const [name, box] of [
  ['header', layout.header],
  ['标题', layout.title],
]) {
  if (!box || box.hidden) ok(`${name} 已渲染`, false, '未渲染，无法判定')
  else ok(`${name} 避开控件条`, !inStrip(box), `top=${box.top}`)
}
for (const [name, box] of [
  ['「刷新目录」', layout.refresh],
  ['「退出」', layout.logout],
  ['身份文字', layout.who],
]) {
  if (!box || box.hidden) ok(`${name} 已渲染`, false, '未渲染，无法判定')
  else ok(`${name} 避开控件角`, !underControls(box), `top=${box.top} right=${box.right}`)
}

// --------------------------------------------------------- visual reference
await cdp.eval(`
  const mark = document.createElement('div');
  mark.style.cssText = 'position:fixed;top:0;left:0;right:0;height:${STRIP_HEIGHT}px;z-index:2147483646;' +
    'background:rgba(255,0,0,.20);border-bottom:1px dashed rgba(255,0,0,.85);pointer-events:none;' +
    'font:11px/${STRIP_HEIGHT}px system-ui;color:#b00;padding-left:10px';
  mark.textContent = '↑ 这 ${STRIP_HEIGHT}px 被窗口控件覆盖（titleBarOverlay height:${STRIP_HEIGHT}）';
  document.body.appendChild(mark);

  const btns = document.createElement('div');
  btns.style.cssText = 'position:fixed;top:0;right:0;height:${STRIP_HEIGHT}px;width:${CONTROLS_WIDTH}px;z-index:2147483647;' +
    'display:flex;pointer-events:none;background:rgba(0,0,255,.18);border-left:1px dashed rgba(0,0,255,.8)';
  for (const glyph of ['\\u2500', '\\u25A1', '\\u2715']) {
    const b = document.createElement('div');
    b.textContent = glyph;
    b.style.cssText = 'flex:1;text-align:center;font:14px/${STRIP_HEIGHT}px system-ui;color:#0044cc';
    btns.appendChild(b);
  }
  document.body.appendChild(btns);
`)
await sleep(300)
await cdp.shoot('market-titlebar-ok.png')

console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
socket.close()
process.exit(problems ? 1 : 0)
