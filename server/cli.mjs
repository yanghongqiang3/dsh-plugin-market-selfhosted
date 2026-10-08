#!/usr/bin/env node
/**
 * Market server — operator CLI, and the publishing client.
 *
 * ── 服务端本机运维（直接读写数据库，需要能访问服务器文件系统）──────────────
 *   node server/cli.mjs bootstrap
 *   node server/cli.mjs user:add   --username alice --password secret --groups platform [--admin]
 *   node server/cli.mjs user:list
 *   node server/cli.mjs user:pass  --username alice --password new --no-must-change
 *   node server/cli.mjs user:status --username alice --status disabled
 *   node server/cli.mjs group:add  --id billing --description "计费组"
 *   node server/cli.mjs grant:add  --group billing --pattern "@dsh-internal/dsh-plugin-*" [--deny]
 *   node server/cli.mjs grant:rm   --group billing --pattern "@dsh-internal/dsh-plugin-*"
 *   node server/cli.mjs member:add --user alice --group billing
 *   node server/cli.mjs bind:list
 *   node server/cli.mjs bind:add   --dsh-user <DSH 账号 ID> --user alice [--name 显示名]
 *   node server/cli.mjs bind:rm    --dsh-user <DSH 账号 ID> | --user alice
 *   node server/cli.mjs catalog | audit [--limit 50] | prune
 *
 *   DSH 账号与市场账号是「一对一」绑定：一个 DSH 账号只能绑一个市场账号，反之亦然。
 *   bind:add 用于管理员修复关系；正常情况下页面在登录时自己完成绑定。
 *   bind:rm 可以按任意一侧释放，因为变更可能发生在任意一侧。
 *
 * ── 发布插件（不需要服务器 shell 权限，CI 也能用）────────────────────────────
 *   node server/cli.mjs login    --username alice [--service http://host:8787]
 *   node server/cli.mjs whoami   [--service http://host:8787]
 *   node server/cli.mjs logout
 *   node server/cli.mjs passwd   （首登强制改密时用）
 *   node server/cli.mjs publish  --dir <插件包目录> [--service URL] [--dry-run]
 *                                [--state draft|review|published|revoked] [--channel stable]
 *
 * 给了 --service 或本地已有令牌时，publish 走 HTTP 上传；否则直接写本机数据库。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { openDatabase } from './lib/db.js'
import { Store, DEFAULT_ADMIN } from './lib/store.js'
import { Artifacts } from './lib/artifacts.js'
import { DB_FILE, STORAGE_DIR, describePaths } from './lib/paths.js'
import {
  forgetToken,
  postJson,
  publishDirectory,
  readStoredToken,
  serviceOf,
  storeToken,
  TOKEN_FILE,
} from './lib/publisher.js'

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

/**
 * Read a password without echoing it, and without it appearing in argv — argv is
 * visible to every process on the machine, so `--password` is only for automation.
 */
async function readPassword(prompt = '密码：') {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    console.error('需要密码，但当前不是交互终端。请改用 --password 参数。')
    process.exit(1)
  }
  process.stdout.write(prompt)

  return new Promise((resolve) => {
    let buffer = ''
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()

    const finish = () => {
      stdin.setRawMode(wasRaw ?? false)
      stdin.pause()
      stdin.removeListener('data', onData)
      process.stdout.write('\n')
      resolve(buffer)
    }

    const onData = (chunk) => {
      const text = chunk.toString('utf8')
      for (const char of text) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish()
        if (char === '\u0003') {
          // Ctrl+C: leave the terminal usable before exiting.
          stdin.setRawMode(wasRaw ?? false)
          process.stdout.write('\n')
          process.exit(130)
        }
        if (char === '\u007f' || char === '\b') {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        if (char < ' ') continue // ignore other control characters
        buffer += char
        process.stdout.write('*')
      }
    }

    stdin.on('data', onData)
  })
}

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
  // Print the header comment as the help text, stopping at the closing marker.
  const header = readFileSync(new URL('./cli.mjs', import.meta.url), 'utf8').split('\n')
  const start = header.findIndex((line) => line.startsWith('/**'))
  const end = header.findIndex((line, index) => index > start && line.trim() === '*/')
  console.log(
    header
      .slice(start + 1, end)
      .map((line) => line.replace(/^\s*\* ?/, ''))
      .join('\n'),
  )
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
    for (const line of describePaths()) console.log(`  ${line}`)
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

  /**
   * DSH-identity bindings.
   *
   * `bind` is for repairing the relationship without the user having to log in again;
   * the page binds itself on sign-in. Both `bind:list` and `bind:rm` exist because the
   * one-to-one rule means an administrator has to be able to see which side is
   * occupying a slot before deciding what to release.
   *
   * Accepts either side as the key: a DSH account may be the thing that changed (new
   * machine, reinstall) or the market account may be the thing being reassigned.
   */
  case 'bind:list': {
    const { db, store } = open()
    const rows = store.listBindings()
    if (rows.length === 0) console.log('（还没有任何绑定）')
    for (const row of rows) {
      console.log(
        `${bold(row.marketUsername.padEnd(16))} ← DSH ${row.dshUserId}`
        + `${row.dshName ? `  ${row.dshName}` : ''}`
        + `  ${new Date(row.boundAt).toISOString().slice(0, 19)}`,
      )
    }
    db.close()
    break
  }

  case 'bind:rm': {
    const { db, store } = open()
    if (!args['dsh-user'] && !args.user) {
      console.error('用法：bind:rm --dsh-user <DSH 账号 ID>  或  bind:rm --user <市场账号>')
      db.close()
      process.exitCode = 1
      break
    }
    const result = store.unbindDshAccount({
      dshUserId: args['dsh-user'] ?? null,
      marketUsername: args.user ?? null,
      by: 'cli',
    })
    if (!result.ok) {
      console.error(`没有找到绑定（${result.code}）`)
      process.exitCode = 1
    } else {
      console.log(`已解绑：市场账号 ${bold(result.binding.marketUsername)} ← DSH ${result.binding.dshUserId}`)
    }
    db.close()
    break
  }

  case 'bind:add': {
    const { db, store } = open()
    if (!args['dsh-user'] || !args.user) {
      console.error('用法：bind:add --dsh-user <DSH 账号 ID> --user <市场账号> [--name <显示名>]')
      db.close()
      process.exitCode = 1
      break
    }
    const result = store.bindDshAccount({
      dshUserId: args['dsh-user'],
      marketUsername: args.user,
      dshName: args.name ?? '',
      by: 'cli',
    })
    if (!result.ok) {
      const hint = result.code === 'E_DSH_ALREADY_BOUND'
        ? `该 DSH 账号已绑定市场账号 ${result.detail}`
        : result.code === 'E_MARKET_ALREADY_BOUND'
          ? '该市场账号已绑定另一个 DSH 账号'
          : result.detail ?? ''
      console.error(`绑定失败（${result.code}）${hint ? `：${hint}` : ''}`)
      console.error('一个 DSH 账号只能绑一个市场账号，两个方向都受限。先 bind:rm 释放再绑。')
      process.exitCode = 1
    } else {
      console.log(`已绑定：市场账号 ${bold(args.user)} ← DSH ${args['dsh-user']}`)
    }
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
    const target = args.dir ?? args._[0]
    if (!target) {
      console.error('需要 --dir <插件包目录>')
      process.exit(1)
    }
    const dir = resolve(target)

    // Two publish paths:
    //   remote — pack here, upload over HTTP. No shell on the server, works in CI.
    //   local  — the database and storage are on this machine (operator).
    // `--service` forces remote; otherwise an existing token means remote.
    const service = serviceOf(args.service)
    const token = args.token ?? readStoredToken()
    if (args.service || token) {
      if (!token) {
        console.error(`需要令牌。先登录：node server\\cli.mjs login --username <你的账号> --service ${service}`)
        process.exit(1)
      }
      const dryRun = args['dry-run'] === true
      try {
        const result = await publishDirectory({
          dir,
          service,
          token,
          state: typeof args.state === 'string' ? args.state : undefined,
          channel: typeof args.channel === 'string' ? args.channel : undefined,
          dryRun,
          onProgress: (info) => {
            console.log(`${dryRun ? dim('（预检，不写入）') : ''} ${bold(`${info.name}@${info.version}`)}`)
            console.log(`  ${info.files} 个文件　${info.bytes} 字节`)
            console.log(`  sha256    ${info.sha256}`)
          },
        })
        console.log('')
        if (result.dryRun) {
          const preview = result.wouldPublish
          console.log('预检通过，服务端未写入。确认无误后去掉 --dry-run 再跑一次。')
          console.log(`  通道 ${preview.channel}　状态 ${preview.state}　归属 ${preview.owner || '无'}`)
        } else {
          const artifact = result.artifact
          console.log(`已发布到 ${service}`)
          console.log(`  ${bold(`${artifact.name}@${artifact.version}`)}（${artifact.channel}，状态 ${artifact.status}）`)
          console.log(`  sha256    ${artifact.sha256}`)
          if (artifact.sha256 !== result.localSha256) {
            console.error('  ⚠ 服务端记录的哈希与本地不一致，请立即核查')
            process.exit(1)
          }
        }
      } catch (error) {
        console.error(`发布失败：${error?.code ? error.code + ' ' : ''}${error?.message ?? error}`)
        process.exit(1)
      }
      break
    }

    const { db, artifacts } = open()
    const artifact = artifacts.publishFromDirectory(dir, {
      publishedBy: args.by ?? 'cli',
      state: typeof args.state === 'string' ? args.state : undefined,
      channel: typeof args.channel === 'string' ? args.channel : undefined,
    })
    console.log(`已发布 ${bold(`${artifact.name}@${artifact.version}`)}（${artifact.channel}，状态 ${artifact.status}）`)
    console.log(`  sha256    ${artifact.sha256}`)
    console.log(`  大小      ${artifact.sizeBytes} 字节`)
    console.log(`  摘要      ${artifact.summary || '（无）'}`)
    db.close()
    break
  }

  case 'login': {
    const service = serviceOf(args.service)
    if (!args.username) {
      console.error('需要 --username <账号>')
      process.exit(1)
    }
    const password = args.password ?? (await readPassword(`密码（${args.username}）：`))
    const result = await postJson(`${service}/dsh-market/auth/login`, {
      username: args.username,
      password,
    })
    if (!result.ok) {
      console.error(`登录失败：${result.body?.code ?? `HTTP ${result.status}`} ${result.body?.detail ?? ''}`)
      process.exit(1)
    }
    const file = storeToken(service, result.body.token, result.body.user?.username ?? args.username)
    console.log(`已登录 ${bold(result.body.user?.username ?? args.username)}（${service}）`)
    console.log(`  角色      ${result.body.role}`)
    console.log(`  权限组    ${(result.body.user?.groups ?? []).join('、') || '无'}`)
    console.log(`  令牌保存  ${file}`)
    if (result.body.mustChangePassword) {
      console.log('')
      console.log('  ⚠ 这个账号还没改初始密码，服务端会拒绝除改密外的所有请求。')
      console.log(`    先改密：node server\\cli.mjs passwd --service ${service}`)
    }
    break
  }

  case 'whoami': {
    const service = serviceOf(args.service)
    const token = args.token ?? readStoredToken()
    if (!token) {
      console.log(`未登录（${service}）。跑：node server\\cli.mjs login --username <账号>`)
      break
    }
    const response = await fetch(`${service}/dsh-market/auth/me`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    })
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      console.log(`令牌不可用：${body?.code ?? `HTTP ${response.status}`}`)
      break
    }
    console.log(`${bold(body.user.username)}（${service}）`)
    console.log(`  显示名    ${body.user.displayName}`)
    console.log(`  角色      ${body.role}`)
    console.log(`  权限组    ${(body.groups ?? []).join('、') || '无'}`)
    if (body.mustChangePassword) console.log(`  ${dim('待改密：node server\\cli.mjs passwd')}`)
    break
  }

  case 'logout': {
    forgetToken()
    console.log(`已清除本地令牌（${TOKEN_FILE}）`)
    break
  }

  case 'passwd': {
    const service = serviceOf(args.service)
    const token = args.token ?? readStoredToken()
    if (!token) {
      console.error('未登录，无法改密。先跑 login。')
      process.exit(1)
    }
    const next = args.password ?? (await readPassword('新密码（至少 12 位）：'))
    if (next.length < 12) {
      console.error('新密码至少 12 位')
      process.exit(1)
    }
    const result = await postJson(`${service}/dsh-market/auth/password`, { newPassword: next }, token)
    if (!result.ok) {
      console.error(`改密失败：${result.body?.code ?? `HTTP ${result.status}`} ${result.body?.detail ?? ''}`)
      process.exit(1)
    }
    console.log('密码已更新。如果是首登账号，现在可以正常使用了。')
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

