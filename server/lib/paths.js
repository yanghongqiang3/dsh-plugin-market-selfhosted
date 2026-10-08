/**
 * Where the market keeps its data.
 *
 * ONE module decides this, because the server and the CLI must never disagree —
 * a CLI that writes a different database than the running service looks exactly
 * like "my change had no effect".
 *
 * The default is `<repo>/.market`, resolved from THIS FILE's location rather than
 * from the working directory: a cwd-relative default silently puts the database
 * wherever the process happened to be started from. `.market/` is gitignored.
 *
 * Overrides, highest priority first:
 *   MARKET_DB        exact database file
 *   MARKET_STORAGE   exact artifact directory
 *   MARKET_DATA_DIR  directory holding both (default <repo>/.market)
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `<repo>/server/lib/paths.js` -> `<repo>` */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const DEFAULT_DATA_DIR = join(REPO_ROOT, '.market')

export const DATA_DIR = process.env.MARKET_DATA_DIR
  ? resolve(process.env.MARKET_DATA_DIR)
  : DEFAULT_DATA_DIR

export const DB_FILE = process.env.MARKET_DB
  ? resolve(process.env.MARKET_DB)
  : join(DATA_DIR, 'market.db')

export const STORAGE_DIR = process.env.MARKET_STORAGE
  ? resolve(process.env.MARKET_STORAGE)
  : join(DATA_DIR, 'artifacts')

/** Human-readable summary, printed by both entry points so the location is never a guess. */
export function describePaths() {
  return [
    `data dir   ${DATA_DIR}${DATA_DIR === DEFAULT_DATA_DIR ? '  (默认：仓库内)' : '  (来自 MARKET_DATA_DIR)'}`,
    `database   ${DB_FILE}`,
    `artifacts  ${STORAGE_DIR}`,
  ]
}
