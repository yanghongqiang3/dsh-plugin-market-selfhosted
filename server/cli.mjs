#!/usr/bin/env node
/**
 * Market server — operator CLI.
 *
 *   node server/cli.mjs bootstrap
 *   node server/cli.mjs user:add   --username alice --password secret --groups platform [--admin]
 *   node server/cli.mjs user:list
 *   node server/cli.mjs user:pass  --username alice --password new --no-must-change
 *   node server/cli.mjs user:status --username alice --status disabled
 *   node server/cli.mjs group:add  --id billing --description "计费组"
 *   node server/cli.mjs grant:add  --group billing --pattern "@dsh-internal/dsh-plugin-*" [--deny]
 *   node server/cli.mjs grant:rm   --group billing --pattern "@dsh-internal/dsh-plugin-*"
 *   node server/cli.mjs member:add --user alice --group billing
 *   node server/cli.mjs publish    --dir <plugin-package-dir> [--state published] [--channel stable]
 *   node server/cli.mjs catalog
 *   node server/cli.mjs audit      [--limit 50]
 *   node server/cli.mjs prune
 *
 * Reads the same environment as server/index.mjs, so it always edits the same
 * database the service uses.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openDatabase } from './lib/db.js'
import { Store, DEFAULT_ADMIN } from './lib/store.js'
import { Artifacts } from './lib/artifacts.js'

const DATA_DIR = resolve(process.env.MARKET_DATA_DIR ?? '.market')
const DB_FILE = resolve(process.env.MARKET_DB ?? join(DATA_DIR, 'market.db'))
const STORAGE_DIR = resolve(process.env.MARKET_STORAGE ?? join(DATA_DIR, 'artifacts'))

function flags(argv) {
  const out = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else {
        out[key] = next
        index += 1
      }
    } else {
      out._.push(token)
    }
  }
  return out
}

function open() {
  if (!existsSync(DB_FILE)) {
    console.error(`没有数据库：${DB_FILE}`)
    console.error('先跑 `node server/cli.mjs bootstrap` 或启动服务端。')
    process.exit(1)
  }
  const db = openDatabase(DB_FILE)
  return { db, store: new Store(db), artifacts: new Artifacts(db, STORAGE_DIR) }
}

const dim = (text) => `\u001b[2m${text}\u001b[0m`
const bold = (text) => `\u001b[1m${text}\u001b[0m`

function printGroups(store) {
  const groups = store.listGroups()
  if (groups.length === 0) {
    console.log(dim('（还没有权限组）'))
    return
  }
  for (const group of groups) {
    console.log(`${bold(group.id)}  ${group.description || ''}`)
    console.log(dim(`   成员 ${group.members.length ? group.members.join('、') : '无'}　规则 ${group.grants.length}`))
    for (const grant of group.grants) {
      const effect = grant.effect === 'deny' ? 'deny（优先）' : 'allow'
      console.log(dim(`     ${effect.padEnd(12)} ${grant.pluginPattern}${grant.channel ? `  @${grant.channel}` : ''}`))
    }
  }
}

const command = process.argv[2]
const args = flags(process.argv.slice(3))

if (!command) {
  console.log(readFileSync(new URL('./cli.mjs', import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n').replace(/^ \* ?/gm, ''))
  process.exit(0)
}

switch (command) {
  case 'bootstrap': {
    // The one command that must be able to CREATE the database, so it does not
    // go through open() and its "no database yet" guard.
    const db = openDatabase(DB_FILE)
    const store = new Store(db)
    if (store.countUsers() > 0) {
      console.log(`数据库已有 ${store.countUsers()} 个账号，未改动。`)
    } else {
      store.createUser({
        username: DEFAULT_ADMIN.username,
        password: DEFAULT_ADMIN.password,
        displayName: '管理员',
        role: 'admin',
        mustChangePassword: true,
        createdBy: 'system',
      })
      store.createGroup({ id: 'platform', name: 'platform', description: '平台组', by: 'system' })
      console.log(`已创建初始管理员：${bold(DEFAULT_ADMIN.username)} / ${DEFAULT_ADMIN.password}（首登强制改密）`)
    }
    console.log(`数据库：${DB_FILE}`)
    console.log(`制品目录：${STORAGE_DIR}`)
    db.close()
    break
  }

  case 'user:add': {
    const { db, store } = open()
    const created = store.createUser({
      username: args.username,
      password: args.password,
      displayName: args.display,
      role: args.admin ? 'admin' : 'member',
      mustChangePassword: args['no-must-change'] !== true,
      createdBy: args.by ?? 'cli',
    })
    const groups = args.groups ? String(args.groups).split(',').map((s) => s.trim()).filter(Boolean) : []
    for (const groupId of groups) store.setMembership(created.username, groupId, true, { by: 'cli' })
    console.log(`已创建 ${bold(created.username)}（角色 ${created.role}，组 ${groups.join('、') || '无'}）`)
    console.log(`数据库：${DB_FILE}`)
    db.close()
    break
  }

  case 'user:list': {
    const { db, store } = open()
    for (const user of store.listUsers()) {
      const flagsText = [
        user.role,
        user.groups.join('、') || '无组',
        user.status === 'disabled' ? '已停用' : null,
        user.mustChangePassword ? '待改密' : null,
        user.lastLoginAt ? `上次登录 ${new Date(user.lastLoginAt).toISOString().slice(0, 16).replace('T', ' ')}` : null,
      ].filter(Boolean).join('　')
      console.log(`${bold(user.username.padEnd(16))} ${dim(flagsText)}`)
    }
    printGroups(store)
    db.close()
    break
  }

  case 'user:pass': {
    const { db, store } = open()
    store.setPassword(args.username, args.password, {
      mustChange: args['no-must-change'] !== true,
      by: 'cli',
    })
    console.log(`已重置 ${args.username} 的密码${args['no-must-change'] === true ? '' : '（下次登录需改密）'}`)
    db.close()
    break
  }

  case 'user:status': {
    const { db, store } = open()
    const result = store.setStatus(args.username, args.status === 'disabled' ? 'disabled' : 'active', {
      by: 'cli',
      reason: args.reason,
    })
    console.log(`已将 ${args.username} 设为 ${result.status}（吊销会话 ${result.revokedSessions} 个）`)
    db.close()
    break
  }

  case 'group:add': {
    const { db, store } = open()
    store.createGroup({ id: args.id, name: args.name, description: args.description, by: 'cli' })
    console.log(`已创建组 ${bold(args.id)}`)
    db.close()
    break
  }

  case 'grant:add': {
    const { db, store } = open()
    store.addGrant({
      groupId: args.group,
      pluginPattern: args.pattern,
      effect: args.deny ? 'deny' : 'allow',
      channel: args.channel ?? null,
      by: 'cli',
    })
    console.log(`已添加规则：${args.group} → ${args.pattern}（${args.deny ? 'deny' : 'allow'}）`)
    db.close()
    break
  }

  case 'grant:rm': {
    const { db, store } = open()
    const removed = store.removeGrant({ groupId: args.group, pluginPattern: args.pattern, by: 'cli' })
    console.log(`已删除 ${removed} 条规则`)
    db.close()
    break
  }

  case 'member:add': {
    const { db, store } = open()
    const groups = store.setMembership(args.user, args.group, args.remove !== true, { by: 'cli' })
    console.log(`${args.user} 的组：${groups.join('、') || '无'}`)
    db.close()
    break
  }

  case 'publish': {
    const { db, artifacts } = open()
    const artifact = artifacts.publishFromDirectory(resolve(args.dir), {
      publishedBy: args.by ?? 'cli',
      state: args.state,
      channel: args.channel,
    })
    console.log(`已发布 ${bold(`${artifact.name}@${artifact.version}`)}（${artifact.channel}，状态 ${artifact.status}）`)
    console.log(`  sha256    ${artifact.sha256}`)
    console.log(`  大小      ${artifact.sizeBytes} 字节`)
    console.log(`  摘要      ${artifact.summary || '（无）'}`)
    db.close()
    break
  }

  case 'catalog': {
    const { db, artifacts } = open()
    const rows = artifacts.catalogRows()
    if (rows.length === 0) console.log(dim('（目录为空）'))
    for (const row of rows) {
      console.log(`${bold(row.name)}  v${row.version}  ${dim(`${row.channel}　${row.status}　${row.owner || '无归属'}`)}`)
      console.log(dim(`   ${row.summary || '（无摘要）'}`))
    }
    db.close()
    break
  }

  case 'audit': {
    const { db, store } = open()
    for (const entry of store.recentAudit(Number(args.limit ?? 50))) {
      const at = new Date(entry.at).toISOString().slice(11, 19)
      console.log(`${dim(at)} ${bold(entry.action.padEnd(18))} ${entry.username ?? '-'} ${dim(JSON.stringify(entry.detail))}`)
    }
    db.close()
    break
  }

  case 'prune': {
    const { db, store } = open()
    const result = store.prune()
    console.log(`已清理过期会话 ${result.sessions} 个、设备码 ${result.deviceAuths} 个`)
    db.close()
    break
  }

  default:
    console.error(`未知命令：${command}`)
    process.exit(1)
}
