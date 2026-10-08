// Determine what is ACTUALLY reachable without a token, rather than trusting the
// route table's `auth` field. The admin routes are registered `auth: 'none'` because
// their handlers resolve the session themselves — so the field says nothing about
// whether a caller can get in.
import { mkdtempSync } from 'node:fs'
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
  ['POST', '/dsh-market/auth/device/start', {}],
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

console.log('')
console.log(`真正无需令牌即可访问的: ${open.length} 条`)
for (const line of open) console.log(`  ${line}`)

app.server.close()
