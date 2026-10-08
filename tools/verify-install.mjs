// Pre-flight check for the marketplace install.
//
// The architecture is a bundle whose patch layer inserts ONE behavioural host
// row; the browser half is a page served by that row, not a DSH client plugin.
// This script verifies exactly that, plus the served page.
//
//   node tools/verify-install.mjs <profileDir>
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const profileDir =
  process.argv[2] ?? path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop')

const PKG = 'dsh-plugin-marketplace'

let problems = 0
const fail = (message) => (problems += 1, console.error(`FAIL  ${message}`))
const ok = (message) => console.log(`ok    ${message}`)

/** `exports` values are a string, or a conditions object like { default: "./x.js" }. */
function targetOf(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    for (const key of ['default', 'import', 'node', 'require']) {
      if (typeof value[key] === 'string') return value[key]
    }
  }
  return null
}

if (!fs.existsSync(profileDir)) {
  fail(`profile directory not found: ${profileDir}`)
  process.exit(1)
}
console.log(`profile: ${profileDir}\n`)

const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
const bundles = manifest?.dsh?.profile?.bundles ?? []
const req = createRequire(path.join(profileDir, 'noop.js'))

function resolveSpec(spec) {
  try {
    const resolved = req.resolve(spec)
    ok(`require.resolve("${spec}") -> ${resolved}`)
  } catch (error) {
    fail(`require.resolve("${spec}") failed: ${error.message.split('\n')[0]}`)
  }
}

console.log(`--- ${PKG} ---`)
if (!bundles.includes(PKG)) fail(`"${PKG}" is not listed in dsh.profile.bundles`)
else ok('listed in dsh.profile.bundles')

const dir = path.join(profileDir, 'node_modules', ...PKG.split('/'))
if (!fs.existsSync(dir)) {
  fail(`not present at ${dir}`)
  console.log(problems ? `\nRESULT: ${problems} problem(s)` : '')
  process.exit(1)
}
ok(`resolved on disk -> ${dir}`)

const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
const bundleEntry = targetOf(pkg.exports?.['.']) ?? pkg.main
const pluginEntry = targetOf(pkg.exports?.['./plugin'])
const patchEntry = targetOf(pkg.exports?.['./cordis.patch.yml'])

pkg.main ? ok(`main = ${pkg.main}`) : fail('main missing')
bundleEntry ? ok(`exports["."] = ${bundleEntry} (bundle entry)`) : fail('exports["."] missing')
pluginEntry ? ok(`exports["./plugin"] = ${pluginEntry} (host row)`) : fail('exports["./plugin"] missing')

if (pkg.dsh?.client) {
  fail('dsh.client must not be declared: the browser half is a served page, not a client plugin')
} else {
  ok('no dsh.client declaration (page is served by the host row)')
}
if (pkg.exports?.['./client']) {
  fail('exports["./client"] must not exist in this architecture')
} else {
  ok('no client export')
}

const patchDecl = pkg.dsh?.bundle?.patch
if (!patchDecl) fail('dsh.bundle.patch missing — the plugin manager refuses the package as a bundle')
else ok(`dsh.bundle.patch declared (${[patchDecl].flat().join(', ')})`)

if (bundleEntry) {
  const text = fs.readFileSync(path.join(dir, bundleEntry), 'utf8')
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').trim()
  stripped === 'export {}'
    ? ok('bundle entry is empty (export {}) — a behavioural root fails activation')
    : fail(`bundle entry carries behaviour (${JSON.stringify(stripped.slice(0, 60))})`)
}

if (patchEntry) {
  const patchText = fs.readFileSync(path.join(dir, patchEntry), 'utf8')
  patchText.includes(`${PKG}/plugin`)
    ? ok('patch layer inserts the plugin subpath')
    : fail(`patch layer must insert "${PKG}/plugin"`)
  const isInsertList = /^-\s*insert:/m.test(patchText)
  isInsertList ? ok('patch layer uses the insert list form') : fail('patch layer must be an insert list')
  const rowCount = (patchText.match(/^\s*-\s*id:/gm) ?? []).length
  rowCount === 1 ? ok('patch layer inserts exactly one row') : fail(`patch layer inserts ${rowCount} rows, expected 1`)
}

for (const [label, rel] of [['bundle', bundleEntry], ['plugin', pluginEntry]]) {
  if (!rel) continue
  const abs = path.join(dir, rel)
  fs.existsSync(abs)
    ? ok(`${label} entry exists (${fs.statSync(abs).size} bytes)`)
    : fail(`${label} entry missing`)
}

const pagePath = path.join(dir, 'web', 'market.html')
if (fs.existsSync(pagePath)) {
  const page = fs.readFileSync(pagePath, 'utf8')
  ok(`served page exists (web/market.html, ${page.length} chars)`)
  // The prefix must NOT be under /api: dsh-client-connection claims that prefix
  // for its RPC channel and answers 401 to any request without its browser auth.
  if (page.includes('/api/')) {
    fail('page fetches under /api/ — the connection layer owns that prefix and will answer 401')
  } else {
    ok('page fetches outside /api (connection layer does not intercept)')
  }
  // Service calls (cross-origin) vs local calls (this machine's profile).
  for (const route of ['auth/login', 'auth/me', 'catalog', 'detail', 'admin/users', 'admin/grants']) {
    page.includes(`/dsh-market/${route}`)
      ? ok(`page calls service /dsh-market/${route}`)
      : fail(`page does not call service /dsh-market/${route}`)
  }
  for (const route of ['config', 'install', 'uninstall', 'installed']) {
    page.includes(`/dsh-market/${route}`)
      ? ok(`page calls local /dsh-market/${route}`)
      : fail(`page does not call local /dsh-market/${route}`)
  }
  // The install state belongs on the card, not in a second list.
  page.includes('id="installed"')
    ? fail('page still renders a separate "installed" list — state belongs on the card')
    : ok('no separate installed list; card carries the install state')
  for (const token of ['已安装到本机', 'installedMap']) {
    page.includes(token) ? ok(`card state present: ${token}`) : fail(`card state missing: ${token}`)
  }
} else {
  fail('web/market.html missing — GET /market would serve a fallback notice')
}

// The client must not carry its own account/policy authority any more.
const pluginSource = fs.readFileSync(path.join(dir, 'lib', 'plugin.js'), 'utf8')
for (const stale of ['market-store.js', 'market-policy.js']) {
  pluginSource.includes(stale)
    ? fail(`lib/plugin.js still imports ${stale} — authority belongs to the service`)
    : ok(`lib/plugin.js does not import ${stale}`)
}
pluginSource.includes('MARKET_SERVICE_URL')
  ? ok('lib/plugin.js reads MARKET_SERVICE_URL')
  : fail('lib/plugin.js does not read MARKET_SERVICE_URL')
pluginSource.includes("from './tar.js'")
  ? ok('lib/plugin.js extracts archives via lib/tar.js')
  : fail('lib/plugin.js does not use lib/tar.js')

for (const file of ['server/index.mjs', 'server/cli.mjs', 'server/lib/policy.js', 'server/lib/store.js']) {
  fs.existsSync(path.join(dir, file)) ? ok(`service present: ${file}`) : fail(`service missing: ${file}`)
}

resolveSpec(PKG)
resolveSpec(`${PKG}/plugin`)

console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
