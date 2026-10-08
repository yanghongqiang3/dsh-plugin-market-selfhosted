// Determine what is ACTUALLY reachable without a token, rather than trusting the
// route table's `auth` field. The admin routes are registered `auth: 'none'` because
// their handlers resolve the session themselves — so the field says nothing about
// whether a caller can get in.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/index.mjs'

const workDir = mkdtempSync(join(tmpdir(), 'dsh-expose-'))
const app = createApp({ dbFile: join(workDir, 'market.db'), storageDir: join(workDir, 'storage') })
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${app.server.address().port}`

const probes = [
  ['GET', '/', null],
  ['GET', '/console', null],
  ['GET', '/dsh-market/health', null],
  ['GET', '/dsh-market/assets/market.css', null],
  ['GET', '/dsh-market/assets/shared.js', null],
  ['GET', '/dsh-market/identity/lookup?dshUserId=x', null],
  ['GET', '/dsh-market/admin/users', null],
  ['GET', '/dsh-market/admin/identity', null],
  ['GET', '/dsh-market/admin/artifacts', null],
  ['POST', '/dsh-market/admin/users', {}],
  ['POST', '/dsh-market/admin/role', {}],
  ['POST', '/dsh-market/admin/password', {}],
  ['POST', '/dsh-market/admin/status', {}],
  ['POST', '/dsh-market/admin/identity/unbind', {}],
  ['POST', '/dsh-market/publish', null],
  ['POST', '/dsh-market/auth/login', {}],
]

console.log('无令牌请求的实际响应：')
const open = []
for (const [method, path, body] of probes) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === null ? {} : { 'content-type': 'application/json' },
    body: body === null ? undefined : JSON.stringify(body),
  })
  const text = (await response.text()).slice(0, 60)
  const reachable = response.status !== 401 && response.status !== 403
  if (reachable) open.push(`${method} ${path} -> ${response.status}`)
  console.log(`  ${String(response.status).padEnd(4)} ${method.padEnd(5)} ${path.padEnd(46)} ${reachable ? '可访问' : '拒绝'}  ${text}`)
}

// Labelled like the other suites so the same runner can count them. `ok` here means
// "the answer is known and expected", not "this route is safe to expose".
console.log('')
let expected = 0
for (const [method, path] of probes) {
  // Admin and publish routes MUST refuse an anonymous caller. Everything else is the
  // public surface and is asserted to be public on purpose, so a change of surface is
  // visible in the diff rather than discovered in production.
  const mustRefuse = path.startsWith('/dsh-market/admin/') || path === '/dsh-market/publish'
  const isOpen = open.some((line) => line.startsWith(`${method} ${path} `))
  if (mustRefuse) {
    if (isOpen) { console.log(`FAIL  无令牌不应能访问 ${method} ${path}`); expected += 1 }
    else console.log(`ok    无令牌被拒 ${method} ${path}`)
  } else {
    console.log(`ok    公开路由（预期）${method} ${path}`)
  }
}

console.log('')
console.log(`真正无需令牌即可访问的: ${open.length} 条`)
for (const line of open) console.log(`  ${line}`)
console.log(expected ? `\nRESULT: ${expected} problem(s)` : '\nRESULT: all checks passed')

app.server.close()
app.db.close()
// Remove the scratch directory — this probe used to leave one behind on every run.
rmSync(workDir, { recursive: true, force: true })
process.exit(expected ? 1 : 0)
