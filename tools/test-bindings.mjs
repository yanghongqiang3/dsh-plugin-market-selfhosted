// Prove the 1:1 binding constraint holds in BOTH directions — the operator asked
// for "one DSH account binds one market account", so a single unique column would
// not be enough.
import { openDatabase } from '../server/lib/db.js'

const db = openDatabase(':memory:')

const cols = db.prepare('PRAGMA table_info(dsh_bindings)').all().map((row) => row.name)
console.log(`dsh_bindings 列: ${cols.join(', ')}`)
for (const index of db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='dsh_bindings'").all()) {
  console.log(`  索引 ${index.name}`)
}

const user = (id, name) => db
  .prepare("INSERT INTO users (id, username, display_name, role, password_hash, created_at) VALUES (?,?,?,'member','x',1)")
  .run(id, name, name.toUpperCase())
user('u1', 'alice')
user('u2', 'bob')

const bind = (dshUserId, marketUsername) => db
  .prepare('INSERT INTO dsh_bindings (dsh_user_id, market_username, bound_at) VALUES (?,?,1)')
  .run(dshUserId, marketUsername)

const attempt = (label, fn) => {
  try {
    fn()
    console.log(`FAIL  ${label} — 竟然成功了`)
    return 1
  } catch (error) {
    console.log(`ok    ${label} — 被拒 (${error.code ?? error.message})`)
    return 0
  }
}

let problems = 0
console.log('')
console.log('--- 1:1 双向唯一性 ---')
bind('dsh-1', 'alice')
console.log('ok    首次绑定 dsh-1 -> alice')
problems += attempt('同一 DSH 账号绑第二个市场账号', () => bind('dsh-1', 'bob'))
problems += attempt('同一市场账号被第二个 DSH 账号绑', () => bind('dsh-2', 'alice'))
problems += attempt('完全重复的绑定', () => bind('dsh-1', 'alice'))

console.log('')
console.log('--- 解绑后可重新绑定 ---')
db.prepare("DELETE FROM dsh_bindings WHERE dsh_user_id = 'dsh-1'").run()
bind('dsh-2', 'alice')
console.log('ok    解绑后 alice 可以绑到 dsh-2')
bind('dsh-1', 'bob')
console.log('ok    解绑后 dsh-1 可以绑到 bob')

console.log('')
console.log('--- 账号被删除时绑定随之删除（外键 ON DELETE CASCADE）---')
const before = db.prepare('SELECT COUNT(*) AS n FROM dsh_bindings').get().n
db.prepare("DELETE FROM users WHERE username = 'alice'").run()
const after = db.prepare('SELECT COUNT(*) AS n FROM dsh_bindings').get().n
if (after === before - 1) console.log(`ok    删除 alice 后绑定数 ${before} -> ${after}`)
else { console.log(`FAIL  删除账号后绑定残留 (${before} -> ${after})`); problems += 1 }

console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
