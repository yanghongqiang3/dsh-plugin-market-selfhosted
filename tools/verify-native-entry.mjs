/**
 * Verify the native sidebar entry renders in the live page.
 *
 * The boot wire listing the package only proves the bundle was COMPOSED. Whether the
 * slot registration actually produced a visible control is a separate question, and
 * exactly the one the docs say installation alone does not answer.
 *
 *   node tools/verify-native-entry.mjs <pageUrl> <debugPort> <token>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PAGE_URL = process.argv[2] ?? 'http://127.0.0.1:3080/'
const PORT = Number(process.argv[3] ?? 9420)
const TOKEN = process.argv[4] ?? ''
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-native-'))
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
    const d = message.params.exceptionDetails
    errors.push(`${d.text} ${d.exception?.description ?? ''}`.trim())
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    errors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
  }
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
})
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params }))
})

await send('Runtime.enable')
await send('Page.enable')
const url = TOKEN ? `${PAGE_URL}${PAGE_URL.includes('?') ? '&' : '?'}token=${TOKEN}` : PAGE_URL
console.log(`navigate ${url}`)
await send('Page.navigate', { url })
await sleep(9000)

const expression = `JSON.stringify((() => {
  const label = '内部插件市场';
  const byTitle = [...document.querySelectorAll('button')].filter((b) => b.getAttribute('title') === label);
  const all = [...document.querySelectorAll('button')].map((b) => ({
    title: b.getAttribute('title'),
    text: (b.textContent || '').trim().slice(0, 20),
    parent: String(b.parentElement?.className || '').slice(0, 40),
  })).filter((b) => b.title || b.text.includes('插件'));
  const side = document.querySelector('aside, [class*=sidebarCol]');
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
  return {
    nativeButtons: byTitle.map((b) => ({ text: (b.textContent || '').trim().slice(0, 20), ...rect(b) })),
    injectedEntry: (() => {
      const el = document.getElementById('dsh-marketplace-entry');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { display: getComputedStyle(el).display, ...rect(el) };
    })(),
    sidebar: side ? rect(side) : null,
    pluginishButtons: all,
  };
})())`

const result = await send('Runtime.evaluate', { expression, returnByValue: true })
const value = result.result?.result?.value
console.log('--- 页面状态 ---')
console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1))
console.log('')
console.log('--- 页面异常 ---')
if (errors.length === 0) console.log('  （无）')
else for (const line of errors) console.log('  ' + line)

socket.close()
browser.kill()
