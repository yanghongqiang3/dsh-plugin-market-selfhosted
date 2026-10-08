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

// A composition without webServer must stay inert instead of throwing.
try {
  pluginMod.apply({ get: () => undefined, effect: (fn) => { fn(); return () => {} } })
  ok('无 webServer 的组合保持惰性、不抛错', true)
} catch (error) {
  ok('无 webServer 的组合保持惰性、不抛错', false, String(error?.message ?? error))
}

console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
