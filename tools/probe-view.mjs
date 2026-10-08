/**
 * Open a URL in a headless browser and report which view is visible.
 *
 * Written for the console's "服务端未就绪" regression: fetching the HTML only proved
 * the page was SERVED, never that it decided the service was reachable. Which view
 * is on screen is the actual outcome, so that is what this reports.
 *
 *   node tools/probe-view.mjs <url> [debugPort]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_ = process.argv[2]
const PORT = Number(process.argv[3] ?? 9440)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-view-'))
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
const consoleLines = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') {
    errors.push(String(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text).split('\n')[0])
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    consoleLines.push(`[${message.params.type}] ${message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`)
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
await send('Log.enable')
console.log(`navigate ${URL_}`)
await send('Page.navigate', { url: URL_ })
await sleep(6000)

const expression = `JSON.stringify((() => {
  // Only the top-level views: the console nests <section class="pane"> inside its
  // main view, and a bare 'main section' query reported those as extra "views".
  const sections = [...(document.querySelector('main')?.children ?? [])];
  const visible = sections.filter((s) => !s.classList.contains('hidden')).map((s) => s.id);
  return {
    visibleViews: visible,
    who: document.getElementById('who')?.textContent ?? null,
    loginService: document.getElementById('login-service')?.textContent ?? null,
    deniedWho: document.getElementById('denied-who')?.textContent ?? null,
  };
})())`
const result = await send('Runtime.evaluate', { expression, returnByValue: true })
console.log('--- 页面状态 ---')
console.log(result.result?.result?.value ?? JSON.stringify(result))
console.log('--- 页面异常 ---')
console.log(errors.length === 0 ? '  （无）' : errors.map((e) => `  ${e}`).join('\n'))
if (consoleLines.length > 0) {
  console.log('--- console ---')
  for (const line of consoleLines.slice(-10)) console.log(`  ${line}`)
}

socket.close()
browser.kill()
