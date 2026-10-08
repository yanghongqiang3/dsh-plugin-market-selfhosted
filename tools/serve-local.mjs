// Run the marketplace host plugin outside DSH, over a real HTTP server.
//
// Why: fast, DSH-free verification of the routes, the page, and — importantly —
// the two shell-entry channels. It stubs the services the plugin touches and maps
// its `{ kind, path, handler }` routes onto plain node:http, the same shape
// WebRoute declares.
//
//   node tools/serve-local.mjs [port] [artifactRoot]
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

const port = Number(process.argv[2] ?? 17901)
const artifactRoot = process.argv[3]

if (artifactRoot) process.env.MARKET_ARTIFACT_ROOT = artifactRoot

const routes = []
const indexTaps = []
/** Listeners for the real `webserver/index-inject` event. */
const indexInjectListeners = []

const webServer = {
  /**
   * The real service exposes the bound port (`get port()`). The entry link needs
   * it to build an absolute URL — a relative href would resolve against the
   * shell's `dsh-app://app` origin and replace the shell's SPA.
   */
  get port() {
    return port
  },
  register(route) {
    if (route.kind !== 'exact' && route.kind !== 'prefix') {
      throw new Error(`bad route kind: ${route.kind}`)
    }
    routes.push(route)
    return () => {
      const index = routes.indexOf(route)
      if (index >= 0) routes.splice(index, 1)
    }
  },
  // HTTP-served index path: the carrier applies taps during render.
  tapIndex(transform) {
    indexTaps.push(transform)
    return () => {
      const index = indexTaps.indexOf(transform)
      if (index >= 0) indexTaps.splice(index, 1)
    }
  },
  /**
   * Mirrors @deepseek-ai/dsh-host-webserver: one mutable table per render, emitted
   * to every listener in activation order. The desktop host calls this once and
   * ships the result to the Electron renderer over IPC, so the rows must be
   * shaped exactly as `renderRow` expects.
   */
  collectIndexInjections() {
    const table = []
    for (const listener of indexInjectListeners) listener(table)
    return table
  },
}

/**
 * Shell skeleton, mirroring the real sidebar's structure closely enough to anchor
 * the injected entry: nav rows, a workspace region whose heading is followed by a
 * session list, and a foot area beneath. `?shell=sidebar` uses it.
 *
 * The proportions matter, not just the presence of the parts: the shipping
 * sidebar leaves roughly 18px between the last nav row and the workspace heading,
 * which is too short for a row — the reason the entry cannot live there.
 */
const SHELL_WITH_SIDEBAR = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>DeepSeek Harness (local shell stub)</title>
  <style>
    :root{--dsw-specific-sidebar-fill:#eceef2;--dsw-alias-bg-base:#f6f7f9;--dsw-alias-border-l1:#e6e8ec;--dsw-alias-label-secondary:#707784}
    html,body{margin:0;height:100%}
    .shell{display:flex;height:100%}
    .side{width:269px;flex:none;background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1);padding:8px;display:flex;flex-direction:column}
    .nav{display:flex;align-items:center;gap:8px;height:36px;flex:none;border-radius:8px;padding:0 10px;background:#fff;color:#1d2129;font:13px system-ui}
    .sec{margin-top:18px;display:flex;align-items:center;gap:8px;padding:0 10px;height:28px;flex:none;color:var(--dsw-alias-label-secondary);font:12px system-ui}
    .list{display:flex;flex-direction:column;gap:4px;flex:none}
    .row{display:flex;align-items:center;height:36px;border-radius:8px;padding:0 10px;background:#fff;color:#1d2129;font:13px system-ui}
    .foot{margin-top:auto;display:flex;flex-direction:column;gap:4px}
    .main{flex:1;background:var(--dsw-alias-bg-base)}
  </style>
  </head>
  <body>
    <div class="shell">
      <aside class="side">
        <div class="nav">新会话</div>
        <div class="nav">插件</div>
        <div class="sec" id="workspace-section">工作区</div>
        <div class="list">
          <div class="row">dsh</div>
          <div class="row">内部插件市场方案设计</div>
        </div>
        <div class="foot">
          <div class="row">设置</div>
        </div>
      </aside>
      <div class="main"></div>
    </div>
    <div id="root"></div>
  </body>
</html>
`

const SHELL_INDEX = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>DeepSeek Harness (local shell stub)</title></head>
  <body>
    <div id="root"></div>
  </body>
</html>
`

const ctx = {
  get: (name) => (name === 'webServer' ? webServer : undefined),
  effect: (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  on: (event, listener) => {
    if (event !== 'webserver/index-inject') return () => {}
    indexInjectListeners.push(listener)
    return () => {
      const index = indexInjectListeners.indexOf(listener)
      if (index >= 0) indexInjectListeners.splice(index, 1)
    }
  },
}

const mod = await import(pathToFileURL('E:/workspace/dsh/lib/plugin.js').href)
mod.apply(ctx)
console.log(
  `plugin applied; routes=${routes.length} indexTaps=${indexTaps.length} indexInjectListeners=${indexInjectListeners.length}`,
)


const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')

  // Diagnostic endpoint: exactly the rows the desktop host would ship to the
  // Electron renderer over IPC. This is the channel the desktop shell uses, so it
  // is the one worth asserting on.
  if (url.pathname === '/__shell-injections') {
    const body = JSON.stringify({ rows: webServer.collectIndexInjections() }, null, 2)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(body)
    return
  }

  // The shell index: serve the stub through every registered tap.
  // `?shell=sidebar` selects the skeleton that models the real sidebar, so the
  // entry can be rendered where it will actually live.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    let html = url.searchParams.get('shell') === 'sidebar' ? SHELL_WITH_SIDEBAR : SHELL_INDEX
    for (const tap of indexTaps) html = tap(html)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }

  const match =
    routes.find((route) => route.kind === 'exact' && route.path === url.pathname) ??
    routes.find((route) => route.kind === 'prefix' && url.pathname.startsWith(route.path))
  if (!match) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'no route', path: url.pathname }))
    return
  }
  Promise.resolve(match.handler(req, res)).catch((error) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String(error?.message ?? error) }))
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`marketplace listening on http://127.0.0.1:${port}`)
  console.log(`  page      http://127.0.0.1:${port}/market`)
  console.log(`  catalog   http://127.0.0.1:${port}/dsh-market/catalog`)
  console.log(`  pageHtml  ${existsSync('E:/workspace/dsh/web/market.html') ? 'found' : 'MISSING'}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close()
    process.exit(0)
  })
}

