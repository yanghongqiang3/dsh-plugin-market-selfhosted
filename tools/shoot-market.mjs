/**
 * Capture the market page through the REAL chain, so the screenshots reflect
 * what an operator actually sees:
 *
 *   browser -> local plugin -> market service
 *
 * Boots the service on an ephemeral port, runs the host plugin against a
 * throwaway profile, and drives the page over CDP.
 *
 *   node tools/shoot-market.mjs <debugPort> [outDir]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createApp } from '../server/index.mjs'

const DEBUG_PORT = Number(process.argv[2] ?? 9360)
const OUT = resolve(process.argv[3] ?? 'preview/shots')
const LOCAL_PORT = 17980
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------------------ fixtures

const workDir = mkdtempSync(join(tmpdir(), 'dsh-market-shots-'))
const profileDir = join(workDir, 'profile')
mkdirSync(profileDir, { recursive: true })
writeFileSync(
  join(profileDir, 'package.json'),
  `${JSON.stringify({ name: 'dsh-profile', private: true, dsh: { profile: { bundles: ['dsh-base'] } } }, null, 2)}\n`,
)
writeFileSync(join(profileDir, 'cordis.patch.yml'), '# 运维自己的行\n')

function makePackage(name, version, summary, owner) {
  const dir = join(workDir, name.replace(/[@/]/g, '_'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name, version, description: summary, dsh: { market: { entry: `${name}/plugin`, owner } } }, null, 2)}\n`,
  )
  writeFileSync(join(dir, 'market.json'), `${JSON.stringify({ owner, summary }, null, 2)}\n`)
  writeFileSync(join(dir, 'lib', 'index.js'), 'export function apply() {}\n')
  writeFileSync(join(dir, 'README.md'), `# ${name}\n\n${summary}\n`)
  return dir
}

const app = createApp({ dbFile: join(workDir, 'market.db'), storageDir: join(workDir, 'storage') })
const { server, store, artifacts } = app
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const serviceUrl = `http://127.0.0.1:${server.address().port}`

const visible = artifacts.publishFromDirectory(
  makePackage('@dsh-internal/dsh-plugin-visible', '1.0.0', '注册 Host 工具 market_visible_probe，证明从市场安装的插件真的被加载', 'platform'),
  { publishedBy: 'cli' },
)
artifacts.publishFromDirectory(
  makePackage('@dsh-internal/dsh-plugin-e2e-test', '1.0.0', 'E2E 测试插件：验证「下载 → 校验 sha256 → 装入 profile → 插入 patch 行」整条链路', 'platform'),
  { publishedBy: 'cli' },
)
artifacts.publishFromDirectory(
  makePackage('@dsh-internal/dsh-plugin-calc', '0.3.0', '内部计算器工具集（示例：组内可见但对你未授权）', 'billing'),
  { publishedBy: 'cli' },
)

// bootstrap() already created `admin`; just settle its password for the shots.
store.setPassword('admin', 'admin-strong-password', { mustChange: false, by: 'shots' })
store.createGroup({ id: 'billing', name: 'billing', description: '计费组', by: 'shots' })
store.createUser({
  username: 'demo', password: 'demo-strong-password', displayName: '演示用户',
  mustChangePassword: false, createdBy: 'shots',
})
store.setMembership('demo', 'platform', true, { by: 'shots' })
store.addGrant({ groupId: 'platform', pluginPattern: '@dsh-internal/dsh-plugin-visible', by: 'shots' })
store.addGrant({ groupId: 'platform', pluginPattern: '@dsh-internal/dsh-plugin-e2e-test', by: 'shots' })
store.addGrant({ groupId: 'billing', pluginPattern: '@dsh-internal/dsh-plugin-calc', by: 'shots' })
store.addGrant({ groupId: 'platform', pluginPattern: '@dsh-internal/dsh-plugin-calc', effect: 'allow', by: 'shots' })

console.log(`service ${serviceUrl}`)
console.log(`profile ${profileDir}`)

const localServer = spawn(process.execPath, ['tools/serve-local.mjs', String(LOCAL_PORT)], {
  cwd: 'E:\\workspace\\dsh',
  env: { ...process.env, MARKET_SERVICE_URL: serviceUrl, DSH_PROFILE_DIR: profileDir, MARKET_DIAG_LOG: join(workDir, 'diag.log') },
})

for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${LOCAL_PORT}/dsh-market/config`)).ok) break
  } catch { /* starting */ }
  await sleep(200)
}

// ------------------------------------------------------------------ CDP glue

async function target() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* starting */ }
    await sleep(250)
  }
  throw new Error(`no debuggable page on ${DEBUG_PORT}`)
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
    const file = join(OUT, name)
    writeFileSync(file, Buffer.from(result.data, 'base64'))
    console.log(`wrote ${name} (${(await import('node:fs')).statSync(file).size} bytes)`)
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
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 860, deviceScaleFactor: 2, mobile: false })

async function settle(expression, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value
    try { value = await cdp.eval(expression) } catch { value = false }
    if (value) return true
    if (Date.now() > deadline) { console.warn(`warn: timed out waiting for ${label}`); return false }
    await sleep(120)
  }
}

const shown = (id) => `!document.getElementById('${id}').classList.contains('hidden')`
const goto = async (url) => { await cdp.send('Page.navigate', { url }); await sleep(1200) }

await goto(`http://127.0.0.1:${LOCAL_PORT}/market`)
await cdp.eval('localStorage.clear()')
await goto(`http://127.0.0.1:${LOCAL_PORT}/market`)
await settle(shown('view-login'), 'login view')
await cdp.shoot('market-login.png')

await cdp.eval(`
  document.getElementById('login-user').value = 'demo';
  document.getElementById('login-pass').value = 'demo-strong-password';
  document.getElementById('login-submit').click();
`)
await settle(shown('view-market'), 'market view')
await settle(`document.querySelectorAll('#grid .card').length > 0`, 'cards')
await cdp.shoot('market-cards-installable.png')

// Install one plugin so the same card can show the installed state.
await cdp.eval(`
  [...document.querySelectorAll('#grid .card')]
    .find((c) => c.querySelector('.name').textContent === '${visible.name}')
    .querySelector('button').click()
`)
await settle(
  `String(document.getElementById('status').textContent).includes('安装成功')`,
  'install finished',
  20000,
)
await settle(`document.querySelectorAll('#grid .card').length > 0`, 'cards re-rendered')
await cdp.shoot('market-cards-installed.png')

// Admin panel.
await cdp.eval(`document.getElementById('logout').click()`)
await settle(shown('view-login'), 'login view again')
await cdp.eval(`
  document.getElementById('login-user').value = 'admin';
  document.getElementById('login-pass').value = 'admin-strong-password';
  document.getElementById('login-submit').click();
`)
await settle(shown('view-market'), 'admin market view')
await cdp.eval(`document.querySelector('.tab[data-tab="admin"]').click()`)
await settle(`!document.getElementById('panel-admin').classList.contains('hidden')`, 'admin panel')
await settle(`document.querySelectorAll('#users-table .trow').length > 0`, 'admin tables')
await cdp.shoot('market-admin.png')

socket.close()
localServer.kill()
server.close()
