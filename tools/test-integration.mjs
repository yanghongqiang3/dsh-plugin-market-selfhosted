/**
 * Integration test: the REAL chain, end to end.
 *
 *   browser page  ->  local plugin (this machine)  ->  market service
 *                                     |
 *                                     +-> writes the DSH profile
 *
 * It boots the real market service in-process on an ephemeral port, runs the real
 * host plugin against a throwaway profile via tools/serve-local.mjs, and drives
 * everything from a real browser over CDP. The assertion that matters is the last
 * one: after clicking 安装, the throwaway profile's package.json and patch layer
 * must actually contain the plugin — proof the download+verify+extract+register
 * chain ran, not merely that some HTTP call returned 200.
 *
 *   node tools/test-integration.mjs <edgeDebugPort>
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/index.mjs'

const DEBUG_PORT = Number(process.argv[2] ?? 9350)
const LOCAL_PORT = 17970
let problems = 0
const ok = (label, condition, extra = '') => {
  if (condition) console.log(`ok    ${label}${extra ? `  ${extra}` : ''}`)
  else {
    problems += 1
    console.error(`FAIL  ${label}${extra ? `  ${extra}` : ''}`)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- fixtures

const workDir = mkdtempSync(join(tmpdir(), 'dsh-market-integration-'))
const profileDir = join(workDir, 'profile')
mkdirSync(profileDir, { recursive: true })
// A profile with operator-authored content, to prove their patch layer survives.
writeFileSync(
  join(profileDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'dsh-profile',
      private: true,
      dependencies: { 'some-official-plugin': '^1.0.0' },
      dsh: { profile: { bundles: ['dsh-base'] } },
    },
    null,
    2,
  )}\n`,
)
const OPERATOR_PATCH = `# operator row, must survive byte for byte
- insert:
    - id: operator-choice
      name: '@official/plugin'
`
writeFileSync(join(profileDir, 'cordis.patch.yml'), OPERATOR_PATCH)

// One plugin package, published to the service.
const pkgDir = join(workDir, 'dsh-plugin-integration')
mkdirSync(join(pkgDir, 'lib'), { recursive: true })
writeFileSync(
  join(pkgDir, 'package.json'),
  `${JSON.stringify(
    {
      name: '@dsh-internal/dsh-plugin-integration',
      version: '2.0.0',
      description: '联调用的插件',
      dsh: { market: { entry: '@dsh-internal/dsh-plugin-integration/plugin' } },
    },
    null,
    2,
  )}\n`,
)
writeFileSync(join(pkgDir, 'lib', 'index.js'), 'export function apply() {}\n')
writeFileSync(join(pkgDir, 'README.md'), '# integration fixture\n')

const app = createApp({ dbFile: join(workDir, 'market.db'), storageDir: join(workDir, 'storage') })
const { server, store, artifacts } = app
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const serviceUrl = `http://127.0.0.1:${server.address().port}`

const published = artifacts.publishFromDirectory(pkgDir, { publishedBy: 'test' })
// bootstrap() already created the `platform` group.
store.createUser({
  username: 'alice',
  password: 'alice-strong-password',
  displayName: '爱丽丝',
  mustChangePassword: false,
  createdBy: 'test',
})
store.setMembership('alice', 'platform', true, { by: 'test' })
store.addGrant({ groupId: 'platform', pluginPattern: '@dsh-internal/*', by: 'test' })

console.log(`service   ${serviceUrl}`)
console.log(`provider  ${published.name}@${published.version} sha256=${published.sha256.slice(0, 16)}…`)
console.log(`profile   ${profileDir}\n`)

// ------------------------------------------------------- local plugin process

const localServer = spawn(
  process.execPath,
  ['tools/serve-local.mjs', String(LOCAL_PORT)],
  {
    cwd: 'E:\\workspace\\dsh',
    env: {
      ...process.env,
      MARKET_SERVICE_URL: serviceUrl,
      DSH_PROFILE_DIR: profileDir,
      MARKET_DIAG_LOG: join(workDir, 'diag.log'),
    },
  },
)

async function waitForLocal() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${LOCAL_PORT}/dsh-market/config`)
      if (response.ok) return await response.json()
    } catch {
      /* still starting */
    }
    await sleep(200)
  }
  throw new Error('local plugin did not come up')
}

const config = await waitForLocal()
ok('本地插件报告了服务端地址', config.serviceUrl === serviceUrl, String(config.serviceUrl))
ok('本地插件报告 configured=true', config.configured === true)
ok('本地插件报告的是测试 profile', config.profileDir === profileDir, String(config.profileDir))

// ------------------------------------------------------------------ CDP glue

async function debugTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* browser still starting */
    }
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
}

const socket = new WebSocket(await debugTarget())
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', () => reject(new Error('websocket failed')))
})
const cdp = new Cdp(socket)
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')

async function waitFor(expression, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value
    try { value = await cdp.eval(expression) } catch { value = false }
    if (value) return true
    if (Date.now() > deadline) {
      console.error(`FAIL  timed out waiting for ${label}`)
      problems += 1
      return false
    }
    await sleep(120)
  }
}

const visible = (id) => `!document.getElementById('${id}').classList.contains('hidden')`

console.log('--- 浏览器：登录 ---')
await cdp.send('Page.navigate', { url: `http://127.0.0.1:${LOCAL_PORT}/market` })
await sleep(1200)
await cdp.eval('localStorage.clear()')
await cdp.send('Page.navigate', { url: `http://127.0.0.1:${LOCAL_PORT}/market` })
await waitFor(visible('view-login'), 'login view')
ok('页面显示登录界面（说明已读到服务端地址）', (await cdp.eval(visible('view-login'))) === true)
ok(
  '登录页标注了服务端',
  String(await cdp.eval(`document.getElementById('login-service').textContent`)).includes(serviceUrl),
  String(await cdp.eval(`document.getElementById('login-service').textContent`)),
)

await cdp.eval(`
  document.getElementById('login-user').value = 'alice';
  document.getElementById('login-pass').value = 'alice-strong-password';
  document.getElementById('login-submit').click();
`)
await waitFor(visible('view-market'), 'market view')
ok('登录后进入市场', (await cdp.eval(visible('view-market'))) === true)

await waitFor(`document.querySelectorAll('#grid .card').length > 0`, 'catalog cards')
const cards = JSON.parse(String(await cdp.eval(`
  JSON.stringify([...document.querySelectorAll('#grid .card')].map((card) => ({
    name: card.querySelector('.name').textContent,
    install: card.querySelector('button').textContent,
  })))
`)))
ok('目录里出现了服务端的插件', cards.some((card) => card.name === published.name), JSON.stringify(cards))
ok('该插件对 alice 可安装', cards.find((card) => card.name === published.name)?.install === '安装')

console.log('\n--- 浏览器：点击安装 ---')
await cdp.eval(`
  [...document.querySelectorAll('#grid .card')]
    .find((card) => card.querySelector('.name').textContent === '${published.name}')
    .querySelector('button').click()
`)
await waitFor(
  `String(document.getElementById('status').textContent).includes('安装成功') || document.getElementById('status').classList.contains('error')`,
  'install outcome',
  20000,
)
const installStatus = String(await cdp.eval(`document.getElementById('status').textContent`))
ok('页面报告安装成功', installStatus.includes('安装成功'), JSON.stringify(installStatus.slice(0, 200)))
ok('页面报告哈希校验通过', installStatus.includes('sha256 校验：通过'))

console.log('\n--- 本机 profile 的实际结果（唯一有说服力的断言）---')
const targetDir = join(profileDir, 'node_modules', ...published.name.split('/'))
ok('插件目录已创建', existsSync(targetDir), targetDir)
ok('package.json 已落盘', existsSync(join(targetDir, 'package.json')))
ok('lib/index.js 已解包', existsSync(join(targetDir, 'lib', 'index.js')))
ok(
  '解包内容与发布内容一致',
  existsSync(join(targetDir, 'lib', 'index.js')) &&
    readFileSync(join(targetDir, 'lib', 'index.js'), 'utf8') === 'export function apply() {}\n',
)

const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
ok('profile 记录了依赖关系', Boolean(profileManifest.dependencies?.[published.name]), String(profileManifest.dependencies?.[published.name]))
ok('profile 保留了原有依赖', profileManifest.dependencies?.['some-official-plugin'] === '^1.0.0')
ok('profile 保留了原有 bundles', JSON.stringify(profileManifest.dsh?.profile?.bundles) === '["dsh-base"]')

const patchText = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
ok('patch 层写入了托管行', patchText.includes('dsh-plugin-marketplace managed rows'), patchText.split('\n')[0])
ok('托管行指向插件的入口子路径', patchText.includes(`${published.name}/plugin`), '')
ok(
  '运维人员自己的 patch 内容逐字节保留',
  patchText.includes(OPERATOR_PATCH.trim()),
  JSON.stringify(patchText.slice(0, 120)),
)

console.log('\n--- 浏览器：卸载（入口在卡片上）---')
// The card itself carries the state: after installing, the same card must offer
// 卸载 instead of 安装. No separate "installed" list exists.
const cardsAfterInstall = JSON.parse(String(await cdp.eval(`
  JSON.stringify([...document.querySelectorAll('#grid .card')].map((card) => ({
    name: card.querySelector('.name').textContent,
    buttons: [...card.querySelectorAll('button')].map((b) => b.textContent),
    tags: [...card.querySelectorAll('.tag')].map((t) => t.textContent),
  })))
`)))
const installedCard = cardsAfterInstall.find((card) => card.name === published.name)
ok('安装后卡片显示「已安装到本机」', installedCard?.tags?.includes('已安装到本机') === true, JSON.stringify(installedCard?.tags))
ok('安装后卡片提供「卸载」而不是「安装」',
  installedCard?.buttons?.includes('卸载') === true && !installedCard?.buttons?.includes('安装'),
  JSON.stringify(installedCard?.buttons))

await cdp.eval(`
  [...document.querySelectorAll('#grid .card')]
    .find((card) => card.querySelector('.name').textContent === '${published.name}')
    .querySelector('button').click()
`)
await waitFor(
  `[...document.querySelectorAll('#grid .card')]
     .find((card) => card.querySelector('.name').textContent === '${published.name}')
     ?.querySelectorAll('button')[0]?.textContent === '安装'`,
  'card back to 安装',
  15000,
)
ok('卸载后插件目录已删除', !existsSync(targetDir))
const afterUninstall = readFileSync(join(profileDir, 'package.json'), 'utf8')
ok('卸载后 profile 不再引用该插件', !afterUninstall.includes(published.name), afterUninstall.slice(0, 160))
const patchAfter = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
ok('卸载后托管行已移除', !patchAfter.includes(published.name))
ok('卸载后运维内容仍逐字节保留', patchAfter.includes(OPERATOR_PATCH.trim()), JSON.stringify(patchAfter))

const cardsAfterUninstall = JSON.parse(String(await cdp.eval(`
  JSON.stringify([...document.querySelectorAll('#grid .card')].map((card) => ({
    name: card.querySelector('.name').textContent,
    buttons: [...card.querySelectorAll('button')].map((b) => b.textContent),
    tags: [...card.querySelectorAll('.tag')].map((t) => t.textContent),
  })))
`)))
const clearedCard = cardsAfterUninstall.find((card) => card.name === published.name)
ok('卸载后卡片退回「安装」', clearedCard?.buttons?.includes('安装') === true, JSON.stringify(clearedCard?.buttons))
ok('卸载后不再显示「已安装到本机」', clearedCard?.tags?.includes('已安装到本机') !== true, JSON.stringify(clearedCard?.tags))

console.log('\n--- 完整性：篡改制品必须被拒 ---')
const stored = artifacts.contain(published.name, published.version, 'stable.tgz')
writeFileSync(stored, Buffer.from('tampered'))
const forged = await fetch(
  `http://127.0.0.1:${LOCAL_PORT}/dsh-market/install`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: await login(),
      name: published.name,
      version: published.version,
      sha256: published.sha256,
    }),
  },
)
const forgedBody = await forged.json()
ok('服务端拒绝下发被篡改的制品', forgedBody.code === 'E_HASH_MISMATCH' || forgedBody.code === 'E_SERVICE_HTTP_500', `${forged.status}/${forgedBody.code}`)
ok('被篡改的制品没有落进 profile', !existsSync(targetDir))

async function login() {
  const response = await fetch(`${serviceUrl}/dsh-market/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'alice-strong-password' }),
  })
  return (await response.json()).token
}

const digest = createHash('sha256').update(readFileSync(stored)).digest('hex')
ok('（自检）磁盘内容确实已变', digest !== published.sha256)

console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
socket.close()
localServer.kill()
server.close()
try {
  rmSync(workDir, { recursive: true, force: true })
} catch {
  /* windows locks are not fatal */
}
process.exit(problems ? 1 : 0)
