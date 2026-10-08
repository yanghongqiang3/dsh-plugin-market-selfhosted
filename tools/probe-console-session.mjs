/**
 * Sign a session into the console and report which view it lands on.
 *
 * `probe-view.mjs` proves the login screen renders; it cannot prove that a signed-in
 * administrator reaches the console, because the token lives in localStorage and
 * must be present before the page boots. This primes it, then reloads.
 *
 * The regression this exists for: the console read a boolean `isAdmin` the service
 * never sends (it sends `role: 'admin' | 'member'`), so the real administrator was
 * always sent to 「需要管理员权限」.
 *
 *   node tools/probe-console-session.mjs <consoleUrl> <token> [debugPort]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CONSOLE_URL = process.argv[2] ?? 'http://127.0.0.1:8787/console'
const TOKEN = process.argv[3]
const PORT = Number(process.argv[4] ?? 9450)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (!TOKEN) {
  console.error('usage: node tools/probe-console-session.mjs <consoleUrl> <token> [port]')
  process.exit(1)
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
  if (result.result?.exceptionDetails) return { threw: result.result.exceptionDetails.exception?.description }
  return result.result?.result?.value
}

await send('Runtime.enable')
await send('Page.enable')

// Land on the origin once so localStorage is writable for it, then plant the token
// exactly the way a successful login would, and reload into a real boot.
const origin = new URL(CONSOLE_URL).origin
await send('Page.navigate', { url: `${origin}/console` })
await sleep(3000)
const primed = await evaluate(`
  localStorage.setItem('dsh.market.token', ${JSON.stringify(TOKEN)});
  localStorage.setItem('dsh.market.service', ${JSON.stringify(origin)});
  document.getElementById('view-login')?.id ?? 'no-login-view'
`)
console.log(`primed: ${JSON.stringify(primed)}`)

await send('Page.navigate', { url: `${origin}/console` })
await sleep(7000)

const report = await evaluate(`
  JSON.stringify((() => {
    const sections = [...(document.querySelector('main')?.children ?? [])];
    return {
      visibleViews: sections.filter((s) => !s.classList.contains('hidden')).map((s) => s.id),
      who: document.getElementById('who')?.textContent ?? null,
      deniedWho: document.getElementById('denied-who')?.textContent ?? null,
      userRows: document.querySelectorAll('#users-table .tr').length,
      paneNav: [...document.querySelectorAll('.navbtn')].map((b) => b.textContent.trim()),
    };
  })())
`)
console.log('--- 控制台状态 ---')
console.log(report)
console.log('--- 页面异常 ---')
console.log(errors.length === 0 ? '  （无）' : errors.map((e) => `  ${e}`).join('\n'))

socket.close()
browser.kill()
