/**
 * The page shell's boot decision, exercised in a sandbox instead of a browser.
 *
 * WHAT THIS PINS, and why it needs its own suite. DSH now launches with `--port 0`, so every
 * start gives the market page a NEW browser origin and `localStorage` begins empty. Auto-login
 * (the install page's `beforeBoot`, which runs before `boot()` reaches its checks) then obtains a
 * session through the host plugin and stores it. The step that drops "a token issued by a
 * different service" compared a MISSING service record as if it were a different one — so it
 * cleared the session AND the seven-day refresh token, and the page fell through to the login
 * form: username and password on every launch, on a machine that was already bound.
 *
 * Why nothing else caught it: the host routes are correct and the service really does issue the
 * session (the market database shows it). Only the boot decision tells the two outcomes apart,
 * and no suite ran that code. The CDP probes would, but they skip without a browser.
 *
 * No browser needed here: `web/shared.js` reaches only for `document`, `localStorage`, `location`
 * and `fetch`, so a `node:vm` context is enough — which keeps this runnable in CI.
 *
 *   node tools/probe-shared-boot.mjs [path-to-shared.js]
 *
 * The optional path is for the reverse check: pointing it at an older copy
 * (`git show HEAD:web/shared.js`) must FAIL, or this test is not testing anything.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = process.argv[2] ?? join(ROOT, 'web', 'shared.js')
const SOURCE = readFileSync(TARGET, 'utf8')

/** The service the page is configured to talk to. */
const SERVICE = 'http://127.0.0.1:8787'
/** Stands in for the DSH origin, which changes on every launch. */
const ORIGIN = 'http://127.0.0.1:60898'

let problems = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) problems += 1
}

/**
 * A browser-shaped global carrying just what `shared.js` touches.
 *
 * `storage` seeds localStorage, which is how each scenario states what the previous page visit
 * left behind — and on a fresh origin the honest answer is "nothing".
 */
function makeShell(storage) {
  const backing = new Map(Object.entries(storage))
  const nodes = new Map()
  const node = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        textContent: '',
        value: '',
        dataset: {},
        style: {},
        children: [],
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
        addEventListener() {},
        appendChild(child) { this.children.push(child) },
      })
    }
    return nodes.get(id)
  }
  const routes = {
    '/dsh-market/config': { serviceUrl: SERVICE, configured: true, profileDir: 'C:/profile' },
    [`${SERVICE}/dsh-market/auth/me`]: { user: { username: 'admin', role: 'admin' } },
  }
  const sandbox = {
    console,
    document: {
      getElementById: (id) => node(id),
      createElement: (tag) => node(`created:${tag}`),
      body: node('body'),
    },
    localStorage: {
      getItem: (key) => (backing.has(key) ? backing.get(key) : null),
      setItem: (key, value) => { backing.set(key, String(value)) },
      removeItem: (key) => { backing.delete(key) },
    },
    location: { origin: ORIGIN },
    fetch: async (url) => {
      const body = routes[String(url)]
      // A surprise request means the flow changed underneath this test; fail loudly.
      if (body === undefined) throw new Error(`unexpected fetch: ${url}`)
      return { ok: true, status: 200, json: async () => body }
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: TARGET })
  return { shell: sandbox.MarketShell, backing }
}

/**
 * Run the shell's boot the way a page does.
 *
 * `boot()` itself never shows the market view — it calls `enter()`, which runs the page's
 * `onAuthenticated` handler, and THAT is what renders. Mirroring that split keeps the assertions
 * about the boot DECISION (did it reach the authenticated path?) rather than about rendering.
 */
const boot = async (shell) => {
  const reached = { afterAuth: false }
  shell.onAuthenticated(() => { reached.afterAuth = true; shell.show('market') })
  await shell.init({ views: ['login', 'market'], beforeBoot: async () => {}, onView: () => {} })
  return reached
}

console.log('--- 自动登录的会话在一个全新的 origin 上必须活下来 ---')
{
  /**
   * Exactly what a launch looks like now: localStorage is empty, then auto-login stores the
   * session it retrieved. Nothing has recorded a service URL yet.
   */
  const { shell, backing } = makeShell({
    'dsh.market.token': 'session-token',
    'dsh.market.refresh': 'refresh-token',
  })
  const reached = await boot(shell)
  ok('token 没有被当成「别的服务」清掉', shell.token.get() === 'session-token', String(shell.token.get()))
  ok('  七天刷新令牌也保住了', backing.get('dsh.market.refresh') === 'refresh-token')
  ok(
    '  补记了服务地址（下次据此判断）',
    backing.get('dsh.market.service') === SERVICE,
    String(backing.get('dsh.market.service')),
  )
  ok('  走到了已登录分支（而不是回退登录页）', reached.afterAuth === true)
  ok('  页面进入市场视图', shell.current() === 'market', String(shell.current()))
}

console.log('')
console.log('--- 确实属于别的服务的令牌仍然要丢 ---')
{
  const { shell, backing } = makeShell({
    'dsh.market.token': 'foreign-token',
    'dsh.market.refresh': 'foreign-refresh',
    'dsh.market.service': 'http://10.0.0.9:8787',
  })
  const reached = await boot(shell)
  ok('token 被清掉', shell.token.get() === null)
  ok('  刷新令牌一起清掉', backing.get('dsh.market.refresh') === undefined)
  ok('  没有走已登录分支', reached.afterAuth === false)
  ok('  回到登录页', shell.current() === 'login', String(shell.current()))
}

console.log('')
console.log('--- 没有令牌时仍然进登录页 ---')
{
  const { shell } = makeShell({})
  const reached = await boot(shell)
  ok('没有任何令牌 → 登录页', shell.current() === 'login', String(shell.current()))
  ok('  也不会走已登录分支', reached.afterAuth === false)
}

console.log('')
console.log('--- 记录一致时照常进入 ---')
{
  const { shell } = makeShell({ 'dsh.market.token': 'token', 'dsh.market.service': SERVICE })
  const reached = await boot(shell)
  ok('服务一致 → 市场视图', shell.current() === 'market', String(shell.current()))
  ok('  走了已登录分支', reached.afterAuth === true)
}

console.log('')
console.log('结论：')
console.log('  · 端口每次变化 → 每次都是新 origin → 自动登录拿到的会话必须被采纳。')
console.log('  · 「没有记录」与「记录了别的服务」是两件事：前者只可能来自本页。')
console.log('  · 真属于别的服务的令牌仍然被清掉，并回到登录页。')

console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
