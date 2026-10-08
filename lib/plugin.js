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
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TarError, extractTarGz, readEntry, readTarGz } from './tar.js'
import { detectPackagePrefix } from '../server/lib/layout.js'
import { compareVersions } from '../server/lib/version.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PREFIX = '/dsh-market'

/** This package's own name — what the service hands back and what we replace. */
const PKG_NAME = 'dsh-plugin-marketplace'

/** The registry's own name rule, so a bad name is refused here rather than silently skipped. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * On-disk directory for a skill, from its market package name.
 *
 * Flattened on purpose. A scoped package (`@dsh-internal/skill-x`) would otherwise need a
 * two-level tree, and the first version of this did exactly that — so `readMarketSkills`
 * scanned one level, found nothing, and every installed skill was silently invisible AND
 * unregistered. Flattening keeps the scan flat and makes uninstall a pure function of the
 * package name.
 *
 * `@` and `__` are safe in a directory name on every platform this runs on.
 */
function skillDirName(packageName) {
  return String(packageName).replace(/\//g, '__')
}

const DSH_HOME =
  process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const PROFILE_DIR =
  process.env.DSH_PROFILE_DIR ??
  join(DSH_HOME, 'profiles', process.env.DSH_PROFILE ?? 'desktop')
const DIAG_LOG = process.env.MARKET_DIAG_LOG ?? join(DSH_HOME, 'plugin-marketplace-diag.log')

/**
 * Where market-installed SKILLS live.
 *
 * Deliberately NOT `~/.dsh/skills`: that root belongs to the operator's own hand-written
 * skills, and a market that writes there cannot later tell its own files from theirs —
 * uninstalling one skill could delete one someone wrote by hand.
 *
 * Skills are not mounted by the loader at all, so this directory is not a plugin root;
 * the plugin reads it and registers each skill with `ctx.skills`, the registry's
 * documented entry point for sources that are not a filesystem provider.
 */
const MARKET_SKILLS_DIR = join(PROFILE_DIR, '.dsh-market-skills')

/** How often the skill directory is re-read. See `syncMarketSkills`. */
const MARKET_SKILL_POLL_MS = 2000

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
  /**
   * Market-installed skills.
   *
   * They have no patch row and no bundle entry, so without this they would be invisible
   * to `GET /dsh-market/installed` — and the page would offer 安装 for something already
   * installed. Found by reading their own directory, exactly like the plugin's other
   * entries are found by reading the profile.
   */
  for (const skill of readMarketSkills()) {
    entries.push({
      name: skill.packageName,
      rowId: null,
      registeredAs: skill.packageName,
      kind: 'skill',
      owner: null,
      // Read from the skill's own manifest — see `readMarketSkills`. Reporting `null` here is
      // what made the page offer 「更新到 1.0.0」 for an already-installed 1.0.0.
      version: skill.version ?? null,
      skillName: skill.name,
      summary: skill.description,
    })
  }
  // Fill in what the installed package itself says, so the list is not guesswork.
  for (const entry of entries) {
    // Skills were filled in above, from their own directory rather than `node_modules`.
    if (entry.kind === 'skill') continue
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

  /**
   * Find the manifest with the SAME rule the service used to accept it.
   *
   * This used to look up `package.json` at the archive ROOT ONLY, while the service accepted
   * an npm-layout archive (everything under `package/`). The result was an artifact the market
   * published, listed and served — and the client refused with `E_NOT_PACKAGE` at the last
   * step, with nothing in the earlier stages hinting at a problem. A zip made on Windows wraps
   * everything in a directory too, so it hit exactly the same wall.
   */
  let layout
  try {
    layout = detectPackagePrefix(readTarGz(fetched.bytes).keys())
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, code: 'E_BAD_ARCHIVE', detail: String(error?.message ?? error) }
  }
  if (layout.ok === false) {
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, code: layout.code, detail: layout.detail }
  }

  let written
  try {
    written = extractTarGz(fetched.bytes, staging, { stripPrefix: layout.prefix })
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    const code = error instanceof TarError ? 'E_BAD_ARCHIVE' : 'E_EXTRACT_FAILED'
    return { ok: false, code, detail: String(error?.message ?? error) }
  }

  // Trust the archive's own manifest for how to register, not the caller's word.
  const pkgBytes = readEntry(fetched.bytes, `${layout.prefix}package.json`)
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
  //
  // The test is `dsh.bundle.patch` being defined — NOT merely `dsh.bundle` being
  // present. dsh-app-boot decides "is a bundle" with
  // `bundleManifest(...)?.dsh?.bundle?.patch !== void 0`, and throws
  // "declares no dsh.bundle" for anything it finds in `bundles` without a patch.
  // Using `Boolean(dsh.bundle)` here would register such a package and break the
  // operator's profile on next launch.
  const bundleDecl = pkg?.dsh?.bundle?.patch
  const isBundle = bundleDecl !== undefined && bundleDecl !== null
  if (isBundle) {
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

  /**
   * A SKILL, not a plugin.
   *
   * Skills are not mounted by the loader at all — they are catalog entries the agent
   * reads on demand. So this branch writes files and nothing else: no patch row, no
   * `dsh.profile.bundles`, no `file:` dependency. The plugin registers them with
   * `ctx.skills` at startup, which is what puts them in the session catalog.
   *
   * That also means there is no linker to break: a skill cannot fail the profile at boot
   * the way a malformed bundle row can.
   */
  if (pkg?.dsh?.market?.kind === 'skill') {
    const skillDir = join(MARKET_SKILLS_DIR, skillDirName(name))
    const skillFile = join(staging, 'SKILL.md')
    if (!existsSync(skillFile)) {
      rmSync(staging, { recursive: true, force: true })
      return { ok: false, code: 'E_SKILL_MISSING', detail: '声明 kind=skill，但归档内没有 SKILL.md' }
    }
    let front = null
    try {
      front = parseSkillFrontmatter(readFileSync(skillFile, 'utf8'))
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      return { ok: false, code: 'E_SKILL_BAD_FRONTMATTER', detail: String(error?.message ?? error) }
    }
    // The registry rejects an invalid name outright, so catch it here where the message
    // can name the file.
    if (!SKILL_NAME_RE.test(front.name)) {
      rmSync(staging, { recursive: true, force: true })
      return {
        ok: false,
        code: 'E_SKILL_BAD_NAME',
        detail: `SKILL.md 的 name "${front.name}" 不是 kebab-case（只允许小写字母、数字与连字符）`,
      }
    }
    mkdirSync(dirname(skillDir), { recursive: true })
    rmSync(skillDir, { recursive: true, force: true })
    mkdirSync(skillDir, { recursive: true })
    for (const relative of written) {
      const to = join(skillDir, relative)
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, readFileSync(join(staging, relative)))
    }
    rmSync(staging, { recursive: true, force: true })
    diag('install', `installed SKILL ${name}@${pkg.version} -> ${skillDir} (registered as "${front.name}")`)
    return {
      ok: true,
      name,
      version: pkg.version ?? version ?? null,
      target: skillDir,
      hashVerified: true,
      sha256: actualHash,
      files: written.length,
      kind: 'skill',
      skillName: front.name,
      registeredIn: `${MARKET_SKILLS_DIR}（经 ctx.skills.register 进入目录，轮询保持同步）`,
      // No restart: the poller registers it live and the catalog refreshes at the next
      // model step. Unlike a plugin there is no loader row that only boot can pick up.
      needRestart: false,
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

  // Registration is NOT unconditional, and the two branches are not equivalent:
  //   - a bundle -> dsh.profile.bundles. That list only means "apply this
  //                 package's patch layer". It does NOT create a loader row.
  //   - a plugin -> a managed insert row in the profile patch layer, plus a
  //                 file: dependency for provenance. Only rows mount anything.
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
  /**
   * A market SKILL is just its directory.
   *
   * Nothing registered it in the profile — no patch row, no bundle entry, no dependency —
   * so removing the directory IS the whole uninstall, and the next start has one fewer
   * entry in the catalog.
   */
  const skillDir = join(MARKET_SKILLS_DIR, skillDirName(name))
  if (existsSync(skillDir)) {
    try {
      rmSync(skillDir, { recursive: true, force: true })
    } catch (error) {
      diag('uninstall', `skill removal failed for ${skillDir}: ${error?.message ?? error}`)
      return { ok: false, code: 'E_UNINSTALL_FAILED', detail: String(error?.message ?? error) }
    }
    // Drop the container once it is empty, so an uninstalled market leaves no trace.
    try {
      if (readdirSync(MARKET_SKILLS_DIR).length === 0) rmSync(MARKET_SKILLS_DIR, { recursive: true, force: true })
    } catch { /* non-fatal */ }
    diag('uninstall', `removed SKILL ${name}`)
    return { ok: true, name, kind: 'skill', removedFiles: true, needRestart: false }
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

/**
 * Static files the install page owns.
 *
 * The page is a small HTML file plus a shared shell and stylesheet that the server
 * console also uses (`web/shared.js`, `web/market.css`). Serving them from here as
 * well as from the service means the DSH-hosted page loads its own CSS without a
 * round trip to the service, and both surfaces keep reading the same single copy of
 * each file.
 *
 * `console.css` and `console.html` are deliberately ABSENT: they belong to the
 * server console, which is reached by URL and served by the service. Nothing in DSH
 * needs them, and this whitelist is also what keeps the asset route from becoming a
 * generic file server.
 */
const PAGE_ASSETS = {
  'market.html': 'text/html; charset=utf-8',
  'market.css': 'text/css; charset=utf-8',
  'shared.js': 'text/javascript; charset=utf-8',
}

function pageFile(name) {
  return join(HERE, '..', 'web', name)
}

function pageHtml() {
  const pagePath = pageFile('market.html')
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

/**
 * Every route this plugin owns.
 *
 * `ctx` is a PARAMETER, not a module-level global. An earlier revision called
 * `readDshIdentity(ctx)` from here without it being in scope, which threw a
 * ReferenceError; the webserver catches handler throws and answers a bare 400 with no
 * body and no log, so the page could only report "unknown reason".
 */
function routeTable(ctx) {
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

    // The page's own assets. `market.css` and `shared.js` are shared with the
    // server console, which serves the very same files from its own origin.
    //
    // TWO things here cost a debugging round each:
    //
    //  - the prefix must have NO trailing slash. The webserver matches
    //    `pathname === prefix || pathname.startsWith(prefix + '/')`, so a
    //    registered `/x/assets/` only ever matches `/x/assets//…` — 404 forever.
    //  - the webserver calls handlers as `handler(req, res)` with NO third
    //    argument. Taking a `url` parameter yields `undefined.pathname`, a throw,
    //    and a bare 400 from its own error path — with no body and no log. Parse
    //    the path from `req.url` instead.
    [
      'prefix',
      `${PREFIX}/assets`,
      (req, res) => {
        if (preflight(req, res)) return
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        const name = decodeURIComponent(pathname.slice(`${PREFIX}/assets/`.length))
        const type = Object.hasOwn(PAGE_ASSETS, name) ? PAGE_ASSETS[name] : undefined
        if (type === undefined || name.includes('..') || name.includes('/')) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...corsHeaders(req) })
          res.end('not found')
          return
        }
        const file = pageFile(name)
        if (!existsSync(file)) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...corsHeaders(req) })
          res.end('not found')
          return
        }
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...corsHeaders(req) })
        res.end(readFileSync(file))
      },
    ],

    /**
     * Who this machine's DSH account is.
     *
     * Reports the DSH account id, display name and device id so the page can show
     * who is installing. It deliberately does NOT forward the platform credential:
     * `getPlatformSession()` returns a live token, and a page that merely wants to
     * display an identity has no business holding one.
     *
     * Everything here is best-effort. The service can be absent, the user signed out,
     * or the network down — each of those means "no identity", which the page treats
     * as a reason to fall back to its own login rather than an error.
     *
     * Recorded fact, measured on this machine:
     *   getDeviceIdentity()  -> { deviceId, osVersion }            (userId absent)
     *   getProfile(meta)     -> { status:'ready', id, name, contact }   (needs network)
     *   getDeviceIdentity()  -> { deviceId, userId, osVersion }    (only AFTER a
     *                           successful profile read — the implementation copies
     *                           the id from the last profile read, so it is null
     *                           until something asks for the profile)
     */
    [
      'prefix',
      `${PREFIX}/identity`,
      async (req, res) => {
        if (preflight(req, res)) return
        const identity = await readDshIdentity(ctx)
        diag('identity', `source=${identity.source} userId=${identity.userId ?? '-'}`)
        json(res, 200, identity, req)
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

    /**
     * Where the market lives, for the client half.
     *
     * The client module knows the package name but not the bound port, and a
     * relative URL is useless to it: the shell's origin is `dsh-app://app`, so the
     * href must be absolute or the click becomes a same-window navigation that
     * replaces the shell.
     */
    [
      'prefix',
      `${PREFIX}/open`,
      (req, res) => {
        if (preflight(req, res)) return
        json(res, 200, { ok: true, url: marketUrlRef.current, configured: Boolean(SERVICE_URL) }, req)
      },
    ],

    /**
   * Store or clear the binding secret for THIS machine.
   *
   * Called by the market page right after a bind (`secret`) or an unbind (`clear`). Both
   * are same-origin POSTs and are refused otherwise — see `ownOrigin`.
   */
  [
    'prefix',
    `${PREFIX}/link`,
    async (req, res) => {
      if (preflight(req, res)) return
      if (!ownOrigin(req)) {
        json(res, 403, { ok: false, code: 'E_FOREIGN_ORIGIN' }, req)
        return
      }
      try {
        const body = await readBody(req)
        if (body?.clear === true) {
          clearLink()
          json(res, 200, { ok: true, cleared: true }, req)
          return
        }
        writeLink({
          dshUserId: String(body?.dshUserId ?? ''),
          secret: String(body?.secret ?? ''),
          marketUsername: body?.marketUsername ?? null,
        })
        json(res, 200, { ok: true, stored: true }, req)
      } catch (error) {
        json(res, 400, { ok: false, code: 'E_LINK_FAILED', detail: String(error?.message ?? error) }, req)
      }
    },
  ],

  /**
   * Trade the stored secret for a market session — the auto-login the page asks for.
   *
   * `GET` so the page can call it during boot without a body. Same-origin only, for the
   * same reason as `/link`: this hands out a session.
   */
  [
    'prefix',
    `${PREFIX}/session`,
    async (req, res) => {
      if (preflight(req, res)) return
      if (!ownOrigin(req)) {
        json(res, 403, { ok: false, code: 'E_FOREIGN_ORIGIN' }, req)
        return
      }
      const link = readLink()
      if (link === null) {
        json(res, 200, { ok: true, session: null, reason: 'E_NO_LOCAL_SECRET', hasSecret: false }, req)
        return
      }
      const result = await fetchJson(`${PREFIX}/identity/token`, {
        method: 'POST',
        body: { dshUserId: link.dshUserId, secret: link.secret },
      })
      if (!result.ok || result.token === undefined) {
        // A dead secret must not linger: it would be retried on every page load.
        if (result.code === 'E_NOT_BOUND' || result.code === 'E_BAD_SECRET' || result.code === 'E_NO_SECRET') {
          clearLink()
        }
        json(res, 200, {
          ok: true,
          session: null,
          reason: result.code ?? 'E_UNKNOWN',
          hasSecret: readLink() !== null,
        }, req)
        return
      }
      json(res, 200, {
        ok: true,
        hasSecret: true,
        session: { token: result.token, refresh: result.refresh, user: result.user },
      }, req)
    },
  ],

  /**
   * What a recall removed from this machine.
   *
   * The page shows it, because files disappearing from a profile with no explanation is a worse
   * failure than the one recall solves — the user would assume they broke something.
   */
  [
    'prefix',
    `${PREFIX}/recalled`,
    (req, res) => {
      if (preflight(req, res)) return
      const items = readRecalledRecord()
      json(res, 200, { ok: true, entries: items, count: items.length }, req)
    },
  ],

  /**
   * Clear the recall receipt — the user acknowledging they have read it.
   *
   * The receipt records a PAST removal, so lifting the recall must NOT erase it: the removal
   * still happened and the user still deserves to know. But it also must not sit there forever
   * implying a CURRENT state, which is exactly how it read — 「服务端召回」 in the present tense,
   * long after the recall was cancelled. So it stays until dismissed, and dismissing is one click.
   */
  [
    'prefix',
    `${PREFIX}/recalled/dismiss`,
    (req, res) => {
      if (preflight(req, res)) return
      // A foreign page must not be able to clear the user's notice. Same rule the binding
      // secret follows: only the market page this plugin serves may touch local state.
      if (!ownOrigin(req)) {
        json(res, 403, { ok: false, code: 'E_FOREIGN_ORIGIN' }, req)
        return
      }
      try {
        rmSync(RECALLED_FILE, { force: true })
      } catch (error) {
        json(res, 500, { ok: false, code: 'E_DISMISS_FAILED', detail: String(error?.message ?? error) }, req)
        return
      }
      diag('recall', 'receipt dismissed by the user')
      json(res, 200, { ok: true }, req)
    },
  ],

  [
    'prefix',
    `${PREFIX}/installed`, (req, res) => {
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

/**
 * Self-update: adopt the plugin package the service carries, at startup.
 *
 * WHY IT IS POSSIBLE AT ALL: the market cannot distribute this plugin through its own
 * artifact path — that format is flat, while an installable npm tarball must keep
 * everything under `package/`, and the market cannot install the plugin that is doing
 * the installing. But the service and the plugin are deployed together, so the service
 * is where a new package naturally lives: whoever updates the service already has the
 * new build in hand. `/dsh-market/self` hands it out.
 *
 * WHY IT TAKES EFFECT ONLY ON THE NEXT LAUNCH: a running module cannot replace its own
 * loaded files in any useful sense. Measured (`tools/probe-swap-mechanics.mjs`): writing
 * over a loaded `.js` SUCCEEDS on this platform, and the running process still executes
 * the old code from memory. So the swap is prepared and the next launch picks it up.
 * There is no way around that short of restarting DSH, which is not ours to do.
 *
 * WHY IT MUST NOT TOUCH A LINKED INSTALL: `node_modules/dsh-plugin-marketplace` is often
 * a junction — pnpm's layout, and how a development setup points at the working tree.
 * Writing through such a path replaces the real source. Measured:
 * `lstat().isSymbolicLink()` reports true and `readlink()` names the target. So a linked
 * install is never updated automatically; it is reported instead.
 */

/** The version of the package this module was loaded from. */
function runningVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/** Where this plugin is installed, from the profile's point of view. */
function installDir() {
  return join(PROFILE_DIR, 'node_modules', ...PKG_NAME.split('/'))
}

/**
 * Prepare the service's package for the next launch.
 *
 * Returned rather than thrown: every outcome degrades to "keep running what we have",
 * because a broken auto-update must never break the plugin. Logged, so it is
 * diagnosable rather than silent.
 */
async function applySelfUpdate({ token } = {}) {
  const current = runningVersion()
  if (current === null) return { status: 'skipped', reason: '读不到本机版本' }

  const meta = await fetchJson('/dsh-market/self', { token })
  if (!meta.ok || meta.available !== true) {
    return { status: 'skipped', reason: meta.ok ? '服务端没有放包' : (meta.code ?? '查询失败') }
  }
  if (compareVersions(meta.version, current) <= 0) {
    return { status: 'current', current, offered: meta.version }
  }

  const target = installDir()
  // Guard BEFORE downloading: a linked install's contents belong to somewhere else.
  let stat = null
  try { stat = lstatSync(target) } catch { stat = null }
  if (stat !== null && stat.isSymbolicLink()) {
    let where = '(未知)'
    try { where = readlinkSync(target) } catch { /* not readable on every platform */ }
    return { status: 'refused', reason: 'linked', current, offered: meta.version, target: where }
  }

  const fetched = await fetchFromService('/dsh-market/self/download', { token })
  if (!fetched.ok) return { status: 'failed', reason: fetched.code, current, offered: meta.version }
  const actual = createHash('sha256').update(fetched.bytes).digest('hex')
  const header = fetched.headers.get('x-artifact-sha256') ?? null
  if (actual !== meta.sha256 || (header !== null && header !== actual)) {
    return { status: 'failed', reason: 'E_HASH_MISMATCH', current, offered: meta.version }
  }

  // Stage first, then swap. Nothing touches the live directory until a complete, valid
  // tree exists beside it — an interrupted download must not be able to break a working
  // install.
  const staging = `${target}.staging`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    extractTarGz(fetched.bytes, staging, { stripPrefix: 'package/' })
    const staged = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8'))
    if (staged.name !== PKG_NAME || staged.version !== meta.version) {
      throw new Error(`暂存的是 ${staged.name}@${staged.version}，期望 ${PKG_NAME}@${meta.version}`)
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    return { status: 'failed', reason: String(error?.message ?? error), current, offered: meta.version }
  }

  // Two renames, the old tree kept until the new one is in place, so a failure between
  // them can be undone.
  const parked = `${target}.previous`
  rmSync(parked, { recursive: true, force: true })
  try {
    mkdirSync(dirname(target), { recursive: true })
    if (stat === null) {
      renameSync(staging, target)
    } else {
      renameSync(target, parked)
      try {
        renameSync(staging, target)
      } catch (error) {
        renameSync(parked, target)
        throw error
      }
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    return { status: 'failed', reason: String(error?.message ?? error), current, offered: meta.version }
  }
  // The old tree is no longer needed; leaving it would accumulate one per update.
  rmSync(parked, { recursive: true, force: true })

  diag('self-update', `staged ${meta.version} over ${current} at ${target}; takes effect on next launch`)
  return { status: 'staged', from: current, to: meta.version, target }
}

/** Filled in by `mount`, so the tick can wait until the host exists. */
let selfUpdateCtx = null

/** Run the check once, without letting any outcome reach the caller. */
function scheduleSelfUpdate() {
  retryUntil('self-update', () => selfUpdateCtx !== null, () => {
    if (process.env.MARKET_AUTO_UPDATE === '0') {
      diag('self-update', 'disabled by MARKET_AUTO_UPDATE=0')
      return
    }
    applySelfUpdate({ token: process.env.MARKET_SERVICE_TOKEN ?? null })
      .then((result) => diag('self-update', JSON.stringify(result)))
      .catch((error) => diag('self-update', `threw: ${error?.stack ?? String(error)}`))
  })
}

/** GET or POST a JSON document from the service. Never throws. */
async function fetchJson(path, { token, method = 'GET', body } = {}) {
  const result = await fetchFromService(path, { token, method, body })
  if (!result.ok) return result
  try {
    return { ok: true, ...JSON.parse(result.bytes.toString('utf8')) }
  } catch (error) {
    return { ok: false, code: 'E_BAD_JSON', detail: String(error?.message ?? error) }
  }
}

/**
 * The binding secret, kept in the profile.
 *
 * This is what makes auto-login possible WITHOUT treating the DSH account id as a
 * credential. The id is not a secret — measured on this machine, this plugin's own
 * `/dsh-market/identity` route reflects any Origin, so ANY website the user visits can
 * read it. A secret is.
 *
 * It lives here, in the profile, and never in the browser: the page asks this plugin for a
 * session and the plugin performs the exchange, so a script on the market page never sees
 * the credential.
 */
const LINK_FILE = join(PROFILE_DIR, '.dsh-market-link.json')

/**
 * What a RECALL removed from this machine, so the page can say so.
 *
 * A plugin or a skill disappearing from a profile without explanation is worse than the
 * problem recall solves — the user would assume they broke something. This file is the
 * receipt, and the market page reads it through `/dsh-market/recalled`.
 */
const RECALLED_FILE = join(PROFILE_DIR, '.dsh-market-recalled.json')

function readRecalledRecord() {
  try {
    const parsed = JSON.parse(readFileSync(RECALLED_FILE, 'utf8'))
    return Array.isArray(parsed?.items) ? parsed.items : []
  } catch {
    return []
  }
}

function appendRecalledRecord(removals) {
  if (removals.length === 0) return
  /**
   * One entry per name+version+kind, newest removal wins.
   *
   * Appending blindly produced duplicates for the same artifact after a reinstall-and-recall
   * cycle — the notice said "removed 2 items" while showing the same thing twice. The receipt
   * answers "what is gone from this machine", not "how many times did it happen".
   */
  const merged = new Map()
  for (const item of [...readRecalledRecord(), ...removals]) {
    merged.set(`${item.name}@${item.version}#${item.kind ?? ''}`, item)
  }
  const items = [...merged.values()]
  // Bounded: this is a notice, not an audit log. The service's own audit table is the record.
  const trimmed = items.slice(-50)
  try {
    writeFileSync(RECALLED_FILE, `${JSON.stringify({ items: trimmed }, null, 2)}\n`, 'utf8')
  } catch (error) {
    diag('recall', `could not write ${RECALLED_FILE}: ${error?.message ?? error}`)
  }
}

/**
 * A service token, or null.
 *
 * `MARKET_SERVICE_TOKEN` first — an operator who set it for self-update gets recall for free.
 * Otherwise the stored binding secret is exchanged, which is the only credential this machine
 * has without a human present. That is the same secret the auto-login path uses; it is read
 * here and never leaves the profile.
 */
async function reconcileToken() {
  const fromEnv = process.env.MARKET_SERVICE_TOKEN
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  const link = readLink()
  if (link === null) return null
  const issued = await fetchJson(`${PREFIX}/identity/token`, {
    method: 'POST',
    body: { dshUserId: link.dshUserId, secret: link.secret },
  })
  if (!issued.ok || typeof issued.token !== 'string') return null
  return issued.token
}

/**
 * Honour the service's recalls: remove what it asked to remove.
 *
 * Runs once per start. Two things are deliberately NOT done here:
 *
 *  - **Nothing is removed for a version mismatch.** A recall names a specific version; a name
 *    match alone would delete a newer, unrecalled copy.
 *  - **Nothing is removed silently.** Every removal is recorded in `RECALLED_FILE` and the
 *    market page shows it, because files vanishing from a profile with no explanation is a
 *    worse failure than the one recall solves.
 *
 * `MARKET_AUTO_RECALL=0` disables it, matching the self-update kill switch.
 */
async function reconcileRecalled() {
  if (process.env.MARKET_AUTO_RECALL === '0') {
    return { status: 'disabled', reason: 'MARKET_AUTO_RECALL=0' }
  }

  /** Local inventory: exactly what this profile holds, with the versions it holds. */
  const local = installed().entries
    .filter((entry) => typeof entry.name === 'string' && typeof entry.version === 'string' && entry.version !== '')
    .map((entry) => ({ name: entry.name, version: entry.version, channel: 'stable', kind: entry.kind }))
  if (local.length === 0) return { status: 'nothing-installed' }

  const token = await reconcileToken()
  if (token === null) return { status: 'no-credential' }

  const answer = await fetchJson(`${PREFIX}/installed-status`, {
    method: 'POST',
    token,
    body: { items: local.map(({ name, version, channel }) => ({ name, version, channel })) },
  })
  if (!answer.ok || !Array.isArray(answer.entries)) {
    return { status: 'query-failed', reason: answer.code ?? 'no entries' }
  }

  const removals = []
  for (const item of answer.entries) {
    if (item.recalled !== true) continue
    // Exact version only. `installed()` already reported the version it has, and the service
    // matched on name+version+channel, so this is the version it meant.
    const result = uninstallEntry(item.name)
    if (result?.ok !== true) {
      diag('recall', `failed to remove ${item.name}@${item.version}: ${result?.code ?? 'unknown'}`)
      continue
    }
    removals.push({
      name: item.name,
      version: item.version,
      channel: item.channel,
      kind: local.find((entry) => entry.name === item.name)?.kind ?? 'plugin',
      recalledAt: item.recalledAt ?? null,
      removedAt: Date.now(),
    })
    diag('recall', `removed ${item.name}@${item.version} (recalled)`)
  }

  appendRecalledRecord(removals)
  return {
    status: removals.length > 0 ? 'removed' : 'clean',
    removed: removals.map((entry) => `${entry.name}@${entry.version}`),
    // Plugins are mounted by the loader at boot, so their removal lands on the NEXT start;
    // skills are polled and disappear from the catalog within a couple of seconds.
    needRestart: removals.some((entry) => entry.kind !== 'skill'),
  }
}

function scheduleRecallReconcile() {
  retryUntil('recall', () => selfUpdateCtx !== null, () => {
    reconcileRecalled()
      .then((result) => diag('recall', JSON.stringify(result)))
      .catch((error) => diag('recall', `threw: ${error?.stack ?? String(error)}`))
  })
}

function readLink() {
  try {
    const parsed = JSON.parse(readFileSync(LINK_FILE, 'utf8'))
    if (typeof parsed?.secret !== 'string' || typeof parsed?.dshUserId !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

function writeLink({ dshUserId, secret, marketUsername = null }) {
  if (!dshUserId || !secret) throw new Error('dshUserId 与 secret 都是必需的')
  mkdirSync(dirname(LINK_FILE), { recursive: true })
  writeFileSync(
    LINK_FILE,
    JSON.stringify({ dshUserId, secret, marketUsername, savedAt: Date.now() }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  )
  diag('link', `stored binding secret for ${dshUserId}`)
}

function clearLink() {
  rmSync(LINK_FILE, { force: true })
  diag('link', 'cleared binding secret')
}

/** Bound once `webServer` is up, so the origin check knows the port. */
let webServerPort = null

/**
 * Only the market page, served by THIS plugin, may touch the binding secret.
 *
 * Without this check any website the user visits could POST to `127.0.0.1:<port>` and ask
 * for a session — handing out exactly the auto-login this feature is careful about. The
 * browser sets `Origin` on POST and cannot be talked out of it, so a mismatch is decisive.
 */
function ownOrigin(req) {
  const origin = req?.headers?.origin
  if (typeof origin !== 'string' || origin === '') return false
  const port = Number(webServerPort)
  if (!Number.isSafeInteger(port) || port <= 0) return false
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
}

/**
 * Parse a SKILL.md frontmatter block.
 *
 * A deliberately small parser: the fields a market skill needs are `name` (required),
 * `description` (required) and optionally `whenToUse` and the two invocation flags. A
 * full YAML parser is not worth a dependency here, and the registry validates what it is
 * given — so an unparsed field is dropped, not guessed at.
 *
 * YAML booleans are accepted in the spellings the filesystem provider documents
 * (`true/false`, `yes/no`, `on/off`, `1/0`), because a skill written for that provider
 * must not behave differently when the market installs it.
 */
function parseSkillFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) throw new Error('SKILL.md 没有以 --- 包起来的 frontmatter')
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (pair === null) continue
    let value = pair[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    fields[pair[1]] = value
  }
  if (typeof fields.name !== 'string' || fields.name === '') throw new Error('frontmatter 缺少 name')
  if (typeof fields.description !== 'string' || fields.description === '') {
    throw new Error('frontmatter 缺少 description')
  }
  const flag = (raw, fallback) => {
    if (raw === undefined) return fallback
    const lowered = String(raw).toLowerCase()
    if (['true', 'yes', 'on', '1'].includes(lowered)) return true
    if (['false', 'no', 'off', '0'].includes(lowered)) return false
    throw new Error(`调用开关 "${raw}" 不是布尔值`)
  }
  return {
    name: fields.name,
    description: fields.description,
    whenToUse: typeof fields.whenToUse === 'string' ? fields.whenToUse : null,
    modelInvocable: flag(fields['disable-model-invocation'], true) === false ? false : true,
    userInvocable: flag(fields['user-invocable'], true),
    body: text.slice(match[0].length),
  }
}

/**
 * Every market-installed skill, read from disk.
 *
 * Read at MOUNT time rather than watched: the filesystem provider exists for live
 * discovery, and this deliberately is not it. Market skills arrive through the install
 * route, which already tells the user a restart is needed — the same contract plugins
 * have, and one less moving part than a second watcher.
 */
function readMarketSkills() {
  const out = []
  let entries = []
  try {
    entries = readdirSync(MARKET_SKILLS_DIR, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = join(MARKET_SKILLS_DIR, entry.name, 'SKILL.md')
    if (!existsSync(file)) continue
    try {
      const front = parseSkillFrontmatter(readFileSync(file, 'utf8'))
      const stat = statSync(file)
      const manifest = skillManifestOf(join(MARKET_SKILLS_DIR, entry.name))
      out.push({
        /**
         * The real package name, read back from the `package.json` the archive carried.
         *
         * The directory name is FLATTENED (`@scope/name` becomes `@scope__name`), so it is
         * not the package name — and `installed()` must report something that uninstall can
         * be called with again.
         */
        packageName: manifest?.name ?? entry.name,
        /**
         * The installed version, from that same manifest.
         *
         * `installed()` used to report `null` here and SKIP skills when filling versions in,
         * on the grounds that a skill has no directory under `node_modules`. But it does have
         * a package.json — the one the archive carried, or the one the service synthesised —
         * so the page compared the catalog's "1.0.0" against `null`, found them different,
         * and offered 「更新到 1.0.0」 for a version already installed.
         */
        version: typeof manifest?.version === 'string' ? manifest.version : null,
        ...front,
        path: file,
        // Cheap change detector for the poller: only what actually moved is re-registered.
        signature: `${stat.mtimeMs}:${stat.size}`,
      })
    } catch (error) {
      // A broken skill must not take the whole plugin down; it is skipped and reported.
      diag('skills', `skipped ${entry.name}: ${error?.message ?? error}`)
    }
  }
  return out
}

/**
 * The `package.json` inside an installed skill directory.
 *
 * Each installed skill keeps the manifest its archive carried, and that is the only place the
 * un-flattened package name and the installed version still exist.
 */
function skillManifestOf(skillDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(skillDir, 'package.json'), 'utf8'))
    return typeof pkg?.name === 'string' && pkg.name !== '' ? pkg : null
  } catch {
    return null
  }
}

/**
 * Keep the skill catalog in step with the market's skill directory.
 *
 * The first version only registered at mount, so installing a skill meant restarting DSH
 * while the filesystem provider refreshes live. Users should not have to know which kind of
 * artifact they installed to guess whether a restart is needed.
 *
 * Re-registering needs care: `register()` is FIRST-WINS within a layer, so registering over
 * a live name is ignored with a warning rather than replacing it. An edited or reinstalled
 * skill therefore has to be disposed BEFORE its new definition is registered.
 *
 * Polling, not `fs.watch`: recursive watching is not portable, installs are rare, and two
 * `readdir`s every couple of seconds costs nothing next to being wrong about a change.
 *
 * @returns a disposer that stops the poller and unregisters everything it added.
 */
function syncMarketSkills(skills) {
  /** @type {Map<string, { signature: string, dispose: () => void }>} */
  const active = new Map()

  const run = () => {
    let onDisk
    try {
      onDisk = readMarketSkills()
    } catch (error) {
      diag('skills', `读取技能目录失败：${error?.message ?? error}`)
      return
    }
    const seen = new Set()
    for (const skill of onDisk) {
      seen.add(skill.name)
      const existing = active.get(skill.name)
      if (existing !== undefined && existing.signature === skill.signature) continue
      if (existing !== undefined) {
        try { existing.dispose() } catch { /* already gone */ }
        active.delete(skill.name)
      }
      try {
        const dispose = skills.register({
          name: skill.name,
          description: skill.description,
          ...(skill.whenToUse === null ? {} : { whenToUse: skill.whenToUse }),
          content: skill.body,
          path: skill.path,
          /**
           * `source` names WHERE within its provider a skill came from — the slot the
           * filesystem provider fills with `project-dsh` / `user-dsh` / `custom`.
           *
           * It is required, and required only at LOAD time: `register()` validates name,
           * description and invocation, while loading goes through `validateDefinition`,
           * which also demands that `source` and `provider` be strings. Omitting it produced
           * a skill that was listed and found by name, then failed to load with "source must
           * be a string" — invisible until someone actually loads the skill.
           */
          source: 'marketplace',
          invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
        })
        active.set(skill.name, { signature: skill.signature, dispose })
        diag('skills', `registered "${skill.name}" from ${skill.packageName}`)
      } catch (error) {
        // One bad skill must not stop the others, nor the plugin.
        diag('skills', `failed to register "${skill.name}": ${error?.message ?? error}`)
      }
    }
    // Anything that left the directory leaves the catalog too.
    for (const [name, entry] of [...active]) {
      if (seen.has(name)) continue
      try { entry.dispose() } catch { /* already gone */ }
      active.delete(name)
      diag('skills', `unregistered "${name}"`)
    }
  }

  run()
  const timer = setInterval(run, MARKET_SKILL_POLL_MS)
  // Never hold the process open on this account.
  if (typeof timer.unref === 'function') timer.unref()

  return () => {
    clearInterval(timer)
    for (const [, entry] of [...active]) {
      try { entry.dispose() } catch { /* teardown best effort */ }
    }
    active.clear()
  }
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
 * The market entry is registered by the CLIENT HALF (`lib/client.js`), not here.
 *
 * It used to be injected into document.body from this file, because that was the
 * only channel that needed no client module. That whole mechanism is gone: the
 * official guidance is to pick a slot that already allocates space and never to
 * write DOM outside your own component or measure another plugin's DOM to place
 * something. `lib/client.js` registers `sidebar.footer.action` and
 * `sidebar.panellist` through `ctx.slots.inject`, which also gets the collapsed
 * rail and theme tokens for free.
 *
 * This file keeps only the URL the client asks for.
 */

/**
 * Absolute URL of the market page on this host.
 *
 * The shell's origin is `dsh-app://app`, so a relative href cannot reach the host —
 * it must be absolute, or a click becomes a same-window navigation that replaces the
 * shell. Falls back to the relative path before the port is readable, which still
 * works for the HTTP-served shell.
 */
function marketUrlOn(webServer) {
  const port = Number(webServer?.port)
  if (!Number.isSafeInteger(port) || port <= 0) return '/market'
  return `http://127.0.0.1:${port}/market`
}

/**
 * Read this machine's DSH account identity, or report that there is none.
 *
 * Never throws: every failure mode (service absent, signed out, offline, unexpected
 * shape) collapses to `source: 'none'` with a reason, because the caller's fallback
 * is the ordinary login flow and an exception here would break the page instead.
 *
 * `source` is worth reporting to the UI, because the three cases mean different
 * things to the user: `none` = not signed into DSH, `device-only` = signed in but the
 * profile read did not happen or failed (so there is no stable account id yet), and
 * `account` = a stable account id is available.
 */
async function readDshIdentity(ctx) {
  const none = (reason) => ({ ok: true, source: 'none', reason, userId: null, name: null, deviceId: null })

  let account
  try {
    account = ctx.get('deepseekAccount')
  } catch (error) {
    return none(`ctx.get threw: ${error?.message ?? error}`)
  }
  if (account === undefined || account === null) return none('deepseekAccount 服务不可用')

  let deviceId = null
  let deviceUserId = null
  try {
    const device = await account.getDeviceIdentity()
    deviceId = device?.deviceId ?? null
    deviceUserId = device?.userId ?? null
  } catch (error) {
    diag('identity', `getDeviceIdentity failed: ${error?.message ?? error}`)
  }

  // The profile read is the only step that needs the network and a real sign-in, and
  // it is what makes the stable account id available at all.
  let userId = deviceUserId
  let name = null
  let profileNote = null
  try {
    const profile = await account.getProfile({
      version: '0.1.0',
      locale: 'zh_CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    })
    if (profile === null) {
      profileNote = '未登录或查询期间凭据变化'
    } else if (profile.status === 'ready') {
      userId = profile.value?.id ?? userId
      name = profile.value?.name ?? null
    } else {
      profileNote = '资料读取失败'
    }
  } catch (error) {
    profileNote = String(error?.message ?? error)
  }

  if (userId) {
    return { ok: true, source: 'account', reason: null, userId, name, deviceId, profileNote }
  }
  /**
   * No account id. The reason must NEVER be null here.
   *
   * The first version fell through to `reason: profileNote ?? '未登录 DSH 账号'`, and
   * `profileNote` was only set on some paths — so a profile that read successfully but
   * carried no id produced a null reason, and the page rendered 「未知原因」: a message
   * that told the user nothing and made this look like a DSH problem rather than a
   * reportable state. Every branch states something now.
   */
  const fallbackReason = deviceId
    ? '这台机器已登录 DSH，但没能取得账号 ID'
    : '这台机器没有登录 DSH 账号'
  return {
    ok: true,
    source: deviceId ? 'device-only' : 'none',
    reason: profileNote ?? fallbackReason,
    userId: null,
    name,
    deviceId,
    profileNote,
  }
}

/**
 * Bound once `webServer` is up, so `GET /dsh-market/open` can answer. Kept in a
 * one-field box rather than a plain variable because the route table closes over it
 * before the value exists.
 */
const marketUrlRef = { current: '/market' }

/**
 * Register routes.
 *
 * The in-app entry is NOT registered here: the client half owns it (see above).
 */
function mount(ctx) {
  let routeDisposers = null

  // Let the self-update tick start once the host exists. It waits on this rather than on
  // `webServer`, because it does not need routes — only a live context.
  selfUpdateCtx = ctx
  scheduleSelfUpdate()
  // Recalls are honoured once per start, on the same footing: both are "the service has
  // something to tell this machine, and no human is present to ask".
  scheduleRecallReconcile()

  /**
   * Put market-installed skills into the session catalog, and keep them there.
   *
   * `ctx.skills` is the registry; `register` is its documented entry point for sources
   * that are not a filesystem provider. Going through the registry (rather than writing
   * into a scanned root) is what keeps the market's skills separable from the operator's
   * own: nothing outside this directory is touched, and uninstalling one cannot delete a
   * skill someone wrote by hand.
   *
   * A missing `skills` service is not an error — a composition without skill support
   * simply has no catalog to contribute to. It IS logged, because the two cases look
   * identical from the outside otherwise: this plugin mounted with both "no skills
   * service" and "a service and an empty directory" and there was no way to tell which.
   */
  const skills = (() => {
    try { return ctx.get('skills') } catch { return undefined }
  })()
  if (skills === undefined || skills === null || typeof skills.register !== 'function') {
    diag('skills', 'ctx.skills 不可用，跳过 skill 注册（此组合没有 skill 支持）')
  } else {
    const origin = existsSync(MARKET_SKILLS_DIR) ? MARKET_SKILLS_DIR : `${MARKET_SKILLS_DIR}（尚不存在）`
    diag('skills', `ctx.skills 可用；目录 ${origin}；发现 ${readMarketSkills().length} 个技能`)
    ctx.effect(() => syncMarketSkills(skills))
  }

  retryUntil(
    'webServer',
    () => {
      const webServer = ctx.get('webServer')
      return Boolean(webServer) && typeof webServer.register === 'function'
    },
    (waited) => {
      const webServer = ctx.get('webServer')

      // The client half asks for this over `GET /dsh-market/open`; it has no way to
      // know the bound port.
      marketUrlRef.current = marketUrlOn(webServer)

      // The binding-secret routes check that a request comes from THIS origin, which
      // means they need the port. Set before routes are registered.
      webServerPort = Number(webServer?.port) || null

      routeDisposers = registerRoutes(webServer, routeTable(ctx))
      ctx.effect(
        () => () => {
          for (const dispose of routeDisposers) {
            try {
              dispose()
            } catch {
              /* disposal must not throw during unload */
            }
          }
        },
        'dsh-plugin-marketplace: routes',
      )

      diag('apply', `routes hooked after ${waited}ms ; market url = ${marketUrlRef.current}`)
    },
  )
}

export const name = 'dsh-plugin-marketplace'

/**
 * Exported for the probe, and only for it.
 *
 * Recall is security behaviour whose failure is silent — the plugin keeps running and nobody
 * notices — so it is tested directly rather than by waiting on a boot-time timer. The boot path
 * itself is asserted separately (that `apply` schedules it).
 */
export { reconcileRecalled }

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


