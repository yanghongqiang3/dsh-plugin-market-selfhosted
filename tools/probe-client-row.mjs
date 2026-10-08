// Reproduce the client row's import from the profile's resolution base, to get the
// real error. `dsh-app-boot` treats `fiber === undefined` as "failed to import" and
// prints only that summary, so the underlying error has to be reproduced here.
//
//   node tools/probe-client-row.mjs <profileDir>
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'

const profileDir = resolve(process.argv[2] ?? join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop'))
const baseUrl = pathToFileURL(`${profileDir}\\`).href
const specifier = 'dsh-plugin-marketplace'

console.log(`profile   ${profileDir}`)
console.log(`baseUrl   ${baseUrl}`)
console.log(`specifier ${specifier}`)
console.log('')

try {
  const resolved = import.meta.resolve(specifier, baseUrl)
  console.log(`resolve   ${resolved}`)
  const file = new URL(resolved)
  const { readFileSync } = await import('node:fs')
  const text = readFileSync(file, 'utf8')
  console.log(`content   ${text.length} 字节: ${JSON.stringify(text.slice(0, 80))}`)
  console.log('')
  const mod = await import(resolved)
  console.log(`import ok exports = ${JSON.stringify(Object.keys(mod))}`)
} catch (error) {
  console.log('')
  console.log('=== 导入失败 ===')
  console.log(error?.stack ?? String(error))
}
