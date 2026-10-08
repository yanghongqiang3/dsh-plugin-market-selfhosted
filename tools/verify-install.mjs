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
import { pathToFileURL } from 'node:url'

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

// `dsh.client` and `exports["./client"]` are REQUIRED, not forbidden.
//
// These two checks previously asserted the opposite, describing the browser half as
// "a served page, not a client plugin". That was the design that failed: a page
// injected into document.body cannot respect the collapsed sidebar, cannot use theme
// tokens, and is explicitly discouraged ("choose a slot that already allocates
// space"; "do not write DOM outside your component"). The native entry is a client
// plugin, and its presence is asserted in detail further down.
pkg.dsh?.client
  ? ok('dsh.client declared (the native entry needs a client half)')
  : fail('dsh.client missing — the native sidebar entry cannot load')
pkg.exports?.['./client']
  ? ok('exports["./client"] present')
  : fail('exports["./client"] missing — dsh-client-modules would reject the package')

const patchDecl = pkg.dsh?.bundle?.patch
if (!patchDecl) fail('dsh.bundle.patch missing — the plugin manager refuses the package as a bundle')
else ok(`dsh.bundle.patch declared (${[patchDecl].flat().join(', ')})`)

// The bundle root must be a VALID plugin, i.e. export `apply`. It used to be required
// to be `export {}`; that requirement was wrong and it silently broke the client half,
// because the loader rejects an empty namespace and reports it only as
// `failed to import`. The behavioural half still lives in the `./plugin` row.
if (bundleEntry) {
  const text = fs.readFileSync(path.join(dir, bundleEntry), 'utf8')
  const exportedApply = /export\s+function\s+apply/.test(text)
  exportedApply
    ? ok('bundle entry exports apply — the loader rejects an empty namespace')
    : fail('bundle entry must export apply; an empty module gets no fiber and fails as "failed to import"')
}

if (patchEntry) {
  const patchText = fs.readFileSync(path.join(dir, patchEntry), 'utf8')
  patchText.includes(`${PKG}/plugin`)
    ? ok('patch layer inserts the plugin subpath')
    : fail(`patch layer must insert "${PKG}/plugin"`)
  const isInsertList = /^-\s*insert:/m.test(patchText)
  isInsertList ? ok('patch layer uses the insert list form') : fail('patch layer must be an insert list')
  // TWO rows: the host subpath plus the bare package name for the browser half.
  const rowCount = (patchText.match(/^\s*-\s*id:/gm) ?? []).length
  rowCount === 2
    ? ok('patch layer inserts exactly two rows (host subpath + bare client name)')
    : fail(`patch layer inserts ${rowCount} rows, expected 2`)
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

  /**
   * Where each call is made is now part of the contract.
   *
   * `auth/login`, `auth/me` and the local `config` probe moved into `web/shared.js`,
   * which both surfaces load. The service call `detail` is no longer made at all: it
   * was only used by the old admin tab. Asserting every route against the page alone
   * would now be asserting the wrong file.
   */
  const sharedSource = fs.readFileSync(path.join(dir, 'web', 'shared.js'), 'utf8')
  const consoleSource = fs.existsSync(path.join(dir, 'web', 'console.html'))
    ? fs.readFileSync(path.join(dir, 'web', 'console.html'), 'utf8')
    : ''

  for (const route of ['auth/login', 'auth/me', 'auth/password', 'auth/logout']) {
    sharedSource.includes(`/dsh-market/${route}`)
      ? ok(`shared shell calls /dsh-market/${route}`)
      : fail(`shared shell does not call /dsh-market/${route}`)
  }
  sharedSource.includes('/dsh-market/config')
    ? ok('shared shell probes the local host plugin for the service URL')
    : fail('shared shell does not probe /dsh-market/config')

  // Service calls this page owns, versus local calls this machine owns.
  page.includes('/dsh-market/catalog')
    ? ok('install page calls service /dsh-market/catalog')
    : fail('install page does not call /dsh-market/catalog')
  for (const route of ['install', 'uninstall', 'installed']) {
    page.includes(`/dsh-market/${route}`)
      ? ok(`install page calls local /dsh-market/${route}`)
      : fail(`install page does not call local /dsh-market/${route}`)
  }
  // Administration is the console's job; the page must not reach for it at all.
  for (const route of ['admin/users', 'admin/grants', 'admin/artifacts', 'publish']) {
    page.includes(`/dsh-market/${route}`)
      ? fail(`install page calls /dsh-market/${route} — that belongs to the console`)
      : ok(`install page does not call /dsh-market/${route}`)
    consoleSource.includes(`/dsh-market/${route}`)
      ? ok(`console calls /dsh-market/${route}`)
      : fail(`console does not call /dsh-market/${route}`)
  }
  // `detail` is gone: nothing renders a single-artifact detail view any more.
  page.includes('/dsh-market/detail')
    ? fail('install page calls /dsh-market/detail — the card already shows everything')
    : ok('install page no longer calls /dsh-market/detail')

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

/**
 * DSH-identity binding, and the one thing it must never leak.
 *
 * A plugin can read this machine's DSH account (id, name, device id) from the
 * composed account service. The page uses that so a user does not log in twice.
 * What it must NOT do is hand the page the platform CREDENTIAL: `getPlatformSession()`
 * returns a live token, and a page that only wants to display an identity has no
 * business holding one. A one-line mistake would expose it to any script on the page.
 */
{
  // Strip comments before matching. A first version did not, and failed on the very
  // comment that documents this rule — the same self-inflicted false positive this
  // project has hit repeatedly.
  const pluginCode = pluginSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  if (!/PREFIX\}\/identity/.test(pluginSource)) {
    fail('lib/plugin.js has no /dsh-market/identity route — the page cannot learn the DSH account')
  } else {
    ok('host plugin exposes /dsh-market/identity')
  }
  if (/getPlatformSession/.test(pluginCode)) {
    fail('lib/plugin.js calls getPlatformSession — that returns a live platform token and must not reach the page')
  } else {
    ok('host plugin never calls getPlatformSession (no credential exposure)')
  }
  // Only the identity reader matters here: `token` legitimately appears elsewhere in
  // this file (the install route forwards the caller's own market token to the
  // service). The check is scoped to the function that builds the page's payload.
  const identityFn = /async function readDshIdentity[\s\S]*?\n\}/.exec(pluginCode)?.[0] ?? ''
  if (identityFn === '') {
    fail('could not find readDshIdentity in lib/plugin.js')
  } else if (/token/i.test(identityFn)) {
    fail('readDshIdentity mentions a token — the page payload must carry no credential')
  } else {
    ok('readDshIdentity returns no credential field')
  }

  const marketPath = path.join(dir, 'web', 'market.html')
  if (fs.existsSync(marketPath)) {
    // Comments stripped for the binding checks too: several of these strings appear in
    // the comments that explain them, and matching those produced false failures here
    // before.
    const market = fs.readFileSync(marketPath, 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

    market.includes('/dsh-market/identity/bind')
      ? ok('install page can bind the DSH account')
      : fail('install page never binds the DSH account')
    /**
     * The market side of a binding comes from the TOKEN, never from a body field.
     *
     * Scoped to the bind CALL, not the whole page. The page also posts a `marketUsername`
     * to the local plugin's `/dsh-market/link` route — a label for the stored secret, with
     * no authority — and matching the whole file flagged that as a bypass. The assertion
     * is about what `/identity/bind` receives.
     */
    const bindBlock = /async function bindIdentity\(\)[\s\S]*?\n\}/.exec(market)?.[0] ?? ''
    if (bindBlock === '') {
      fail('could not find the bindIdentity block in the install page')
    } else if (/marketUsername/.test(bindBlock)) {
      fail('install page sends marketUsername to /identity/bind — the market side must come from the token only')
    } else {
      ok('install page does not send a market account in the bind body')
    }
    for (const code of ['E_DSH_ALREADY_BOUND', 'E_MARKET_ALREADY_BOUND']) {
      market.includes(code)
        ? ok(`install page explains the ${code} conflict`)
        : fail(`install page does not distinguish ${code} — the user cannot tell which side to release`)
    }
    market.includes('beforeBoot')
      ? ok('install page reads the DSH identity before the boot flow continues')
      : fail('install page does not read the identity before boot — the login screen could not name the account')

    /**
     * Binding is MANUAL, and that is a product decision worth protecting.
     *
     * The first version bound on sign-in, which claims a one-to-one slot without
     * asking: a user who signs into the wrong market account silently consumes a
     * binding, and only an administrator can release it. So the bind call must not be
     * reachable from the sign-in path — only from an explicit click.
     */
    const authBlock = /S\.onAuthenticated\(async \(\) => \{[\s\S]*?\n\}\)/.exec(market)?.[0] ?? ''
    if (authBlock === '') {
      fail('could not find the S.onAuthenticated block in the install page')
    } else if (/bindIdentity\(/.test(authBlock)) {
      fail('the sign-in path still binds automatically — a one-to-one slot must not be claimed without a click')
    } else {
      ok('sign-in does not bind automatically')
    }
    /addEventListener\('click',\s*doBind\)/.test(market)
      ? ok('an explicit click performs the binding')
      : fail('no explicit bind action — the user could never bind')
    // A button that always fails on a taken account is worse than one that says so.
    // Written as an if: a bare regex as a ternary condition parses as division.
    if (market.includes('/dsh-market/identity/lookup')) {
      ok('install page checks the slot before offering the bind action')
    } else {
      fail('install page never asks /identity/lookup — a taken account would only fail after the click')
    }
    if (/id="binding"/.test(market)) {
      ok('install page has a binding bar showing state and action')
    } else {
      fail('install page has no binding UI')
    }

    /**
     * The kind tabs, paging, and the fact that SEARCH went to the service.
     *
     * The tabs only work because the filter is applied server-side. While the whole catalog
     * arrived in one response, filtering in the browser was equivalent; with pages it searches
     * just the page on screen and reports "no match" for entries that are on another page.
     */
    for (const kind of ['all', 'plugin', 'skill']) {
      market.includes(`data-kind="${kind}"`)
        ? ok(`install page has the ${kind} tab`)
        : fail(`install page has no ${kind} tab`)
    }
    market.includes('MarketShell.makePager')
      ? ok('install page pages the catalog through the shared pager')
      : fail('install page has no pager — results are not paginated')
    market.includes("params.set('q'") || market.includes('set(\'q\'')
      ? ok('install page sends the search term to the service')
      : fail('install page still filters the loaded page — search would miss other pages')
    if (/addEventListener\('input', \(\) => \{ if \(catalog\) renderGrid\(\) \}\)/.test(market)) {
      fail('install page still re-renders locally on input instead of re-querying')
    } else {
      ok('search re-queries rather than re-rendering the loaded page')
    }
    // The card has to SAY which it is: the two install differently.
    /tag\(kind === 'skill' \? '技能' : '插件'/.test(market)
      ? ok('cards label 技能 / 插件')
      : fail('cards do not say whether the entry is a skill or a plugin')
    // The note claimed a filter that the catalog has never applied.
    if (market.includes('只显示你的权限组被授权的条目')) {
      fail('install page still claims it only shows authorized entries — it lists all, annotated')
    } else {
      ok('install page describes the catalog as it actually behaves')
    }

    /**
     * `global` must not appear bare in this page.
     *
     * It exists only as the IIFE parameter inside `shared.js`. At the top level of this
     * page's script it is UNDEFINED, so `global.setTimeout(...)` threw on the first keystroke
     * — searching did nothing, silently — and `global.localStorage` threw inside the
     * auto-login path, AFTER the token was set and before `setMe`, breaking auto-login on any
     * machine that had a binding secret. A browser found both; a source-level grep is what
     * stops the next one, because neither produced an error the user could see.
     */
    const bareGlobal = /(?<!globalThis)(?<![\w.$])global\s*\.\s*[A-Za-z_$]/.exec(market)
    if (bareGlobal === null) {
      ok('install page uses globalThis, not the undefined bare `global`')
    } else {
      fail(`install page uses bare \`global\` (${bareGlobal[0].trim()}) — that is undefined in a browser page and throws at runtime`)
    }

    /**
     * Unbinding is the USER'S action, not an administrator's.
     *
     * The operator's rule. The first implementation locked it to administrators — and
     * the install page's button was disabled for everyone, the administrator included,
     * so nobody could release a binding from the page at all. Releasing your own
     * account link has to be yours to do.
     */
    if (market.includes('/dsh-market/identity/unbind')) {
      ok('install page can release the binding itself')
    } else {
      fail('install page cannot unbind — releasing the user own link would need an administrator')
    }
    if (/addEventListener\('click',\s*doUnbind\)/.test(market)) {
      ok('an explicit click performs the unbinding')
    } else {
      fail('no explicit unbind action on the install page')
    }
    if (market.includes('需管理员')) {
      fail('install page still tells the user unbinding needs an administrator')
    } else {
      ok('install page does not defer unbinding to an administrator')
    }
    // The self-unbind route carries no identifier: it releases the caller's own link.
    if (/identity\/unbind[\s\S]{0,140}?(dshUserId|marketUsername)/.test(market)) {
      fail('install page sends an identifier to /identity/unbind — it must release the caller own link')
    } else {
      ok('install page sends no identifier when unbinding itself')
    }
  }

  const consolePath2 = path.join(dir, 'web', 'console.html')
  if (fs.existsSync(consolePath2)) {
    const consolePage = fs.readFileSync(consolePath2, 'utf8')
    consolePage.includes('/dsh-market/admin/identity')
      ? ok('console lists the bindings')
      : fail('console cannot list the bindings — an administrator cannot see who holds a slot')
    consolePage.includes('/dsh-market/admin/identity/unbind')
      ? ok('console can release a binding')
      : fail('console cannot release a binding')

    /**
     * The console must not describe binding as automatic.
     *
     * It did, for a while after binding became manual: the README was updated and this
     * page was missed, so the admin-facing description of the feature was wrong. Text
     * drifts out of date silently, which is exactly what a check is for.
     */
    consolePage.includes('登录时自动完成')
      ? fail('console still says binding happens automatically on sign-in')
      : ok('console does not claim binding is automatic')
    // And it must not tell users that releasing a binding needs an administrator — the
    // install page lets them do it themselves.
    consolePage.includes('需管理员解绑')
      ? fail('console claims unbinding needs an administrator')
      : ok('console does not contradict self-service unbinding')
  }
}

/**
 * Two surfaces, two jobs — and neither may grow into the other again.
 *
 * The single-page version put a 权限管理 tab next to the plugin catalog. Every user
 * saw an admin tab they could not use, and administrators had to navigate a catalog
 * to reach policy work. Administration now lives in the SERVER console, reached by
 * URL and served by the service; the DSH page is install/uninstall only.
 *
 * Comments are stripped before matching: a first attempt matched the explanatory
 * comments describing this very split and failed on files that were correct.
 */
{
  const stripComments = (text) => text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  const marketPath = path.join(dir, 'web', 'market.html')
  const consolePath = path.join(dir, 'web', 'console.html')

  if (!fs.existsSync(consolePath)) {
    fail('web/console.html missing — administration would have nowhere to live')
  } else {
    ok('web/console.html exists (administration lives here)')
  }

  if (fs.existsSync(marketPath)) {
    const market = stripComments(fs.readFileSync(marketPath, 'utf8'))
    // Admin ROUTES are the real tell; `entry.status === 'published'` is a catalog
    // field and stays.
    const adminRoutes = ['/dsh-market/admin/', '/dsh-market/publish']
    const leaked = adminRoutes.filter((route) => market.includes(route))
    if (leaked.length > 0) {
      fail(`the DSH install page calls admin routes: ${leaked.join(', ')} — administration belongs to the console`)
    } else {
      ok('DSH install page calls no admin or publish route')
    }
    if (market.includes('id="tab-admin"') || market.includes('panel-admin')) {
      fail('the DSH install page still has an admin tab')
    } else {
      ok('no admin tab on the DSH install page')
    }
    if (market.includes('/dsh-market/install') && market.includes('/dsh-market/uninstall')) {
      ok('DSH install page offers install and uninstall')
    } else {
      fail('DSH install page must offer both install and uninstall')
    }

    /**
     * The installed list is keyed `entries`, not `installed`.
     *
     * `GET /dsh-market/installed` answers `{ profileDir, patchFile, entries }`. The
     * page read `body.installed`, so the map stayed empty and EVERY plugin showed as
     * 未安装 — including ones installed from this very page a moment earlier. The
     * preflight passed throughout, because "the page renders a card" says nothing
     * about which key it reads.
     */
    if (/body\?\.installed\b/.test(market)) {
      fail('DSH install page reads body.installed — the host plugin answers with `entries`')
    } else {
      ok('DSH install page reads the installed list from the right key')
    }
    if (/body\?\.entries\b/.test(market)) {
      ok('DSH install page expects `entries` from /dsh-market/installed')
    } else {
      fail('DSH install page does not read `entries` from /dsh-market/installed')
    }

    // Installed state must be known BEFORE the grid is drawn, or every card is
    // rendered as not-installed and only a second pass hides it.
    const installedIdx = market.indexOf('await loadInstalled()')
    const catalogIdx = market.indexOf('await loadCatalog()')
    if (installedIdx >= 0 && catalogIdx >= 0 && installedIdx < catalogIdx) {
      ok('installed state is loaded before the catalog is rendered')
    } else {
      fail('the catalog is rendered before the installed list is known — cards would offer 安装 for installed plugins')
    }
  }

  if (fs.existsSync(consolePath)) {
    const consolePage = stripComments(fs.readFileSync(consolePath, 'utf8'))
    // Read here rather than at the bottom of the block: the stylesheet assertions below
    // need it, and `const` is not hoisted.
    const sharedCss = fs.readFileSync(path.join(dir, 'web', 'market.css'), 'utf8')
    const sharedSource = fs.readFileSync(path.join(dir, 'web', 'shared.js'), 'utf8')
    const installs = ['/dsh-market/install', '/dsh-market/uninstall']
    const leaked = installs.filter((route) => consolePage.includes(route))
    if (leaked.length > 0) {
      fail(`the console calls install routes: ${leaked.join(', ')} — installing belongs to the DSH page`)
    } else {
      ok('console calls no install or uninstall route')
    }
    for (const route of ['/dsh-market/admin/users', '/dsh-market/admin/grants', '/dsh-market/publish']) {
      consolePage.includes(route)
        ? ok(`console calls ${route}`)
        : fail(`console is missing ${route}`)
    }
    // The console must be self-contained, not embedded in DSH.
    if (consolePage.includes('/dsh-market/config')) {
      fail('console reads the DSH host plugin config — it must stand on its own URL')
    } else {
      ok('console does not depend on the DSH host plugin')
    }
    /**
     * ...and it must SAY so at boot.
     *
     * Being served by the service is not enough. Without this flag the shared shell
     * still probed `/dsh-market/config` — a route of the LOCAL plugin, absent on the
     * service origin — got a 404, and concluded "not configured". The console then
     * showed 「服务端未就绪」 on a perfectly healthy service. Merely asserting the
     * ABSENCE of that string was not sufficient, so the presence of the flag is
     * asserted too.
     */
    if (/serveSelf:\s*true/.test(consolePage)) {
      ok('console declares serveSelf — it uses its own origin as the service URL')
    } else {
      fail('console does not declare serveSelf: true — it would probe the DSH host plugin and report itself as not ready')
    }

    /**
     * The service reports `role`, never a boolean `isAdmin`.
     *
     * The console read `state.me.isAdmin`, which is `undefined` for everyone, so the
     * real administrator was sent to 「需要管理员权限」. The same confusion appeared in
     * the request payloads, where the service silently coerced the wrong field:
     * `{ isAdmin }` on create/role, and `{ disabled }` on status where it expects
     * `{ status: 'active' | 'disabled' }` — so 「停用」 appeared to do nothing.
     *
     * Only a FIELD ACCESS counts. A local `const isAdmin = user.role === 'admin'` is
     * correct code, and flagging it was this check's first version's mistake.
     */
    const readsAdminField = /\.isAdmin\b/.test(consolePage) || /isAdmin\s*:/.test(consolePage)
    if (readsAdminField) {
      fail('console reads or sends a boolean `isAdmin` field — the service uses `role: "admin" | "member"`')
    } else {
      ok('console uses the `role` field the service actually reports')
    }
    /**
     * The payload, not the spelling.
     *
     * The first version of this check matched one exact ternary
     * (`role: isAdmin ? 'member' : 'admin'`). Replacing that expression with a `<select>`
     * whose value is sent verbatim left the payload MORE correct and the check failing —
     * a test pinned to a phrasing rather than to the thing that matters. What matters is
     * that the body sent to `/admin/role` carries `role`.
     */
    const roleRoute = consolePage.includes('/dsh-market/admin/role')
    const roleBody = /body:\s*\{[^}]*\brole:/.test(consolePage)
    if (roleRoute && roleBody) {
      ok('console sends `{ role }` when changing a role')
    } else {
      fail('console does not send `{ role }` to /dsh-market/admin/role')
    }
    if (/status:\s*disabled\s*\?\s*'active'\s*:\s*'disabled'/.test(consolePage)) {
      ok('console sends `{ status: "active" | "disabled" }` when toggling an account')
    } else {
      fail('console does not send `{ status }` to /dsh-market/admin/status')
    }

    /**
     * The console uses the shared pagination and dialog primitives.
     *
     * The tables used to render whole lists with inline forms beside them, and every list
     * rolled its own slicing. Asserting the PRIMITIVES are used is what stops a future
     * pane from quietly going back to a bespoke table that paginates differently or
     * reintroduces a permanent form column.
     */
    for (const [label, needle] of [
      ['分页控件', 'makePager'],
      ['弹窗表单', 'openForm'],
      ['确认弹窗', 'openConfirm'],
      ['列标题', 'thead'],
    ]) {
      consolePage.includes(needle) ? ok(`console 使用了共享的${label}`) : fail(`console 没有使用共享的${label}`)
    }
    // Server-side paging means every list request carries limit/offset.
    if (/limit: String\(pager\[/.test(consolePage) || consolePage.includes("'limit'")) {
      ok('console 的列表请求带 limit')
    } else {
      fail('console 的列表请求没有 limit —— 分页没有真正下推到服务端')
    }
    // Bindings belong in the account row; a separate tab must not come back.
    if (/data-panel="identity"/.test(consolePage)) {
      fail('console 又把「身份绑定」做成了独立 tab —— 绑定属于账号行')
    } else {
      ok('console 没有把绑定拆成独立 tab')
    }
    // Destructive actions must ask first.
    if (consolePage.includes("await openConfirm(")) {
      ok('console 的破坏性操作走确认弹窗')
    } else {
      fail('console 的破坏性操作没有确认步骤')
    }
    // An <dialog> dismissed with Escape fires `close` WITHOUT running our close helper,
    // so the element must remove itself on that event or every Escape leaks a node.
    if (/addEventListener\('close',\s*\(\)\s*=>\s*(dialog|dlg)\.remove\(\)\)/.test(sharedSource)) {
      ok('shared 的弹窗在 close 事件上自清理（Esc 不泄漏节点）')
    } else {
      fail('shared 的弹窗没有监听 close 事件 —— 原生 Esc 关闭后会留下孤立节点')
    }
    // The one CSS bug that made every table in both surfaces unstyled: rules were written
    // for `.trow` while the renderer emits `.tr`.
    if (/^\s*\.tr\s*\{/m.test(sharedCss)) {
      ok('market.css 为 .tr 定义了行样式（与 trow() 生成的类名一致）')
    } else {
      fail('market.css 没有 .tr 规则 —— 表格行会完全没有样式')
    }
    if (/^\s*\.trow\s*\{/m.test(sharedCss)) {
      fail('market.css 仍在为 .trow 写样式，但渲染器生成的是 .tr')
    } else {
      ok('market.css 没有残留的 .trow 规则')
    }
  }

  if (fs.existsSync(marketPath)) {
    const marketPage = fs.readFileSync(marketPath, 'utf8')
    if (/serveSelf:\s*true/.test(marketPage)) {
      fail('the DSH install page declares serveSelf — it IS served by the host plugin and must ask it for the service URL')
    } else {
      ok('DSH install page asks the host plugin for the service URL (no serveSelf)')
    }
  }

  // Both surfaces share one copy of the plumbing and one stylesheet.
  const sharedPath = path.join(dir, 'web', 'shared.js')
  const cssPath = path.join(dir, 'web', 'market.css')
  fs.existsSync(sharedPath) ? ok('web/shared.js exists (one copy of the auth plumbing)') : fail('web/shared.js missing')
  fs.existsSync(cssPath) ? ok('web/market.css exists (one copy of the palette)') : fail('web/market.css missing')
  for (const [label, file] of [['install page', marketPath], ['console', consolePath]]) {
    if (!fs.existsSync(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    text.includes('/dsh-market/assets/shared.js')
      ? ok(`${label} loads the shared shell`)
      : fail(`${label} does not load web/shared.js`)
  }
}

// The in-app entry is a CLIENT-HALF registration, so the thing worth asserting is
// the contract that makes a client half load at all. Each rule below was learned by
// breaking it:
//
//   - `dsh.client` must be declared, or `dsh-client-modules` ignores the package;
//   - `exports["./client"]` must exist, or it throws
//     `declares dsh.client but exports no "./client" bundle`;
//   - the artifact must be a plain script registering a factory whose id EQUALS the
//     package name, loaded via `window.__ModuleLoader__.load`;
//   - the bare-package-name row must exist in the patch, because a row naming a
//     subpath is dropped silently by `exactPackageSpecifier`;
//   - `lib/bundle.js` must actually export `apply`. An empty namespace is rejected
//     with `invalid plugin, expect function or object with an "apply" method`, the
//     row gets no fiber, and the ONLY symptom is the audit's `failed to import`.
{
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const pkgName = manifest.name

  const clientDecl = manifest.dsh?.client
  if (clientDecl === undefined) {
    fail('package.json has no dsh.client — the browser half is never loaded')
  } else {
    clientDecl.platform === 'web'
      ? ok('dsh.client.platform is "web"')
      : fail(`dsh.client.platform is ${JSON.stringify(clientDecl.platform)}, expected "web"`)
    Array.isArray(clientDecl.inject)
      ? ok('dsh.client.inject declared', clientDecl.inject.join(', '))
      : fail('dsh.client.inject missing — client-side activation order is undefined')
  }

  const clientRel = manifest.exports?.['./client']
  const clientPath = typeof clientRel === 'string'
    ? clientRel
    : (clientRel !== null && typeof clientRel === 'object' ? clientRel.default : undefined)
  if (typeof clientPath !== 'string') {
    fail('package.json exports no "./client" bundle')
  } else {
    const clientFile = path.join(dir, clientPath)
    if (!fs.existsSync(clientFile)) {
      fail(`exports["./client"] points at a missing file: ${clientPath}`)
    } else {
      const source = fs.readFileSync(clientFile, 'utf8')
      ok(`client bundle present (${clientPath})`)
      source.includes('window.__ModuleLoader__.load')
        ? ok('client bundle uses the documented loader facade')
        : fail('client bundle does not call window.__ModuleLoader__.load')
      source.includes(`id: '${pkgName}'`) || source.includes(`id: "${pkgName}"`)
        ? ok('client factory id equals the package name')
        : fail(`client factory id must equal "${pkgName}" exactly, or the row fails`)
      // Plain script, not a module: no import/export statements at top level.
      // Written as an if, not a bare regex as a ternary condition — a leading `/`
      // there parses as division.
      const isModule = /^\s*(import|export)\s/m.test(source)
      if (isModule) {
        fail('client bundle contains import/export — it must be a classic script')
      } else {
        ok('client bundle is a classic script (no import/export)')
      }
      // Only theme tokens for colour, per references/practices.md.
      const literalColour = /(?:color|background|borderColor)\s*:\s*['"](?:#|rgb|hsl)/i.test(source)
      if (literalColour) {
        fail('client bundle uses a literal colour in a style — use --dsw-alias-* tokens')
      } else {
        ok('client bundle styles use theme tokens only')
      }

      // `sidebar.panellist` is a PANEL SELECTOR, not a free icon seat: its owner calls
      // `layout.selectPanel(id)` on click, and that throws for an id with no panel
      // behind it. Registering there without shipping a panel produced a row that was
      // visible and did nothing — worse than no entry, because it looks available.
      //
      // Comments are stripped first: an earlier version of this check matched the
      // explanatory comment above and failed on a file that was actually correct.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      if (code.includes('sidebar.panellist')) {
        fail('client registers sidebar.panellist — those rows select a main panel, so without one it is a dead entry')
      } else {
        ok('client does not register a dead sidebar.panellist row')
      }
      if (code.includes("'sidebar.footer.action'")) {
        ok('client registers the sidebar.footer.action seat')
      } else {
        fail('client does not register sidebar.footer.action — there would be no in-app entry')
      }

      // The bare-name row must exist, and the bundle root must be a real plugin.
      const patch = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
      const bareRow = new RegExp(
        `^\\s+name:\\s*['"]?${pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`,
        'm',
      ).test(patch)
      if (bareRow) {
        ok('cordis.patch.yml has the bare-package-name client row')
      } else {
        fail('cordis.patch.yml has no bare-package-name row — the client half never loads')
      }

      const bundleSource = fs.readFileSync(path.join(dir, 'lib', 'bundle.js'), 'utf8')
      if (/export\s+function\s+apply/.test(bundleSource)) {
        ok('lib/bundle.js exports apply (loader rejects an empty namespace)')
      } else {
        fail('lib/bundle.js must export apply — an empty module fails the row with "failed to import"')
      }
    }
  }
}

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

/**
 * The device-authorization flow must stay gone.
 *
 * It was removed because it had no consumer and carried two real defects: an
 * unauthenticated route that wrote a database row per call with no rate limit, and a
 * `verificationUrl` using `?activate=` while the page read `user_code`, so the link it
 * handed out could not open the approval screen.
 *
 * Deleting code is easy to undo by accident — a merge, a stale branch, a copy-paste
 * from an old revision. Nothing else in the suite would notice, because the endpoints
 * worked; they were simply unused and wrong. So the absence is asserted here.
 */
{
  const serverFiles = ['server/lib/http.js', 'server/lib/store.js', 'server/lib/db.js', 'server/lib/crypto.js']
  const traces = ['device_auths', 'startDeviceAuth', 'pollDeviceAuth', 'approveDeviceAuth', 'redeemDeviceAuth', 'DEVICE_TTL_MS', 'auth/device']
  for (const file of serverFiles) {
    const full = path.join(dir, file)
    if (!fs.existsSync(full)) continue
    const source = fs.readFileSync(full, 'utf8')
    const found = traces.filter((needle) => source.includes(needle))
    if (found.length === 0) ok(`${file} 不含设备授权流`)
    else fail(`${file} 又出现了设备授权流：${found.join(', ')}`)
  }
  // `dsh_bindings.device_id` is the DSH device fingerprint and must SURVIVE: it shares
  // the word "device" but has nothing to do with the flow just removed.
  const storeSource = fs.existsSync(path.join(dir, 'server/lib/store.js'))
    ? fs.readFileSync(path.join(dir, 'server/lib/store.js'), 'utf8')
    : ''
  storeSource.includes('device_id')
    ? ok('dsh_bindings.device_id 保留（与设备授权流无关）')
    : fail('dsh_bindings.device_id 被误删 —— 那是 DSH 设备指纹')
  // And the removal must not have taken `prune`'s return value with it. It did once:
  // the deleted line was `return { sessions: ..., deviceAuths: ... }`, so dropping only
  // the second field was impossible without rewriting the line, and the whole `return`
  // went. Plain string matching here — a regex with backslashes written through a tool
  // boundary is its own source of silent damage.
  const pruneStart = storeSource.indexOf('prune()')
  const pruneBody = pruneStart < 0 ? '' : storeSource.slice(pruneStart, pruneStart + 260)
  pruneBody.includes('return { sessions: Number(sessions.changes) }')
    ? ok('prune() 仍返回会话计数')
    : fail('prune() 的返回值在删除设备流时被带走了')
}

/**
 * Self-update: the plugin adopts the package the service carries.
 *
 * The guards matter more than the happy path here. An auto-update writes into a LIVE
 * install, so the two ways it could do serious damage are checked explicitly:
 * writing through a linked install (which would destroy a working tree), and touching
 * the live directory before a complete replacement is staged.
 */
{
  const pluginSource = fs.readFileSync(path.join(dir, 'lib', 'plugin.js'), 'utf8')
  pluginSource.includes('/dsh-market/self')
    ? ok('插件向服务端查自身版本')
    : fail('插件没有自更新入口')
  pluginSource.includes('isSymbolicLink')
    ? ok('自更新会识别链接安装')
    : fail('自更新没有链接检测 —— 会写穿到源码目录')
  pluginSource.includes('MARKET_AUTO_UPDATE')
    ? ok('自更新有开关（MARKET_AUTO_UPDATE=0）')
    : fail('自更新没有开关')
  pluginSource.includes('stripPrefix')
    ? ok('自更新按 npm 布局剥掉 package/ 前缀')
    : fail('自更新没有处理 npm 布局的 package/ 前缀')
  // The ordering that keeps an interrupted download from breaking a working install.
  const stagingAt = pluginSource.indexOf('.staging')
  const parkedAt = pluginSource.indexOf('.previous')
  if (stagingAt > 0 && parkedAt > 0 && stagingAt < parkedAt) {
    ok('先暂存再换版（暂存的代码在换版之前）')
  } else {
    fail('暂存与换版的顺序不对 —— 运行中的安装可能在下载中途就被破坏')
  }

  const httpSource = fs.readFileSync(path.join(dir, 'server', 'lib', 'http.js'), 'utf8')
  httpSource.includes("'/dsh-market/self'")
    ? ok('服务端暴露 /dsh-market/self')
    : fail('服务端没有 /dsh-market/self')
  httpSource.includes("'/dsh-market/self/download'")
    ? ok('服务端暴露 /dsh-market/self/download')
    : fail('服务端没有 /dsh-market/self/download')
  const cliSource = fs.readFileSync(path.join(dir, 'server', 'cli.mjs'), 'utf8')
  cliSource.includes("case 'publish:self'")
    ? ok('CLI 有 publish:self')
    : fail('CLI 没有放包的入口')

  // The market plugin must stay OUT of the catalog: it is the client, not something a
  // group is granted, and offering it there would let it be "installed" through a path
  // whose format it cannot use.
  const artifactsSource = fs.readFileSync(path.join(dir, 'server', 'lib', 'artifacts.js'), 'utf8')
  artifactsSource.includes('$selfDir') || artifactsSource.includes('this.selfDir')
    ? ok('自身包存放在 artifacts 表之外')
    : fail('自身包混进了市场制品存储')
}

/**
 * Auto-login, and the security property that makes it safe.
 *
 * The tempting shortcut is "the plugin knows the DSH account id, so let it log in". That
 * would be an authentication bypass, and it is worth writing down WHY, because the reason
 * is measured rather than theoretical: the plugin's `/dsh-market/identity` route reflects
 * any Origin, so ANY website the user visits can read that id. The id is a lookup key, not
 * a credential; the binding secret is the credential.
 */
{
  const httpSource = fs.readFileSync(path.join(dir, 'server', 'lib', 'http.js'), 'utf8')
  const storeSource2 = fs.readFileSync(path.join(dir, 'server', 'lib', 'store.js'), 'utf8')
  const pluginSource2 = fs.readFileSync(path.join(dir, 'lib', 'plugin.js'), 'utf8')
  const sharedSource2 = fs.readFileSync(path.join(dir, 'web', 'shared.js'), 'utf8')

  httpSource.includes("'/dsh-market/identity/token'")
    ? ok('服务端有绑定密钥换会话的路由')
    : fail('服务端没有 /dsh-market/identity/token')
  httpSource.includes("'/dsh-market/auth/refresh'")
    ? ok('服务端能兑换 refresh 令牌')
    : fail('服务端没有 /dsh-market/auth/refresh —— 会话两小时后只能重新登录')
  // The secret must be single-issue: returned from bind, and from no read route.
  storeSource2.includes('secret_hash') && storeSource2.includes('redeemBinding')
    ? ok('store 保存密钥哈希并可校验')
    : fail('store 没有密钥的保存/校验')
  const bindingRow = /bindingRow\(row\)\s*\{[\s\S]*?\n  \}/.exec(storeSource2)?.[0] ?? ''
  if (bindingRow === '') {
    fail('找不到 bindingRow —— 无法确认读取接口不泄漏密钥')
  } else if (bindingRow.includes('secret')) {
    fail('bindingRow 返回了密钥 —— 任何读取接口都会泄漏它')
  } else {
    ok('bindingRow 不返回密钥（读取接口无法泄漏它）')
  }

  // The plugin holds the secret and refuses to hand out sessions to other origins.
  for (const [label, needle] of [
    ['写入密钥的路由', "`${PREFIX}/link`"],
    ['交换会话的路由', "`${PREFIX}/session`"],
  ]) {
    pluginSource2.includes(needle) ? ok(`宿主插件有${label}`) : fail(`宿主插件没有${label}`)
  }
  pluginSource2.includes('function ownOrigin')
    ? ok('宿主插件校验请求来源')
    : fail('宿主插件没有 Origin 校验 —— 任何网站都能索取会话')
  // Both sensitive routes must actually call the check, not merely define it.
  const linkRoute = /`\$\{PREFIX\}\/link`[\s\S]*?\n  \],/.exec(pluginSource2)?.[0] ?? ''
  const sessionRoute = /`\$\{PREFIX\}\/session`[\s\S]*?\n  \],/.exec(pluginSource2)?.[0] ?? ''
  linkRoute.includes('ownOrigin(req)')
    ? ok('  写密钥前校验来源')
    : fail('  写密钥的路由没有校验来源')
  sessionRoute.includes('ownOrigin(req)')
    ? ok('  发会话前校验来源')
    : fail('  发会话的路由没有校验来源')

  // The client side must actually persist and redeem the refresh token.
  sharedSource2.includes('REFRESH_KEY')
    ? ok('页面保存 refresh 令牌')
    : fail('页面没有保存 refresh 令牌 —— 服务端发了也没用')
  sharedSource2.includes('/dsh-market/auth/refresh')
    ? ok('页面在 401 时兑换 refresh')
    : fail('页面不会兑换 refresh')
  sharedSource2.includes('refreshToken.clear()')
    ? ok('登出会清掉 refresh 令牌')
    : fail('登出没有清 refresh —— 下一次请求会自动登回来')
  const marketSource = fs.existsSync(path.join(dir, 'web', 'market.html'))
    ? fs.readFileSync(path.join(dir, 'web', 'market.html'), 'utf8')
    : ''
  marketSource.includes('tryAutoLogin')
    ? ok('安装页会尝试自动登录')
    : fail('安装页不会自动登录')
  marketSource.includes('/dsh-market/link')
    ? ok('安装页把密钥交给宿主插件（而不是留给页面）')
    : fail('安装页没有把密钥交给插件')
  /**
   * Logout must disarm auto-login on THIS device.
   *
   * It did not, so 退出 was a lie: the session and the refresh token were cleared, but the
   * plugin's device secret stayed, and the very next visit asked the plugin for a session
   * and silently signed the user back in. The binding is deliberately left alone — this
   * only stops auto-login here.
   */
  const logoutBlock = /onLogout:\s*\(\)\s*=>\s*\{[\s\S]*?\n  \},/.exec(marketSource)?.[0] ?? ''
  if (logoutBlock === '') {
    fail('could not find the install page onLogout block')
  } else if (logoutBlock.includes('dropLinkSecret')) {
    ok('退出登录会清掉本机密钥（退出之后不会被自动登回来）')
  } else {
    fail('退出登录没有清本机密钥 —— 下次打开会自动登录回去，「退出」形同虚设')
  }
  // ...and there must be a way back that does not require unbinding first.
  marketSource.includes('在此设备启用自动登录')
    ? ok('绑定行提供「在此设备启用自动登录」（不必先解绑）')
    : fail('关闭自动登录后没有就地重新启用的入口')

    /**
     * The market page's layout: compact top, scrolling cards, pinned footer.
     *
     * Checked here as well as in the browser probe because these are the parts a later CSS
     * edit silently reverts — a stylesheet that stops applying looks exactly like one that
     * was never written, and the page still "works".
     */
    const marketCss = fs.readFileSync(path.join(dir, 'web', 'market.css'), 'utf8')
    /**
     * Every regex here is bound to a NAME first.
     *
     * A line that begins with `/` is parsed as DIVISION continuing the previous expression,
     * so `foo(...)` followed by a regex literal is a syntax error. That has now bitten this
     * file three times, twice in code and once in the tests that check this code — hence the
     * rule rather than another one-off fix.
     *
     * `[^]` matches any character including a newline, and unlike `[\s\S]` it needs no
     * backslashes, which have been eaten in transit into this file before.
     */
    const footerHasPager = /<footer class="market-foot">[^]{0,400}?id="pager"/.test(marketSource)
    footerHasPager
      ? ok('分页在固定页脚里（不是卡片之后）')
      : fail('分页仍在卡片之后 —— 结果一多就会被滚出屏幕')
    const footerHasStatus = /id="grid"[^]{0,400}?<footer class="market-foot">[^]{0,300}?id="status"/.test(marketSource)
    footerHasStatus
      ? ok('  页脚里还有状态行（安装反馈不会被滚走）')
      : fail('  状态行不在页脚里')
    // The explanation must be FOLDED, not merely shortened.
    const noteIsFolded = /<details class="note-more">[^]{0,200}?id="note-detail"/.test(marketSource)
    noteIsFolded
      ? ok('顶部说明折进 details（给卡片让出空间）')
      : fail('顶部说明仍是常驻文本 —— 会占掉卡片的空间')
    const gridScrolls = /#view-market > \.grid\{[^}]*overflow-y:auto/.test(marketCss)
    gridScrolls
      ? ok('  卡片区自己滚动')
      : fail('  卡片区没有滚动容器')
    marketCss.includes('body:has(#view-market:not(.hidden))')
      ? ok('  布局用 :has(#view-market) 限定，控制台不受影响')
      : fail('  布局没有限定作用域 —— market.css 是控制台共用的，会一起被改')
    const footerHasRule = /\.market-foot\{[^}]*border-top/.test(marketCss)
    footerHasRule
      ? ok('  页脚有分隔线，读起来像页脚')
      : fail('  页脚没有视觉分隔')
    /**
     * The market view must lift the 1180px cap.
     *
     * That cap is right for a page of prose and wrong for a card grid: on a wide window it
     * left a third of the screen empty on the right. It survived every check and every
     * screenshot taken at a narrow width, where it did nothing — so it is asserted here as
     * well as measured in the browser probe.
     */
    const marketWrap = /body:has\(#view-market:not\(\.hidden\)\) > \.wrap\{[^}]*max-width:none/.test(marketCss)
    marketWrap
      ? ok('市场视图不受 1180px 上限约束（宽屏右侧不留空白）')
      : fail('  .wrap 仍有 1180px 上限 —— 宽屏右侧会空出一大块')
    // ...and the console must keep its cap, since the two share this stylesheet.
    const consoleCss = fs.readFileSync(path.join(dir, 'web', 'console.css'), 'utf8')
    const consoleKeepsCap = /\.wrap:has\(#view-console:not\(\.hidden\)\)\s*\{\s*max-width:\s*1180px/.test(consoleCss)
    consoleKeepsCap
      ? ok('  控制台仍保留自己的 1180px 上限')
      : fail('  控制台的上限没了 —— 管理页会被拉得难以阅读')
}

/**
 * Republishing a version must SAY that it overwrites one.
 *
 * `INSERT ... ON CONFLICT(name, version, channel) DO UPDATE` means the obvious workflow —
 * "I edited the skill, publish it again" — replaces the bytes while every client that already
 * has that version compares equal and is offered no update. The change then reaches nobody,
 * silently. The pre-check distinguishes the two cases, and this is what keeps that distinction
 * from disappearing.
 */
{
  const httpSource2 = fs.readFileSync(path.join(dir, 'server', 'lib', 'http.js'), 'utf8')
  httpSource2.includes('replacesExisting')
    ? ok('预检报告会覆盖已有版本')
    : fail('预检不报告覆盖 —— 同版本重发会静默无效')
  httpSource2.includes('sameContent')
    ? ok('  并区分「内容没变」与「内容变了」（两种情况的建议不同）')
    : fail('  不区分内容是否变化 —— 警告会变成噪音或误导')
  const consoleSource3 = fs.readFileSync(path.join(dir, 'web', 'console.html'), 'utf8')
  consoleSource3.includes('收不到这次改动')
    ? ok('  控制台把后果说清楚（已安装的人收不到）')
    : fail('  控制台不提后果 —— 发布者会以为改动发出去了')
  consoleSource3.includes('nextPatch')
    ? ok('  并给出可照做的建议（提高版本号）')
    : fail('  只警告不给出路')
  // The form field must not be presented as the normal path.
  consoleSource3.includes('仅在包内没有版本信息时生效')
    ? ok('  表单的版本框说明了自己只在包内无版本时生效')
    : fail('  版本框没有说明适用范围 —— 会让人以为它能覆盖包的声明')
}

/**
 * The console must be able to see — and fix — an artifact it just revoked.
 *
 * Reported: revoking a plugin made it vanish from the console, so it could not be changed
 * back. The management list was using `catalogRows()`, the CLIENT catalog view, which drops
 * every name whose versions are all non-publishable. Drafts and review-only artifacts went the
 * same way, so a draft could never be promoted.
 *
 * The second half is a field-name mismatch that had been silently breaking the console:
 * `rowToArtifact` publishes the DB's `state` column as `status`, while the page read
 * `artifact.state` — `undefined`. The state column rendered blank, the 改状态 select
 * preselected its FIRST option (`draft`), and the admin search could not filter by state.
 */
{
  const artifactsSource3 = fs.readFileSync(path.join(dir, 'server', 'lib', 'artifacts.js'), 'utf8')
  const httpSource3 = fs.readFileSync(path.join(dir, 'server', 'lib', 'http.js'), 'utf8')
  const consoleSource4 = fs.readFileSync(path.join(dir, 'web', 'console.html'), 'utf8')

  const adminRoute = /'\/dsh-market\/admin\/artifacts',[\s\S]{0,600}?adminRows\(\)/.test(httpSource3)
  adminRoute
    ? ok('控制台制品列表用 adminRows()（忽略状态）')
    : fail('  管理列表用 catalogRows() —— 撤回/草稿的制品会从控制台消失')
  artifactsSource3.includes('adminRows()') && artifactsSource3.includes('highestAny')
    ? ok('  adminRows() 与 highestAny() 存在（与客户端视图分开）')
    : fail('  没有管理专用的行视图')
  // The client view must KEEP dropping non-publishable artifacts.
  const catalogStillFilters = /catalogRows\(\)[\s\S]{0,200}?this\.highest\(/.test(artifactsSource3)
  catalogStillFilters
    ? ok('  客户端目录仍然只取可发布的版本')
    : fail('  客户端目录不再过滤状态 —— 撤回的制品会被提供安装')

  // `status`, never `state`, when READING an artifact row.
  const readsState = /artifact\.state(?![\s\S]{0,80}?\/\/)/.test(consoleSource4.replace(/\/\*[\s\S]*?\*\//g, ''))
  readsState
    ? fail('  控制台仍读 artifact.state（接口给的是 status）—— 状态列与弹窗初始值都会错')
    : ok('  控制台读 artifact.status（与接口一致）')
  httpSource3.includes('artifact.status, artifact.owner')
    ? ok('  服务端按状态检索也用 status')
    : fail('  服务端检索仍读 artifact.state —— 按状态搜永远搜不到')
  // And every version must be reachable, not just the row's own.
  consoleSource4.includes('artifact.versions')
    ? ok('  改状态弹窗可以选具体版本（非最高版本也能改）')
    : fail('  只能改行上显示的那个版本 —— 其它版本仍然改不到')
}

/**
 * Recall, and the boundary between it and revocation.
 *
 * The reported behaviour — "revoked in the console and the installed plugin still runs" — turned
 * out to be a design gap, not a defect: revocation was implemented faithfully as "stop
 * distributing" and the client had NO awareness of it at all. Recall is the missing action, and
 * the properties below are the ones that fail silently if any piece is dropped:
 *
 *   - recall must be a SEPARATE axis, or revoking temporarily would erase every install
 *   - a recalled artifact must not be advertised or offered as an update
 *   - the client must actually remove it, per VERSION, and leave a receipt
 *   - the console must say what each action does and does not reach
 */
{
  const artifactsSource4 = fs.readFileSync(path.join(dir, 'server', 'lib', 'artifacts.js'), 'utf8')
  const policySource = fs.readFileSync(path.join(dir, 'server', 'lib', 'policy.js'), 'utf8')
  const httpSource4 = fs.readFileSync(path.join(dir, 'server', 'lib', 'http.js'), 'utf8')
  const pluginSource5 = fs.readFileSync(path.join(dir, 'lib', 'plugin.js'), 'utf8')
  const consoleSource5 = fs.readFileSync(path.join(dir, 'web', 'console.html'), 'utf8')
  const marketSource2 = fs.readFileSync(path.join(dir, 'web', 'market.html'), 'utf8')

  artifactsSource4.includes('setRecalled')
    ? ok('召回是独立于状态的标记（revoked 不会清空所有人的安装）')
    : fail('  召回被折进 state —— 临时下架会变成清空安装')
  const refusesRecalled = policySource.includes("code: 'E_RECALLED'")
  refusesRecalled
    ? ok('  被召回的制品不再可分发（错误码与 revoked 区分）')
    : fail('  召回后仍可下载 —— 一边要求移除一边继续分发')
  // The catalog must not advertise it, while the console still must see it.
  const catalogSkipsRecalled = /if \(row\.recalled === 1\) continue/.test(artifactsSource4)
  catalogSkipsRecalled
    ? ok('  客户端目录不再出现被召回的版本（否则召回比撤回还显眼）')
    : fail('  被召回的版本仍出现在客户端目录里')
  const adminIgnoresRecall = /highestAny\(rows\)[\s\S]{0,300}?parseVersion/.test(artifactsSource4)
  adminIgnoresRecall
    ? ok('  管理列表仍能看到被召回的版本（否则改不回来）')
    : fail('  管理列表把召回也过滤掉了')

  // The client half: it has to KNOW, which it never did.
  pluginSource5.includes('reconcileRecalled')
    ? ok('客户端启动时对账（此前完全不知道撤回/召回的存在）')
    : fail('  客户端仍然不知道服务端撤回了什么')
  const perVersion = /item\.recalled !== true/.test(pluginSource5)
  perVersion
    ? ok('  按名字+版本精确匹配（不会因为同名就删掉较新的版本）')
    : fail('  对账不看版本 —— 召回 1.0.0 会删掉已装的 1.1.0')
  pluginSource5.includes('MARKET_AUTO_RECALL')
    ? ok('  有开关可以关掉')
    : fail('  自动移除没有开关')
  pluginSource5.includes('RECALLED_FILE') && pluginSource5.includes('appendRecalledRecord')
    ? ok('  每次移除都留回执（静默删除比它解决的问题更糟）')
    : fail('  移除没有留下任何记录')
  marketSource2.includes('/dsh-market/recalled')
    ? ok('  安装页把回执显示给用户')
    : fail('  安装页不告诉用户东西被移除了')
  // A machine that never starts DSH again cannot be recalled — say so where the operator clicks.
  consoleSource5.includes('拉取式客户端无法被强制')
    ? ok('  召回弹窗说明了它够不到哪些机器')
    : fail('  召回被描述成能兜底 —— 离线机器不会被召回')
  consoleSource5.includes('已安装的人不受影响，也不会被移除')
    ? ok('  改状态的弹窗说明了 revoked 的边界')
    : fail('  revoked 仍只提下载，读起来像"已处理"')

  /**
   * The receipt has to be clearable, and has to read as a PAST event.
   *
   * Reported: cancelling a recall left 「服务端召回，已从本机移除 1 项」 on screen forever. The
   * wording was present-tense and nothing could dismiss it, so the page claimed something was
   * being recalled when nothing was.
   *
   * Lifting the recall must NOT erase the record — the removal really happened — so the fix is:
   * past tense, dated, and dismissible.
   */
  pluginSource5.includes('`${PREFIX}/recalled/dismiss`')
    ? ok('提示可以清除（否则它会永远停在屏幕上）')
    : fail('  提示无法清除 —— 取消召回后仍显示，读起来像当前状态')
  const dismissGuarded = /recalled\/dismiss`[\s\S]{0,500}?ownOrigin\(req\)/.test(pluginSource5)
  dismissGuarded
    ? ok('  清除只允许市场页自己发起（外部页面不能清）')
    : fail('  任意网页都能清掉这条提示')
  marketSource2.includes('已按服务端要求从本机移除')
    ? ok('  文案用过去时（记录发生过的事，不是当前状态）')
    : fail('  文案仍是现在时 —— 取消召回后会读成"正在召回"')
  marketSource2.includes('即使服务端已取消召回')
    ? ok('  并说明取消召回不会把东西装回来')
    : fail('  没有说明取消召回之后会怎样')
  // Blindly appending showed the same artifact twice after a reinstall-and-recall cycle.
  // `includes`, not a regex literal: a line starting with `/` after one ending in `)` is parsed
  // as DIVISION. That mistake is now at seven occurrences, so the guard in run-all.mjs is what
  // catches it — but not writing the literal is better than relying on the guard.
  pluginSource5.includes('const merged = new Map()')
    ? ok('  同一项被移除多次只记一条（回执回答"什么没了"）')
    : fail('  回执会累积重复条目 —— 计数与内容对不上')
}

/**
 * SKILL support.
 *
 * Skills are not loader entries: they are catalog items the agent reads on demand. So an
 * install must NOT write a patch row or a bundle entry, and it must land in the market's
 * OWN directory — writing into `~/.dsh/skills` would mix the market's files with the
 * operator's hand-written ones, and a later uninstall could delete theirs.
 */
{
  const pluginSource3 = fs.readFileSync(path.join(dir, 'lib', 'plugin.js'), 'utf8')
  pluginSource3.includes('.dsh-market-skills')
    ? ok('技能装到市场自己的目录（不碰 ~/.dsh/skills）')
    : fail('技能没有自己的目录 —— 会与用户手写的 skill 混在一起')
  pluginSource3.includes("get('skills')")
    ? ok('技能经 ctx.skills 注册（注册表的正式扩展点）')
    : fail('技能没有注册进 ctx.skills')
  pluginSource3.includes('skillDirName')
    ? ok('作用域包名会扁平化成一个目录层级')
    : fail('作用域包名没有扁平化 —— 列表与卸载会找不到它')
  pluginSource3.includes("kind === 'skill'")
    ? ok('安装路径按 dsh.market.kind 分流')
    : fail('安装路径没有区分 skill')
  for (const code of ['E_SKILL_MISSING', 'E_SKILL_BAD_NAME', 'E_SKILL_BAD_FRONTMATTER']) {
    pluginSource3.includes(code)
      ? ok(`  拒绝 ${code}`)
      : fail(`  没有 ${code} —— 残缺的技能会被半个装进去`)
  }
  /**
   * Registration must be RE-RUN, not done once at mount.
   *
   * The first version registered only at mount, so installing a skill meant restarting DSH
   * — while the filesystem provider refreshes live. A user would have had to know which
   * kind of artifact they installed to guess whether a restart was needed.
   *
   * The subtle half is dispose-before-register: `register()` is FIRST-WINS per layer, so an
   * edited skill would keep its OLD body in the catalog and still look like it updated.
   */
  pluginSource3.includes('setInterval')
    ? ok('技能目录会被轮询（装完即时生效，不必重启）')
    : fail('技能只在启动时注册一次 —— 装完必须重启')
  // Bound to a name rather than used inline: a line starting with `/` after a line ending
  // in `)` is parsed as DIVISION, not a regex, so the inline form is a syntax error.
  const disposesBeforeRegister = /existing\.dispose\(\)[\s\S]{0,500}?skills\.register\(/.test(pluginSource3)
  disposesBeforeRegister
    ? ok('  重注册前先 dispose（register 是先到先得，否则改了正文不生效）')
    : fail('  重注册前没有 dispose —— 改过的技能会留着旧正文')
  pluginSource3.includes('entry.dispose()')
    ? ok('  目录里消失的技能会被移出目录')
    : fail('  没有处理技能被删除的情况')
  // Bound to a name: a line beginning with a regex literal after a line ending in ')' is
  // parsed as DIVISION, which is how this file was briefly a syntax error.
  const registersWithSource = /skills\.register\(\{[\s\S]{0,3000}?source:/.test(pluginSource3)
  registersWithSource
    ? ok('  注册时带 source（load 时必填；缺了能列出却加载不了）')
    : fail('  注册时没有 source —— 技能列得出来，但加载会报 source must be a string')
  // The log has to distinguish "no skills service" from "a service and an empty directory".
  // Both mounted silently before, which cost a round of misdiagnosis.
  pluginSource3.includes('ctx.skills 可用')
    ? ok('  日志区分「没有 skills 服务」与「服务在但目录为空」')
    : fail('  两种情况的日志无法区分 —— 排查时会误判')
  /**
   * An installed skill must report its VERSION.
   *
   * It reported `null`: `installed()` skipped skills when filling versions in, because a
   * skill has no directory under `node_modules` — but it does have a `package.json`, in its
   * own directory. The page then compared the catalog's `1.0.0` against `null`, found them
   * different, and offered 「更新到 1.0.0」 for the version already installed.
   */
  pluginSource3.includes('skillManifestOf')
    ? ok('  已安装技能从自己的 manifest 读取版本')
    : fail('  技能条目仍报告 null 版本 —— 会给自己发「更新」')
  // Bound to names: a line starting with `/` after a line ending in `)` is DIVISION.
  const reportsSkillVersion = /version: skill\.version \?\? null/.test(pluginSource3)
  reportsSkillVersion
    ? ok('    installed() 用上了那个版本')
    : fail('    installed() 没有用技能自己的版本')
  // ...and the page must not guess when the installed version is unknown.
  // `marketSource` belongs to an earlier block, so read the page again here.
  const marketPage2 = fs.readFileSync(path.join(dir, 'web', 'market.html'), 'utf8')
  const updateGuard = /installedHere\.version && entry\.version !== installedHere\.version/.test(marketPage2)
  updateGuard
    ? ok('  本机版本未知时不提供更新（不猜）')
    : fail('  页面在不知道本机版本时仍会提供更新 —— 同类 bug 会换个形式回来')
}

/**
 * Layout is a SHARED rule, and zip is accepted at upload.
 *
 * Both halves of the bug this guards against were real:
 *
 *   - `inspectArchive` accepted an npm-layout archive while the client looked for
 *     `package.json` at the root only, so the market published and served an artifact the
 *     client refused at the last step. One rule, two implementations, guaranteed to diverge.
 *   - A Windows "compress this folder" zip wraps everything in a directory, which hit the
 *     same wall.
 */
{
  const layoutSource = fs.readFileSync(path.join(dir, 'server', 'lib', 'layout.js'), 'utf8')
  const packSource = fs.readFileSync(path.join(dir, 'server', 'lib', 'pack.js'), 'utf8')
  const pluginSource4 = fs.readFileSync(path.join(dir, 'lib', 'plugin.js'), 'utf8')
  const zipSource = fs.readFileSync(path.join(dir, 'server', 'lib', 'zip.js'), 'utf8')

  layoutSource.includes('export function detectPackagePrefix')
    ? ok('布局规则是一个共享模块')
    : fail('没有共享的布局规则 —— 两侧会各自实现并漂移')
  packSource.includes('detectPackagePrefix') && pluginSource4.includes('detectPackagePrefix')
    ? ok('  服务端与客户端都用它')
    : fail('  有一侧没有用共享规则')
  // Both packers must ship it, or the client fails to import at runtime.
  for (const packer of ['tools/pack-dist.mjs', 'server/cli.mjs']) {
    const source = fs.readFileSync(path.join(dir, packer), 'utf8')
    source.includes("'server/lib/layout.js'")
      ? ok(`  ${packer} 打包时带上 layout.js`)
      : fail(`  ${packer} 没有带上 layout.js —— 客户端启动会 MODULE_NOT_FOUND`)
  }
  // The client must strip the prefix, not merely find the manifest.
  pluginSource4.includes('stripPrefix: layout.prefix')
    ? ok('  客户端解包时剥掉前缀（否则文件落深一层）')
    : fail('  客户端找到了 manifest 但没有剥前缀')
  zipSource.includes('inflateRawSync')
    ? ok('服务端能读 zip（存储与客户端仍只有一种格式）')
    : fail('服务端没有 zip 读取器')
  packSource.includes('packTarGzEntries')
    ? ok('  zip 会被重新打成规范的 tar.gz')
    : fail('  zip 没有被归一化成 tar.gz')
  // The upload route must normalise BEFORE hashing: the preview advertises a sha256 and the
  // client verifies the bytes it downloads against it.
  const uploadRoute = /'\/dsh-market\/publish',[\s\S]*?\n    \},/.exec(fs.readFileSync(path.join(dir, 'server', 'lib', 'http.js'), 'utf8'))?.[0] ?? ''
  if (uploadRoute === '') {
    fail('找不到发布上传路由')
  } else if (uploadRoute.indexOf('normaliseArchive') < uploadRoute.indexOf('sha256(archive)')) {
    ok('  先归一化再算哈希（否则客户端完整性校验必然失败）')
  } else {
    fail('  先算哈希再归一化 —— 预检给出的 sha256 与实际存储的字节不符')
  }
  const consoleSource2 = fs.readFileSync(path.join(dir, 'web', 'console.html'), 'utf8')
  consoleSource2.includes('.zip')
    ? ok('控制台的文件选择框接受 zip')
    : fail('控制台不接受 zip —— 上传了也会被前端过滤掉')

  /**
   * A skill bundle that is only a SKILL.md must be publishable.
   *
   * The requirement for a stub `package.json` was this market's, not the format's — most
   * skills simply do not have one — and it produced a dead end whose message named a file the
   * publisher had no reason to expect. The manifest is synthesised instead.
   */
  const packSource2 = fs.readFileSync(path.join(dir, 'server', 'lib', 'pack.js'), 'utf8')
  packSource2.includes('synthesiseSkillManifest')
    ? ok('只有 SKILL.md 的技能包会被补出 manifest')
    : fail('没有 manifest 的技能包仍会被拒 —— 大多数技能就是这样')
  const artifactsSource2 = fs.readFileSync(path.join(dir, 'server', 'lib', 'artifacts.js'), 'utf8')
  artifactsSource2.includes('synthesiseSkillManifest')
    ? ok('  CLI 的目录发布路径也一样（两个入口不会各说各话）')
    : fail('  CLI 路径没有合成 —— 控制台能发而 CLI 不能')
  // The two fields that cannot be read off the frontmatter must be overridable.
  const uploadRoute2 = fs.readFileSync(path.join(dir, 'server', 'lib', 'http.js'), 'utf8')
  uploadRoute2.includes("searchParams.get('name')") && uploadRoute2.includes("searchParams.get('version')")
    ? ok('  name/version 可在发布时指定（作用域与版本无法从 frontmatter 推出）')
    : fail('  不能指定 name/version —— 推导出的名字无法匹配作用域权限规则')
  consoleSource2.includes('id="pub-name"') && consoleSource2.includes('id="pub-version"')
    ? ok('  控制台有这两个可选输入')
    : fail('  控制台没有这两个输入，发布者改不了推导结果')
  // The synthesised manifest has to be REPORTED, not silently applied.
  uploadRoute2.includes('synthesised,')
    ? ok('  预检会报告补出的 manifest')
    : fail('  补出的 manifest 被静默使用')
  // One definition of the name rule, or synthesis and recording can disagree.
  const layoutSource2 = fs.readFileSync(path.join(dir, 'server', 'lib', 'layout.js'), 'utf8')
  layoutSource2.includes('PACKAGE_NAME_RE') && artifactsSource2.includes('PACKAGE_NAME_RE')
    ? ok('  包名规则只有一处定义（合成与入库不会各判各的）')
    : fail('  包名规则重复定义 —— 合成可能造出库拒绝的名字')
  const layoutSource3 = fs.readFileSync(path.join(dir, 'server', 'lib', 'layout.js'), 'utf8')
  /**
   * Import the exported rule and test it, rather than scraping the regex out of the source.
   *
   * Scraping kept the literal's own `/` delimiters, so the pattern under test was "starts and
   * ends with a slash" and the check failed on a perfectly good name — a broken check
   * reporting a FAILURE, which is the same class of mistake as the broken checks that report
   * success, just louder.
   */
  const { PACKAGE_NAME_RE } = await import(pathToFileURL(path.join(dir, 'server', 'lib', 'layout.js')).href)
  PACKAGE_NAME_RE.test('my-skill') && PACKAGE_NAME_RE.test('@dsh-internal/my-skill')
    ? ok('  不带作用域的包名仍被接受（作用域是建议，不是要求）')
    : fail('  合法包名被拒 —— 会挡住只想快速发布的技能')
  !PACKAGE_NAME_RE.test('Not A Name') && !PACKAGE_NAME_RE.test('UPPER')
    ? ok('  非法包名仍被拒')
    : fail('  非法包名被接受了')
  layoutSource3.includes('PACKAGE_NAME_RE')
    ? ok('  规则确实定义在共享模块里')
    : fail('  规则不在共享模块里')
}

/**
 * The SERVICE knows what an artifact is.
 *
 * `dsh.market.kind` used to exist only inside each package.json, so the console could not
 * label an artifact and could not tell a skill from a plugin — and a skill bundle with no
 * `SKILL.md` published cleanly, listed cleanly, and failed on someone's machine at install
 * time. The two publish paths also disagreed: the CLI's directory path skipped
 * `inspectArchive` entirely.
 */
{
  const packSource = fs.readFileSync(path.join(dir, 'server', 'lib', 'pack.js'), 'utf8')
  const artifactsSource = fs.readFileSync(path.join(dir, 'server', 'lib', 'artifacts.js'), 'utf8')
  const dbSource = fs.readFileSync(path.join(dir, 'server', 'lib', 'db.js'), 'utf8')
  const consoleSource = fs.readFileSync(path.join(dir, 'web', 'console.html'), 'utf8')

  packSource.includes("'skill'") && packSource.includes("'bundle'") && packSource.includes("'plugin'")
    ? ok('服务端识别 plugin / bundle / skill 三种类型')
    : fail('服务端不区分制品类型')
  packSource.includes('E_SKILL_MISSING')
    ? ok('  发布时就拒绝没有 SKILL.md 的技能')
    : fail('  缺 SKILL.md 的技能能发布出去 —— 要到客户端安装才失败')
  packSource.includes('parseSkillFrontmatter')
    ? ok('  发布时校验 frontmatter 与 kebab-case 名字')
    : fail('  发布时不校验 frontmatter')
  // The CLI path must inspect too, or the two publish paths disagree.
  const publishFromDir = /publishFromDirectory\(packageDir[\s\S]*?\n  \}/.exec(artifactsSource)?.[0] ?? ''
  if (publishFromDir === '') {
    fail('找不到 publishFromDirectory')
  } else if (publishFromDir.includes('inspectArchive')) {
    ok('  CLI 目录路径与上传路径走同一套校验')
  } else {
    fail('  CLI 目录路径跳过了校验 —— 两条发布路径会给出不同答案')
  }
  dbSource.includes('ADD COLUMN kind')
    ? ok('  旧数据库开机会补上 kind 列')
    : fail('  没有 kind 列的迁移 —— 老库会读不出类型')
  dbSource.includes('kind: row.kind')
    ? ok('  读行时带出 kind')
    : fail('  读行时不带 kind —— 接口拿不到类型')
  consoleSource.includes('col-kind') && consoleSource.includes("skill: '技能'")
    ? ok('  控制台制品列表标注类型')
    : fail('  控制台看不出哪个是技能')
  consoleSource.includes('将发布')
    ? ok('  发布预检先说明将要发布的是哪种制品')
    : fail('  发布预检不说明制品类型')
}

resolveSpec(PKG)
resolveSpec(`${PKG}/plugin`)

console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
