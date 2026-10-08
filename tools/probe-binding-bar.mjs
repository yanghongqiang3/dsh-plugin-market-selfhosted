/**
 * Read the install page's binding bar in a signed-in state.
 *
 * The binding bar is the whole point of the manual-binding change, so "the code looks
 * right" is not enough — this reports what it actually renders, the button label, and
 * whether that button can be pressed.
 *
 *   node tools/probe-binding-bar.mjs <marketUrl> <token> [debugPort]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MARKET_URL = process.argv[2]
const TOKEN = process.argv[3]
const PORT = Number(process.argv[4] ?? 9480)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-bar-'))
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
  return result.result?.result?.value
}

await send('Runtime.enable')
await send('Page.enable')

const origin = new URL(MARKET_URL).origin
const serviceUrl = process.argv[5] ?? origin
// Plant the token the way a successful login would, on the page's own origin.
await send('Page.navigate', { url: `${origin}/market` })
await sleep(2500)
await evaluate(`
  localStorage.setItem('dsh.market.token', ${JSON.stringify(TOKEN)});
  localStorage.setItem('dsh.market.service', ${JSON.stringify(serviceUrl)});
  'primed'
`)
await send('Page.navigate', { url: `${origin}/market` })
await sleep(7000)

const report = await evaluate(`
  JSON.stringify((() => {
    const bar = document.getElementById('binding');
    const btn = bar?.querySelector('button');
    return {
      visible: [...(document.querySelector('main')?.children ?? [])]
        .filter((s) => !s.classList.contains('hidden')).map((s) => s.id),
      barText: bar?.textContent.trim() ?? null,
      buttonLabel: btn?.textContent ?? null,
      buttonEnabled: btn ? !btn.disabled : null,
      noteHasBinding: (document.getElementById('note')?.textContent ?? '').includes('DSH 账号'),
      cards: document.querySelectorAll('.card').length,
      status: document.getElementById('status')?.textContent ?? '',
    };
  })())
`)
console.log('--- 绑定条 ---')
console.log(report)

// With `--click`, actually press the button and report the result. A button that
// renders but does nothing is exactly the failure this project keeps producing.
if (process.argv.includes('--click')) {
  const clicked = await evaluate(`(async () => {
    const btn = document.getElementById('binding')?.querySelector('button');
    if (!btn) return 'no-button';
    if (btn.disabled) return 'disabled';
    btn.click();
    await new Promise((r) => setTimeout(r, 2500));
    const bar = document.getElementById('binding');
    return JSON.stringify({
      barText: bar?.textContent.trim() ?? null,
      buttonLabel: bar?.querySelector('button')?.textContent ?? null,
      buttonEnabled: bar?.querySelector('button') ? !bar.querySelector('button').disabled : null,
      status: document.getElementById('status')?.textContent ?? '',
    });
  })()`)
  console.log('--- 点击之后 ---')
  console.log(clicked)
}

console.log('--- 页面异常 ---')
console.log(errors.length === 0 ? '  （无）' : errors.map((e) => `  ${e}`).join('\n'))

socket.close()
browser.kill()
