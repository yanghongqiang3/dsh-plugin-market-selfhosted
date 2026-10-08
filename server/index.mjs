/**
 * Market server — entry point.
 *
 *   node server/index.mjs                 # listen on 127.0.0.1:8787
 *   MARKET_PORT=9000 node server/index.mjs
 *   MARKET_DB=/var/lib/market/market.db MARKET_STORAGE=/var/lib/market/artifacts node server/index.mjs
 *
 * First run creates a bootstrap administrator and prints its initial password
 * once; the account is flagged must-change-password.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openDatabase } from './lib/db.js'
import { Store, DEFAULT_ADMIN } from './lib/store.js'
import { Artifacts } from './lib/artifacts.js'
import { createMarketServer } from './lib/http.js'

const HOST = process.env.MARKET_HOST ?? '127.0.0.1'
const PORT = Number(process.env.MARKET_PORT ?? 8787)
const CALLBACK_HOST = process.env.MARKET_CALLBACK_HOST ?? '127.0.0.1'
const DATA_DIR = resolve(process.env.MARKET_DATA_DIR ?? '.market')
const DB_FILE = resolve(process.env.MARKET_DB ?? join(DATA_DIR, 'market.db'))
const STORAGE_DIR = resolve(process.env.MARKET_STORAGE ?? join(DATA_DIR, 'artifacts'))

export function bootstrap({ dbFile = DB_FILE, storageDir = STORAGE_DIR } = {}) {
  const db = openDatabase(dbFile)
  const store = new Store(db)
  const artifacts = new Artifacts(db, storageDir)
  let created = null
  if (store.countUsers() === 0) {
    created = store.createUser({
      username: DEFAULT_ADMIN.username,
      password: DEFAULT_ADMIN.password,
      displayName: '管理员',
      role: 'admin',
      mustChangePassword: true,
      createdBy: 'system',
    })
    store.createGroup({ id: 'platform', name: 'platform', description: '平台组', by: 'system' })
  }
  return { db, store, artifacts, created, dbFile, storageDir }
}

/** Build a fully wired server without listening — used by tests. */
export function createApp({ dbFile = ':memory:', storageDir } = {}) {
  const dir = storageDir ?? join(process.env.TEMP ?? '/tmp', `market-test-${process.pid}-${Date.now()}`)
  const boot = bootstrap({ dbFile, storageDir: dir })
  const { server, routes } = createMarketServer({ store: boot.store, artifacts: boot.artifacts })
  return { ...boot, server, routes }
}

function main() {
  const { db, store, artifacts, created, dbFile, storageDir } = bootstrap()
  const { server } = createMarketServer({ store, artifacts })

  server.listen(PORT, HOST, () => {
    const base = `http://${CALLBACK_HOST}:${PORT}`
    console.log('dsh-plugin-marketplace-service')
    console.log(`  listening   ${HOST}:${PORT}`)
    console.log(`  base url    ${base}`)
    console.log(`  database    ${dbFile}`)
    console.log(`  artifacts   ${storageDir}`)
    console.log(`  users       ${store.countUsers()}`)
    console.log(`  plugins     ${artifacts.catalogRows().length}`)
    if (created) {
      console.log('')
      console.log('  bootstrap administrator created')
      console.log(`    username  ${created.username}`)
      console.log(`    password  ${DEFAULT_ADMIN.password}`)
      console.log('    -> 首次登录会强制改密')
    }
    console.log('')
  })

  const shutdown = (signal) => {
    console.log(`\n${signal} — shutting down`)
    server.close(() => {
      try {
        db.close()
      } catch {
        /* already closed */
      }
      process.exit(0)
    })
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('index.mjs')) {
  main()
}
