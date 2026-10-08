// Exercise the bundle host entry and the plugin subpath in plain Node before
// handing them to DSH.
//
// The bundle-entry assertion used to require an EMPTY namespace, on the theory that
// "every shipped bundle is written that way". That theory was wrong and it hid a
// real defect: the loader validates each row's module and rejects an empty one with
//
//   invalid plugin, expect function or object with an "apply" method, received object
//
// so the bare-package-name row never got a fiber, the browser half was never
// composed, and the only symptom was the audit's unhelpful `failed to import`.
// This file now asserts the form the loader actually requires.
import { pathToFileURL } from 'node:url'

const root = process.argv[2] ?? 'E:/workspace/dsh'
const bundleMod = await import(pathToFileURL(`${root}/lib/bundle.js`).href)
const pluginMod = await import(pathToFileURL(`${root}/lib/plugin.js`).href)

let problems = 0
const ok = (label, condition, extra = '') => {
  if (condition) console.log(`ok    ${label}${extra ? `  ${extra}` : ''}`)
  else {
    problems += 1
    console.error(`FAIL  ${label}${extra ? `  ${extra}` : ''}`)
  }
}

ok('plugin 导出 apply 函数', typeof pluginMod.apply === 'function')
ok('plugin 导出 name', pluginMod.name === 'dsh-plugin-marketplace', pluginMod.name)
ok(
  'bundle 入口是合法插件（有 apply）',
  typeof bundleMod.apply === 'function',
  `exports=${Object.keys(bundleMod).join(', ') || '(none)'}`,
)

const registered = []
const webServer = {
  port: 12345,
  // `register` is what the plugin waits for before mounting its routes.
  register: (route) => {
    registered.push(route)
    return () => {}
  },
}
const ctx = {
  get: (name) => (name === 'webServer' ? webServer : undefined),
  effect: (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
}

pluginMod.apply(ctx)

// apply() waits for `webServer` through a poll loop; give it a few turns.
for (let attempt = 0; attempt < 40 && registered.length === 0; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 50))
}
ok('注册了路由', registered.length > 0, `${registered.length} 条`)
for (const route of registered) console.log(`      ${String(route.kind).padEnd(7)} ${route.path}`)
ok('包含 /dsh-market/open（客户端半边取地址用）', registered.some((r) => String(r.path).includes('/dsh-market/open')))

/**
 * The asset route, driven exactly the way the webserver drives a handler.
 *
 * The webserver calls `route.handler(req, res)` — TWO arguments, no parsed URL. A
 * handler that takes a third `url` parameter gets `undefined`, throws on
 * `url.pathname`, and the webserver answers a bare 400 with no body and no visible
 * log. That is what happened here, and only a real DSH instance exposed it: this
 * test previously passed while the route was broken, because it never invoked a
 * handler. So invoke one, with the real arity.
 */
{
  const assetRoute = registered.find((r) => String(r.path) === '/dsh-market/assets')
  ok('资源路由以 /dsh-market/assets 注册（前缀不能带尾斜杠）', assetRoute !== undefined)

  if (assetRoute !== undefined) {
    const responses = []
    const fakeRes = () => {
      const record = { status: 0, headers: null, body: null }
      responses.push(record)
      return {
        writeHead: (status, headers) => { record.status = status; record.headers = headers ?? null },
        end: (body) => { record.body = body ?? null },
      }
    }
    const fakeReq = (path) => ({ method: 'GET', url: path, headers: {} })

    // Two arguments only, matching the webserver.
    await assetRoute.handler(fakeReq('/dsh-market/assets/shared.js'), fakeRes())
    ok(
      'shared.js 以两个参数调用时返回 200',
      responses[0]?.status === 200,
      `status=${responses[0]?.status} type=${responses[0]?.headers?.['content-type']}`,
    )
    ok('shared.js 带正确的 content-type', String(responses[0]?.headers?.['content-type'] ?? '').includes('javascript'))

    await assetRoute.handler(fakeReq('/dsh-market/assets/market.css'), fakeRes())
    ok('market.css 返回 200', responses[1]?.status === 200, `status=${responses[1]?.status}`)

    // console.* belongs to the server console, which serves it from its own origin.
    await assetRoute.handler(fakeReq('/dsh-market/assets/console.css'), fakeRes())
    ok('console.css 不在本机白名单内（由服务端提供）', responses[2]?.status === 404, `status=${responses[2]?.status}`)

    await assetRoute.handler(fakeReq('/dsh-market/assets/../../server/index.mjs'), fakeRes())
    ok('资源路由不接受路径穿越', responses[3]?.status === 404, `status=${responses[3]?.status}`)

    await assetRoute.handler(fakeReq('/dsh-market/assets/%2e%2e%2fserver%2findex.mjs'), fakeRes())
    ok('资源路由不接受编码过的路径穿越', responses[4]?.status === 404, `status=${responses[4]?.status}`)
  }
}

/**
 * The identity route, DRIVEN rather than merely registered.
 *
 * The route existed and its assertions passed while the handler threw on every call:
 * `readDshIdentity(ctx)` referenced a `ctx` that was NOT in scope inside the route
 * table. The webserver turns a handler throw into a bare 400 with no body and no log,
 * so the page could only report 「未知原因」. Asserting that a route is REGISTERED says
 * nothing about whether it can run — the same gap that hid the asset-route bug above.
 */
{
  const identityRoute = registered.find((r) => String(r.path) === '/dsh-market/identity')
  ok('注册了 /dsh-market/identity', identityRoute !== undefined)

  if (identityRoute !== undefined) {
    /** Apply the plugin with a context carrying the given account service. */
    const callIdentity = async (account) => {
      const seen = []
      const fakeWebServer = {
        port: 12345,
        register: (route) => {
          seen.push(route)
          return () => {}
        },
      }
      pluginMod.apply({
        get: (name) => (name === 'webServer' ? fakeWebServer : (name === 'deepseekAccount' ? account : undefined)),
        effect: (fn) => {
          const dispose = fn()
          return typeof dispose === 'function' ? dispose : () => {}
        },
      })
      for (let attempt = 0; attempt < 40 && seen.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const route = seen.find((r) => String(r.path) === '/dsh-market/identity')
      if (route === undefined) return { found: false, body: null }
      let captured = null
      const res = { writeHead: () => {}, end: (body) => { captured = body } }
      // TWO arguments, exactly like the webserver — that arity is part of the contract.
      await route.handler({ method: 'GET', url: '/dsh-market/identity', headers: {} }, res)
      try { return { found: true, body: JSON.parse(String(captured)) } } catch { return { found: true, body: null } }
    }

    const full = await callIdentity({
      getDeviceIdentity: async () => ({ deviceId: 'dev-1', osVersion: 'win32' }),
      getProfile: async () => ({ status: 'ready', value: { id: 'acct-1', name: '测试', contact: 'x' } }),
    })
    ok('identity 处理器能被调用（不是 400/抛错）', full.found && full.body !== null, JSON.stringify(full.body))
    ok(
      'identity 返回稳定账号 ID',
      full.body?.source === 'account' && full.body?.userId === 'acct-1',
      JSON.stringify(full.body),
    )
    ok('identity 带上显示名', full.body?.name === '测试', JSON.stringify(full.body?.name))
    ok(
      'identity 不返回任何凭据字段',
      full.body !== null && !('token' in full.body) && !('credential' in full.body) && !('session' in full.body),
      Object.keys(full.body ?? {}).join(', '),
    )

    // Signed in, but the profile read carries no id: a reportable state, and the page
    // has to be able to SAY it. The first version returned a null reason here.
    const noId = await callIdentity({
      getDeviceIdentity: async () => ({ deviceId: 'dev-2', osVersion: 'win32' }),
      getProfile: async () => ({ status: 'ready', value: { id: null, name: null } }),
    })
    ok('读不到账号 ID 时 source=device-only', noId.body?.source === 'device-only', JSON.stringify(noId.body))
    ok(
      '读不到账号 ID 时给出可读原因（不是 null）',
      typeof noId.body?.reason === 'string' && noId.body.reason.length > 0,
      JSON.stringify(noId.body?.reason),
    )

    const none = await callIdentity({
      getDeviceIdentity: async () => ({ deviceId: 'dev-3', osVersion: 'win32' }),
      getProfile: async () => null,
    })
    ok(
      '未登录时 reason 也可读',
      typeof none.body?.reason === 'string' && none.body.reason.length > 0,
      JSON.stringify(none.body?.reason),
    )

    const absent = await callIdentity(undefined)
    ok('账号服务缺席时不抛错，报 none', absent.body?.source === 'none', JSON.stringify(absent.body))

    const throwing = await callIdentity({
      getDeviceIdentity: async () => { throw new Error('device read failed') },
      getProfile: async () => { throw new Error('offline') },
    })
    ok(
      '账号服务抛错时不冒泡，仍返回可读原因',
      throwing.body?.ok === true && typeof throwing.body?.reason === 'string',
      JSON.stringify(throwing.body),
    )
  }
}

// A composition without webServer must stay inert instead of throwing.
try {
  pluginMod.apply({ get: () => undefined, effect: (fn) => { fn(); return () => {} } })
  ok('无 webServer 的组合保持惰性、不抛错', true)
} catch (error) {
  ok('无 webServer 的组合保持惰性、不抛错', false, String(error?.message ?? error))
}

console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
