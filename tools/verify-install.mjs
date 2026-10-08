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
    // The service sends the market side; a body field would let a caller claim another
    // account, so the payload must not carry one.
    if (/marketUsername/.test(market)) {
      fail('install page sends marketUsername in the bind body — the market side must come from the token only')
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
    const rolePayload = /role:\s*isAdmin\s*\?\s*'member'\s*:\s*'admin'/.test(consolePage)
    if (rolePayload) {
      ok('console sends `{ role }` when changing a role')
    } else {
      fail('console does not send `{ role }` to /dsh-market/admin/role')
    }
    if (/status:\s*disabled\s*\?\s*'active'\s*:\s*'disabled'/.test(consolePage)) {
      ok('console sends `{ status: "active" | "disabled" }` when toggling an account')
    } else {
      fail('console does not send `{ status }` to /dsh-market/admin/status')
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

resolveSpec(PKG)
resolveSpec(`${PKG}/plugin`)

console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
