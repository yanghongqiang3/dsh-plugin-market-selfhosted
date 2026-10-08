// Exercise the bundle host entry and the plugin subpath in plain Node before
// handing them to DSH. Proves both import, that the bundle entry stays empty
// (matching every shipped bundle), and that every route registers.
import { pathToFileURL } from 'node:url'

const root = process.argv[2] ?? 'E:/workspace/dsh'
const bundleMod = await import(pathToFileURL(`${root}/lib/bundle.js`).href)
const pluginMod = await import(pathToFileURL(`${root}/lib/plugin.js`).href)

console.log('bundle exports:', Object.keys(bundleMod).join(', ') || '(none)')
console.log('plugin exports:', Object.keys(pluginMod).join(', '))
console.log('plugin.name:', pluginMod.name)
console.log('plugin.apply is function:', typeof pluginMod.apply === 'function')

const registered = []
const ctx = {
  get: (name) => (name === 'webServer' ? { register: (route) => (registered.push(route), () => {}) } : undefined),
  effect: (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
}

pluginMod.apply(ctx)
console.log(`routes registered: ${registered.length}`)
for (const route of registered) console.log(`  ${route.kind.padEnd(6)} ${route.path}`)

// A composition without webServer must stay inert instead of throwing.
pluginMod.apply({ get: () => undefined, effect: (fn) => { fn(); return () => {} } })
console.log('inert composition handled without throwing')

if (Object.keys(bundleMod).length !== 0) {
  console.error('FAIL: bundle entry must be empty (export {}) like every shipped bundle')
  process.exit(1)
}
console.log('bundle entry is empty as required')
