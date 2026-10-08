// Try every export of a package from a profile's resolution base, reporting the
// full error for each. A client row failing means its `./client` bundle could not
// be produced, and one bad file is enough to break it.
//
//   node tools/probe-entries.mjs <profileDir> <packageName>
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'

const profileDir = resolve(process.argv[2] ?? join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop'))
const pkgName = process.argv[3] ?? 'dsh-plugin-marketplace'
const baseUrl = pathToFileURL(`${profileDir}\\`).href

console.log(`profile ${profileDir}`)
console.log(`package ${pkgName}`)
console.log('')

for (const sub of ['.', './plugin', './client', './tar.js']) {
  const specifier = sub === '.' ? pkgName : `${pkgName}/${sub.slice(2)}`
  const label = `${pkgName}${sub === '.' ? '' : sub.slice(1)}`
  try {
    const resolved = import.meta.resolve(specifier, baseUrl)
    try {
      const mod = await import(resolved)
      console.log(`ok    ${label.padEnd(34)} -> ${new URL(resolved).pathname.split('/').slice(-2).join('/')}`)
      console.log(`      exports: ${JSON.stringify(Object.keys(mod))}`)
    } catch (error) {
      console.log(`FAIL  ${label.padEnd(34)} 导入失败`)
      console.log(`      ${String(error?.stack ?? error).split('\n').slice(0, 4).join('\n      ')}`)
    }
  } catch (error) {
    console.log(`FAIL  ${label.padEnd(34)} 解析失败`)
    console.log(`      ${String(error?.message ?? error).split('\n')[0]}`)
  }
}
