/**
 * Ask the running shell which client bundles it composed.
 *
 * `dsh-client-modules` holds a table keyed by package name; reading it beats
 * inferring from `<script src>` tags, which the runtime does not always add.
 *
 *   node tools/probe-client-bundles.mjs <pageUrl> <debugPort> [token]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PAGE_URL = process.argv[2] ?? 'http://127.0.0.1:3080/'
const PORT = Number(process.argv[3] ?? 9411)
const TOKEN = process.argv[4] ?? null
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-bundles-'))
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
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
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
await send('Page.navigate', { url })
await sleep(8000)

const expression = `JSON.stringify((() => {
  const out = { candidates: [], probes: [] };
  // Any global that looks like a client-module table.
  for (const key of Object.keys(globalThis)) {
    if (/client.?module|module.?table|dsh.?boot/i.test(key)) out.candidates.push(key);
  }
  const loader = globalThis.__ModuleLoader__;
  if (loader) out.loaderKeys = Object.keys(loader);
  // Registered module ids, if the facade exposes them.
  try {
    if (loader && loader.registry) out.registry = [...loader.registry.keys()];
    if (loader && loader.modules) out.modules = [...loader.modules.keys()];
  } catch (error) { out.readError = String(error.message) }
  // Bundle URLs actually present in the document.
  out.scripts = [...document.querySelectorAll('script')]
    .map((s) => s.src).filter(Boolean).filter((u) => u.includes('/plugins'));
  return out;
})())`
const result = await send('Runtime.evaluate', { expression, returnByValue: true })
console.log(result.result?.result?.value ?? JSON.stringify(result))
socket.close()
browser.kill()
