/**
 * Publish over HTTP, so pushing a plugin needs no shell on the server.
 *
 *   node server/cli.mjs login --username alice            # 取令牌并保存
 *   node server/cli.mjs publish --dir <pkg> --service http://host:8787
 *
 * The token is kept in `<DSH_HOME or ~>/.dsh/market-token.json` rather than an
 * environment variable: process environments leak through crash reports and
 * `ps`-style inspection far more easily than a mode-restricted file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { collectFiles, inspectArchive, packTarGz, sha256 } from './pack.js'

const DEFAULT_SERVICE = process.env.MARKET_SERVICE_URL ?? 'http://127.0.0.1:8787'
export const TOKEN_FILE =
  process.env.MARKET_TOKEN_FILE ??
  join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'market-token.json')

export function serviceOf(flag) {
  return (flag ?? DEFAULT_SERVICE).replace(/\/+$/, '')
}

export function readStoredToken() {
  if (!existsSync(TOKEN_FILE)) return null
  try {
    const parsed = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'))
    return parsed?.token ?? null
  } catch {
    return null
  }
}

export function storeToken(service, token, username) {
  mkdirSync(dirname(TOKEN_FILE), { recursive: true })
  writeFileSync(
    TOKEN_FILE,
    `${JSON.stringify({ service, token, username, savedAt: new Date().toISOString() }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
  return TOKEN_FILE
}

export function forgetToken() {
  if (existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, '{}\n', { encoding: 'utf8', mode: 0o600 })
}

/** POST JSON, returning { ok, status, body }. */
export async function postJson(url, body, token) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  })
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    parsed = null
  }
  return { ok: response.ok, status: response.status, body: parsed }
}

/**
 * Pack a directory and upload it. `dryRun` inspects server-side without writing,
 * which is the safe way to validate a build from CI.
 */
export async function publishDirectory({
  dir,
  service,
  token,
  state,
  channel,
  dryRun = false,
  onProgress = () => {},
}) {
  const files = collectFiles(dir)
  if (files.length === 0) throw new Error(`目录里没有可发布的文件：${dir}`)
  const archive = packTarGz(dir, files)

  // Inspect locally too: fail before spending an upload on something malformed.
  const inspection = inspectArchive(archive)
  if (!inspection.ok) {
    const error = new Error(inspection.detail ?? inspection.code)
    error.code = inspection.code
    throw error
  }

  const query = new URLSearchParams()
  if (!dryRun) query.set('commit', '1')
  if (state) query.set('state', state)
  if (channel) query.set('channel', channel)

  onProgress({
    name: inspection.pkg.name,
    version: inspection.pkg.version,
    files: files.length,
    bytes: archive.length,
    sha256: sha256(archive),
    dryRun,
  })

  const response = await fetch(`${service}/dsh-market/publish?${query}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/gzip',
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: archive,
  })

  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    parsed = null
  }
  if (!response.ok || !parsed?.ok) {
    const error = new Error(parsed?.detail ?? `HTTP ${response.status}`)
    error.code = parsed?.code ?? `E_HTTP_${response.status}`
    throw error
  }
  return { ...parsed, localSha256: sha256(archive), bytes: archive.length, files: files.length }
}
