/**
 * Read the browser half's own record of why a client row failed.
 *
 * The host prints only "N entry did not activate …: failed to import". The real
 * error (and the row state) lives in the running page, reachable through the
 * loader facades the shell installs on `globalThis`.
 *
 *   node tools/probe-page-boot.mjs <pageUrl> <debugPort> [token]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PAGE_URL = process.argv[2] ?? 'http://127.0.0.1:3080/'
const PORT = Number(process.argv[3] ?? 9380)
const TOKEN = process.argv[4] ?? null
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
const browser = spawn(
  edge,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${PORT}`,
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
)

async function target() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* starting */
    }
    await sleep(250)
  }
  throw new Error('no debuggable page')
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.console = []
    socket.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = (message.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? arg.type)
          .join(' ')
        this.console.push(`[${message.params.type}] ${text}`)
      }
      if (message.method === 'Log.entryAdded') {
        this.console.push(`[log:${message.params.entry.level}] ${message.params.entry.text}`)
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
    if (result.exceptionDetails) {
      return { threw: result.exceptionDetails.exception?.description ?? 'page threw' }
    }
    return result.result?.value
  }
}

const socket = new WebSocket(await target())
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', () => reject(new Error('ws failed')))
})
const cdp = new Cdp(socket)
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
await cdp.send('Page.enable')

const url = TOKEN ? `${PAGE_URL}${PAGE_URL.includes('?') ? '&' : '?'}token=${TOKEN}` : PAGE_URL
console.log(`navigate ${url}`)
await cdp.send('Page.navigate', { url })
await sleep(6000)

const state = await cdp.eval(`
  (() => {
    const g = globalThis;
    const boot = g.__DSH_BOOT__;
    const loader = g.__ModuleLoader__;
    const out = {
      hasBoot: boot !== undefined,
      bootKeys: boot ? Object.keys(boot) : null,
      hasLoader: loader !== undefined,
      loaderKeys: loader ? Object.keys(loader) : null,
      entries: [],
      importErrors: null,
    };
    try {
      if (loader && loader.imports) out.importErrors = String(loader.imports);
    } catch (error) { out.importErrors = 'read failed: ' + error.message; }
    return JSON.stringify(out, null, 2);
  })()
`)
console.log('--- 页面状态 ---')
console.log(typeof state === 'string' ? state : JSON.stringify(state, null, 2))

// The shell's boot failed loudly, so its own error is likely in the console too.
console.log('')
console.log('--- 控制台输出 ---')
for (const line of cdp.console.slice(-40)) console.log('  ' + line)

socket.close()
browser.kill()
