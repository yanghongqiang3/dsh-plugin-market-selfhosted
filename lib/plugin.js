/**
 * @dsh-internal/dsh-plugin-marketplace — host row (thin client).
 *
 * Accounts, groups, grants, sessions, the plugin catalog and the artifact bytes
 * all live in the standalone market service (`server/`). This row holds authority
 * over exactly one thing: turning an authorized download into files inside THIS
 * DSH profile. It decides nothing.
 *
 *   GET  /market                     the market page (talks to the service directly)
 *   GET  /dsh-market/config          where the service is, so the page knows where to call
 *   GET  /dsh-market/installed       what THIS profile holds from the market
 *   POST /dsh-market/install         { token, name, version, sha256 } -> verify, extract, register
 *   POST /dsh-market/uninstall       { name } -> remove files and registration
 *
 * Why install is local at all: `dsh.profile.bundles` and the profile's
 * `cordis.patch.yml` live on the operator's machine, so only this process can
 * write them. Authorization is NOT re-implemented here — the service has already
 * refused anything the caller may not have, and the bytes are hash-checked again
 * on arrival.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TarError, extractTarGz, readEntry } from './tar.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PREFIX = '/dsh-market'

const DSH_HOME =
  process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const PROFILE_DIR =
  process.env.DSH_PROFILE_DIR ??
  join(DSH_HOME, 'profiles', process.env.DSH_PROFILE ?? 'desktop')
const DIAG_LOG = process.env.MARKET_DIAG_LOG ?? join(DSH_HOME, 'plugin-marketplace-diag.log')

/**
 * Where the market service lives. Absent means "not configured": the page then
 * explains how to set it instead of silently serving stale local data.
 */
const SERVICE_URL = (process.env.MARKET_SERVICE_URL ?? '').replace(/\/+$/, '') || null
const SERVICE_TIMEOUT_MS = Number(process.env.MARKET_SERVICE_TIMEOUT_MS ?? 30_000)

const PATCH_FILE = join(PROFILE_DIR, 'cordis.patch.yml')
const BLOCK_BEGIN = '# >>> dsh-plugin-marketplace managed rows (do not edit inside) >>>'
const BLOCK_END = '# <<< dsh-plugin-marketplace managed rows <<<'

function diag(stage, detail) {
  try {
    mkdirSync(dirname(DIAG_LOG), { recursive: true })
    writeFileSync(
      DIAG_LOG,
      `${new Date().toISOString()} [${stage}] ${detail}\n`,
      { flag: 'a' },
    )
  } catch {
    /* diagnostics must never break the plugin */
  }
}

/**
 * The market page is served from the DSH origin (127.0.0.1:<dsh port>) but calls
 * the market service, which normally lives on another origin. Both backends must
 * therefore speak CORS, including the preflight for the JSON POSTs.
 */
function corsHeaders(req) {
  return {
    'access-control-allow-origin': req?.headers?.origin ?? '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  }
}

function json(res, status, payload, req) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...corsHeaders(req),
  })
  res.end(text)
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 16 * 1024) {
        reject(new Error('E_BODY_TOO_LARGE'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('E_BAD_JSON'))
      }
    })
    req.on('error', reject)
  })
}

// ------------------------------------------------------------ profile wiring

function readProfile() {
  const manifestPath = join(PROFILE_DIR, 'package.json')
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { name: 'dsh-profile', private: true }
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  return {
    manifestPath,
    manifest,
    bundles: Array.isArray(manifest.dsh.profile.bundles) ? [...manifest.dsh.profile.bundles] : [],
    dependencies: { ...(manifest.dependencies ?? {}) },
  }
}

function writeProfile(manifestPath, manifest) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function readPatchFile() {
  return existsSync(PATCH_FILE) ? readFileSync(PATCH_FILE, 'utf8') : ''
}

/** The managed block is edited as TEXT so operator content survives byte for byte. */
function stripManagedBlock(text) {
  const begin = text.indexOf(BLOCK_BEGIN)
  if (begin < 0) return text
  const end = text.indexOf(BLOCK_END)
  if (end < 0) return text.slice(0, begin)
  return text.slice(0, begin) + text.slice(end + BLOCK_END.length)
}

function managedBlock(text) {
  const begin = text.indexOf(BLOCK_BEGIN)
  if (begin < 0) return ''
  const end = text.indexOf(BLOCK_END)
  if (end < 0) return ''
  return text.slice(begin, end + BLOCK_END.length)
}

function pluginRowsFromBlock(block) {
  const rows = []
  const pattern = /-\s*id:\s*'([^']+)'\s*\n\s*name:\s*'([^']+)'/g
  let match
  while ((match = pattern.exec(block)) !== null) rows.push({ id: match[1], name: match[2] })
  return rows
}

function renderBlock(rows) {
  if (rows.length === 0) return ''
  const lines = [BLOCK_BEGIN]
  for (const row of rows) {
    lines.push(`- insert:`)
    lines.push(`    - id: '${row.id}'`)
    lines.push(`      name: '${row.name}'`)
  }
  lines.push(BLOCK_END)
  return lines.join('\n')
}

function addPluginRow(row) {
  const cleaned = stripManagedBlock(readPatchFile()).replace(/\s*$/, '')
  const rows = pluginRowsFromBlock(managedBlock(readPatchFile())).filter((item) => item.id !== row.id)
  rows.push(row)
  const next = `${cleaned}${cleaned ? '\n\n' : ''}${renderBlock(rows)}\n`
  writeFileSync(PATCH_FILE, next, 'utf8')
  diag('patch', `wrote patch row ${row.id} => ${row.name} (${rows.length} managed row(s))`)
  return rows
}

function removePluginRow(id) {
  const text = readPatchFile()
  const rows = pluginRowsFromBlock(managedBlock(text)).filter((row) => row.id !== id)
  const cleaned = stripManagedBlock(text).replace(/\s*$/, '')
  const block = renderBlock(rows)
  const next = `${cleaned}${block ? `\n\n${block}` : ''}\n`
  writeFileSync(PATCH_FILE, next, 'utf8')
  diag('patch', `removed patch row ${id} (${rows.length} managed row(s) left)`)
  return rows
}

function rowIdFor(name) {
  return `market-${name.replace(/^@/, '').replace(/[^a-zA-Z0-9]+/g, '-')}`
}

/** Everything this profile got from the market, discovered from its own files. */
function installed() {
  const { bundles } = readProfile()
  const rows = pluginRowsFromBlock(managedBlock(readPatchFile()))
  const entries = []
  for (const row of rows) {
    entries.push({ name: row.name.split('/')[0].startsWith('@') ? row.name.split('/').slice(0, 2).join('/') : row.name.split('/')[0], rowId: row.id, registeredAs: row.name, kind: 'plugin', owner: null, version: null })
  }
  for (const bundle of bundles) {
    if (entries.some((entry) => entry.name === bundle)) continue
    entries.push({ name: bundle, rowId: null, registeredAs: bundle, kind: 'bundle', owner: null, version: null })
  }
  // Fill in what the installed package itself says, so the list is not guesswork.
  for (const entry of entries) {
    const pkgPath = join(PROFILE_DIR, 'node_modules', ...entry.name.split('/'), 'package.json')
    if (!existsSync(pkgPath)) continue
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      entry.version = pkg.version ?? null
      entry.owner = pkg.dsh?.market?.owner ?? null
      entry.summary = pkg.dsh?.market?.summary ?? pkg.description ?? ''
    } catch {
      /* leave the placeholder values */
    }
  }
  return { profileDir: PROFILE_DIR, patchFile: PATCH_FILE, entries }
}

// ------------------------------------------------------------------- install

async function fetchFromService(path, { token, method = 'GET', body } = {}) {
  if (!SERVICE_URL) {
    return { ok: false, code: 'E_SERVICE_NOT_CONFIGURED', detail: '未配置 MARKET_SERVICE_URL' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SERVICE_TIMEOUT_MS)
  try {
    const response = await fetch(`${SERVICE_URL}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      let payload = null
      try {
        payload = await response.json()
      } catch {
        /* non-JSON error body */
      }
      return {
        ok: false,
        code: payload?.code ?? `E_SERVICE_HTTP_${response.status}`,
        detail: payload?.detail ?? null,
        status: response.status,
      }
    }
    return { ok: true, bytes: Buffer.from(await response.arrayBuffer()), headers: response.headers }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    diag('service', `${method} ${path} failed: ${error?.message ?? error}`)
    return {
      ok: false,
      code: aborted ? 'E_SERVICE_TIMEOUT' : 'E_SERVICE_UNREACHABLE',
      detail: `${SERVICE_URL}：${error?.message ?? error}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Install one authorized artifact.
 *
 * The local side never decides whether the install is allowed: it forwards the
 * caller's token and lets the service answer. What it DOES enforce locally is
 * integrity and containment — the bytes must hash to the sha256 the caller
 * received, the archive must be a well-formed package with the expected name,
 * and the extracted entries must stay inside their staging directory.
 */
async function installEntry({ token, name, version, sha256: expectedHash, channel }) {
  if (!name || typeof name !== 'string') {
    return { ok: false, code: 'E_BAD_REQUEST', detail: '需要 name' }
  }
  if (!token) {
    return { ok: false, code: 'E_NOT_LOGGED_IN', detail: '先登录市场再安装' }
  }

  const query = new URLSearchParams({ name })
  if (version) query.set('version', version)
  if (channel) query.set('channel', channel)

  const fetched = await fetchFromService(`${PREFIX}/download?${query}`, { token })
  if (!fetched.ok) return { ok: false, code: fetched.code, detail: fetched.detail }

  const headerHash = fetched.headers.get('x-artifact-sha256') ?? null
  const actualHash = createHash('sha256').update(fetched.bytes).digest('hex')

  // Verify against both the hash the caller was told and the one on the response.
  for (const [label, expected] of [['调用方', expectedHash], ['服务端响应头', headerHash]]) {
    if (expected && expected !== actualHash) {
      diag('install', `hash mismatch vs ${label}: expected=${expected} actual=${actualHash}`)
      return {
        ok: false,
        code: 'E_HASH_MISMATCH',
        detail: `下载内容与${label}声明的 sha256 不一致，已阻止安装`,
      }
    }
  }

  const staging = join(PROFILE_DIR, '.dsh-market-staging')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  let written
  try {
    written = extractTarGz(fetched.bytes, staging)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    const code = error instanceof TarError ? 'E_BAD_ARCHIVE' : 'E_EXTRACT_FAILED'
    return { ok: false, code, detail: String(error?.message ?? error) }
  }

  // Trust the archive's own manifest for how to register, not the caller's word.
  const pkgBytes = readEntry(fetched.bytes, 'package.json')
  if (!pkgBytes) {
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, code: 'E_NOT_PACKAGE', detail: '归档内没有 package.json' }
  }
  let pkg
  try {
    pkg = JSON.parse(pkgBytes.toString('utf8'))
  } catch {
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, code: 'E_BAD_PACKAGE_JSON', detail: '归档内的 package.json 不是有效 JSON' }
  }
  if (pkg.name !== name) {
    rmSync(staging, { recursive: true, force: true })
    return {
      ok: false,
      code: 'E_NAME_MISMATCH',
      detail: `归档声明的包名 ${pkg.name} 与请求的 ${name} 不一致`,
    }
  }

  // A package claiming to be a bundle must actually carry its patch layer, or
  // registering it in dsh.profile.bundles makes the whole profile fail to load.
  const bundleDecl = pkg?.dsh?.bundle?.patch
  if (bundleDecl) {
    for (const relative of [bundleDecl].flat()) {
      if (!existsSync(join(staging, relative))) {
        rmSync(staging, { recursive: true, force: true })
        return {
          ok: false,
          code: 'E_BUNDLE_PATCH_MISSING',
          detail: `声明 dsh.bundle.patch=${relative}，但归档内没有该文件`,
        }
      }
    }
  }

  const targetDir = join(PROFILE_DIR, 'node_modules', ...name.split('/'))
  mkdirSync(dirname(targetDir), { recursive: true })
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })
  for (const relative of written) {
    const from = join(staging, relative)
    const to = join(targetDir, relative)
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, readFileSync(from))
  }
  rmSync(staging, { recursive: true, force: true })

  // Registration is NOT unconditional:
  //   - a bundle -> dsh.profile.bundles (it carries its own patch layer)
  //   - a plugin -> a managed insert row in the profile patch layer, plus a
  //                 file: dependency for provenance
  const isBundle = Boolean(pkg?.dsh?.bundle)
  const { manifestPath, manifest, bundles, dependencies } = readProfile()
  let patchRows = null

  if (isBundle) {
    if (!bundles.includes(name)) {
      bundles.push(name)
      manifest.dsh.profile.bundles = bundles
      writeProfile(manifestPath, manifest)
    }
  } else {
    const spec = `file:${targetDir.replace(/\\/g, '/')}`
    if (dependencies[name] !== spec) {
      dependencies[name] = spec
      manifest.dependencies = dependencies
      writeProfile(manifestPath, manifest)
    }
    const row = { id: rowIdFor(name), name: pkg?.dsh?.market?.entry ?? name }
    patchRows = addPluginRow(row)
  }

  diag('install', `installed ${name}@${pkg.version} as ${isBundle ? 'BUNDLE' : 'PLUGIN'} -> ${targetDir}`)

  return {
    ok: true,
    name,
    version: pkg.version ?? version ?? null,
    target: targetDir,
    hashVerified: true,
    sha256: actualHash,
    files: written.length,
    kind: isBundle ? 'bundle' : 'plugin',
    registeredIn: isBundle ? 'dsh.profile.bundles' : 'cordis.patch.yml (profile patch layer)',
    patchRows,
    patchFile: PATCH_FILE,
    needRestart: true,
    bundles,
  }
}

function uninstallEntry(name) {
  if (!name || typeof name !== 'string') {
    return { ok: false, code: 'E_BAD_REQUEST', detail: '需要 name' }
  }
  const targetDir = join(PROFILE_DIR, 'node_modules', ...name.split('/'))
  let removedFiles = false
  if (existsSync(targetDir)) {
    try {
      rmSync(targetDir, { recursive: true, force: true })
      removedFiles = !existsSync(targetDir)
    } catch (error) {
      diag('uninstall', `filesystem removal failed for ${targetDir}: ${error?.message ?? error}`)
    }
  }
  // Drop the now-empty scope directory so the profile stays tidy.
  const parent = dirname(targetDir)
  if (name.startsWith('@') && existsSync(parent)) {
    try {
      if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true })
    } catch {
      /* non-fatal */
    }
  }

  const { manifestPath, manifest, bundles, dependencies } = readProfile()
  let changed = false
  const nextBundles = bundles.filter((item) => item !== name)
  if (nextBundles.length !== bundles.length) {
    manifest.dsh.profile.bundles = nextBundles
    changed = true
  }
  if (Object.hasOwn(dependencies, name)) {
    delete manifest.dependencies[name]
    changed = true
  }
  if (changed) writeProfile(manifestPath, manifest)

  const patchRows = removePluginRow(rowIdFor(name))
  diag('uninstall', `removed ${name} (files=${removedFiles}, registration=${changed})`)
  return {
    ok: true,
    needRestart: true,
    filesRemoved: removedFiles,
    registrationCleared: changed,
    patchRows,
    bundles: nextBundles,
  }
}

// ---------------------------------------------------------------------- page

function pageHtml() {
  const pagePath = join(HERE, '..', 'web', 'market.html')
  if (existsSync(pagePath)) return readFileSync(pagePath, 'utf8')
  return `<!doctype html><meta charset="utf-8"><title>内部插件市场</title>
<body style="font:14px system-ui;padding:24px">
<h1>内部插件市场</h1>
<p>页面资源缺失，期望路径：<code>${pagePath}</code></p>
</body>`
}

/**
 * Answer a CORS preflight. The page lives on the DSH origin and POSTs JSON to
 * this origin, so the browser will send OPTIONS first for the install call.
 */
function preflight(req, res) {
  if (req.method !== 'OPTIONS') return false
  res.writeHead(204, corsHeaders(req))
  res.end()
  return true
}

function routeTable() {
  return [
    [
      'prefix',
      '/market',
      (req, res) => {
        if (preflight(req, res)) return
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          ...corsHeaders(req),
        })
        res.end(pageHtml())
      },
    ],

    // The page is served from this origin but must call the market service, which
    // is a different origin in general. This hands it the base URL.
    [
      'prefix',
      `${PREFIX}/config`,
      (req, res) => {
        if (preflight(req, res)) return
        json(
          res,
          200,
          {
            ok: true,
            serviceUrl: SERVICE_URL,
            configured: Boolean(SERVICE_URL),
            profileDir: PROFILE_DIR,
            envVar: 'MARKET_SERVICE_URL',
          },
          req,
        )
      },
    ],

    ['prefix', `${PREFIX}/installed`, (req, res) => {
      if (preflight(req, res)) return
      json(res, 200, installed(), req)
    }],

    [
      'prefix',
      `${PREFIX}/install`,
      async (req, res) => {
        if (preflight(req, res)) return
        try {
          const body = await readBody(req)
          const outcome = await installEntry({
            token: body?.token,
            name: body?.name,
            version: body?.version,
            sha256: body?.sha256,
            channel: body?.channel,
          })
          json(
            res,
            outcome.ok ? 200 : outcome.code === 'E_NOT_LOGGED_IN' ? 401 : 409,
            outcome,
            req,
          )
        } catch (error) {
          const code = String(error?.message ?? error)
          const known = code === 'E_BAD_JSON' || code === 'E_BODY_TOO_LARGE'
          json(
            res,
            known ? 400 : 500,
            { ok: false, code: known ? code : 'E_INTERNAL', detail: String(error?.message ?? error) },
            req,
          )
        }
      },
    ],

    [
      'prefix',
      `${PREFIX}/uninstall`,
      async (req, res) => {
        if (preflight(req, res)) return
        try {
          const body = await readBody(req)
          json(res, 200, uninstallEntry(body?.name), req)
        } catch (error) {
          json(res, 400, { ok: false, code: 'E_BAD_JSON', detail: String(error?.message ?? error) }, req)
        }
      },
    ],
  ]
}

function registerRoutes(webServer, entries) {
  const disposers = []
  for (const [kind, path, handler] of entries) {
    try {
      const dispose = webServer.register({ kind, path, handler })
      if (typeof dispose !== 'function') {
        diag('register', `route ${kind} ${path} returned a non-function disposer (${typeof dispose})`)
      } else {
        disposers.push(dispose)
      }
    } catch (error) {
      diag('register', `route ${kind} ${path} threw: ${error?.stack ?? String(error)}`)
      throw error
    }
  }
  diag('register', `registered ${disposers.length}/${entries.length} routes`)
  return disposers
}

const POLL_MS = 250
const POLL_TIMEOUT_MS = 60_000

/**
 * Run `body()` once a dependency is ready.
 *
 * The loader decides activation order, so a service this row needs may not exist
 * yet when `apply` runs. Polling is required; treating `ctx.get()` returning
 * undefined as final is what made an earlier revision silently register nothing.
 */
function retryUntil(label, ready, body) {
  const startedAt = Date.now()
  let settled = false
  const attempt = () => {
    if (settled) return
    try {
      if (!ready()) {
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          settled = true
          diag('apply', `gave up waiting for ${label} after ${POLL_TIMEOUT_MS}ms`)
          return
        }
        setTimeout(attempt, POLL_MS)
        return
      }
      settled = true
      body(Date.now() - startedAt)
    } catch (error) {
      settled = true
      diag('apply', `${label} setup threw: ${error?.stack ?? String(error)}`)
    }
  }
  attempt()
}

// ------------------------------------------------------------------ shell entry

/**
 * Shell entry markup.
 *
 * HOW THIS REACHES THE UI — worth stating, because getting it wrong cost two
 * rewrites. The desktop shell does NOT serve its index over HTTP: `dsh-app://app`
 * returns `dsh-web-frontend/dist/index.html` straight from disk (electron main),
 * so `webServer.tapIndex` and the HTTP `renderIndex` path never run in Electron.
 * The desktop host instead ships injection ROWS over IPC:
 *
 *   dsh-desktop-host: process.send({ type: 'ready', injections: ctx.webServer.collectIndexInjections() })
 *   electron main:    ipcMain.handle(DESKTOP_IPC.boot, () => ({ injections, ... }))
 *   renderer:         for (const row of injections) switch (row.kind) { case 'html': body.insertAdjacentHTML('beforeend', row.html) ... }
 *
 * So `webserver/index-inject` is the channel that works in BOTH shells. Row kinds
 * are shared with the HTTP renderer, and an unknown kind is fatal there
 * ("web boot: unknown index injection row"), so the shape must be exact.
 */
const ENTRY_ID = 'dsh-marketplace-entry'

function entryStyle() {
  // Deliberately plain and high-contrast: an entry that blends into page content
  // is an entry nobody finds.
  return `#${ENTRY_ID}{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;`
    + 'display:flex;align-items:center;justify-content:center;gap:8px;height:28px;'
    + 'box-sizing:border-box;text-decoration:none;cursor:pointer;white-space:nowrap;'
    + 'font:600 12px/1 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif;'
    + 'color:#fff;background:#3b6ef5;box-shadow:0 -1px 6px rgba(0,0,0,.18)}'
    + `#${ENTRY_ID}:hover{background:#2f5fe0}`;
}

function entryMarkup() {
  return `<a id="${ENTRY_ID}" href="/market" title="内部插件市场" aria-label="内部插件市场">`
    + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"'
    + ' stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M4 8.5 6 4h12l2 4.5M4 8.5h16M4 8.5V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8.5M9 12h6"/>'
    + '</svg><span>内部插件市场 · 点击打开</span></a>';
}

/**
 * Register the entry as index-injection rows — the path that reaches the desktop
 * shell. `effects` collects disposers so unload cleans both registrations up.
 */
function registerEntryRows(ctx, webServer, effects) {
  if (webServer && typeof webServer.tapIndex === 'function') {
    const dispose = webServer.tapIndex((html) => {
      if (html.includes(`id="${ENTRY_ID}"`)) return html
      const block = `<style>${entryStyle()}</style>\n${entryMarkup()}`
      return html.includes('</body>') ? html.replace('</body>', `${block}\n</body>`) : `${html}\n${block}`
    })
    if (typeof dispose === 'function') effects.push(dispose)
    diag('entry', 'registered webServer.tapIndex (HTTP-served index)')
  }

  if (typeof ctx.on !== 'function') {
    diag('entry', 'ctx.on unavailable — index-inject rows NOT registered (Electron would show no entry)')
    return
  }
  const off = ctx.on('webserver/index-inject', (table) => {
    if (!Array.isArray(table)) return
    table.push({ kind: 'style', text: entryStyle() })
    table.push({ kind: 'html', placement: 'body', html: entryMarkup() })
  })
  if (typeof off === 'function') effects.push(off)
  diag('entry', 'registered webserver/index-inject rows (desktop + web shell)')
}

/**
 * Register routes and the shell entry.
 *
 * The entry is registered as soon as `webServer` exists — earlier than waiting on
 * anything else — because `collectIndexInjections()` runs once when the desktop
 * host reports ready, and the listener must already be attached by then.
 */
function mount(ctx) {
  let routeDisposers = null

  retryUntil(
    'webServer',
    () => {
      const webServer = ctx.get('webServer')
      return Boolean(webServer) && typeof webServer.register === 'function'
    },
    (waited) => {
      const webServer = ctx.get('webServer')
      const effects = []

      registerEntryRows(ctx, webServer, effects)

      routeDisposers = registerRoutes(webServer, routeTable())
      ctx.effect(
        () => () => {
          for (const dispose of [...routeDisposers, ...effects]) {
            try {
              dispose()
            } catch {
              /* disposal must not throw during unload */
            }
          }
        },
        'dsh-plugin-marketplace: routes and entry',
      )

      diag('apply', `routes and entry hooked after ${waited}ms`)
    },
  )
}

export const name = 'dsh-plugin-marketplace'

export function apply(ctx) {
  try {
    diag('apply', `entered; node=${process.version} electron=${process.versions.electron ?? '-'}`)
    diag('apply', `profile=${PROFILE_DIR}`)
    diag('apply', `service=${SERVICE_URL ?? '(未配置 MARKET_SERVICE_URL)'}`)
    mount(ctx)
  } catch (error) {
    diag('apply', `FAILED: ${error?.stack ?? String(error)}`)
    throw error
  }
}

