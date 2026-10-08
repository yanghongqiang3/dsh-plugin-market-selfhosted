/**
 * Shared browser shell for the two market surfaces.
 *
 * Two audiences, two pages, one service:
 *
 *   /market   the DSH entry — your own catalog, install and uninstall only
 *   /console  the server console — accounts, groups, rules, publishing
 *
 * They must not share a screen: a user who can only install should not be shown an
 * admin tab they cannot use, and an administrator doing policy work should not be
 * navigating a plugin catalog. What they DO share is tens of lines of plumbing —
 * token storage, the two request targets, view switching, form helpers and the four
 * auth actions. Copying that into both pages would rot immediately, so it lives
 * here and each page declares only its own views and flow.
 *
 * Classic script, no build step, matching the rest of the project: the page load
 * order is `shared.js` then the page's own inline script.
 */
;(function shared(global) {
  'use strict'

  const TOKEN_KEY = 'dsh.market.token'
  /** Which service the stored token belongs to — a token is not portable across services. */
  const SERVICE_KEY = 'dsh.market.service'

  /**
   * Reserve the window-control strip only when running inside the desktop shell.
   *
   * The shell exposes `globalThis.dshDesktopBoot` before these scripts run. In a
   * normal browser tab there is no overlay, so the strip stays collapsed — otherwise
   * the page would carry a mysterious 40px gap.
   */
  if (global.dshDesktopBoot !== undefined && global.document !== undefined) {
    global.document.body.classList.add('chrome')
  }

  const $ = (id) => global.document.getElementById(id)

  const token = {
    get: () => global.localStorage.getItem(TOKEN_KEY),
    set: (value) => global.localStorage.setItem(TOKEN_KEY, value),
    clear: () => global.localStorage.removeItem(TOKEN_KEY),
  }

  /**
   * Per-page state. Each page owns these; nothing here writes another page's DOM.
   * @type {{views: string[], onView: Function|null}}
   */
  const config = { views: [], onView: null }

  const state = {
    /** The signed-in user, from GET /dsh-market/auth/me. */
    me: null,
    isAdmin: false,
    profileDir: null,
    serviceUrl: null,
    serviceConfigured: false,
  }

  /** Which view is on screen. `show` is a no-op if the page has no such view. */
  let currentView = null

  function show(view) {
    if (config.views.length > 0 && !config.views.includes(view)) return
    currentView = view
    for (const name of config.views) {
      const el = $(`view-${name}`)
      if (el) el.classList.toggle('hidden', name !== view)
    }
    if (typeof config.onView === 'function') config.onView(view, state)
  }

  function current() { return currentView }

  function setWho(text) { const el = $('who'); if (el) el.textContent = text || '' }

  function status(message, isError) {
    const el = $('status')
    if (!el) return
    el.textContent = message || ''
    el.classList.toggle('error', Boolean(isError))
  }

  /**
   * Two different backends, on purpose:
   *   service(path) -> the market service, authoritative for identity and policy
   *   local(path)   -> this machine's plugin, which owns the profile and its files
   */
  async function service(path, options = {}) {
    return request(`${state.serviceUrl}${path}`, options)
  }

  async function local(path, options = {}) {
    return request(path, options)
  }

  async function request(url, options = {}) {
    const headers = { accept: 'application/json', ...(options.headers || {}) }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.auth !== false && token.get()) headers.authorization = `Bearer ${token.get()}`

    let response
    try {
      response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
    } catch (error) {
      return {
        ok: false,
        status: 0,
        body: { code: 'E_UNREACHABLE', detail: `无法连接 ${url}：${error?.message ?? error}` },
      }
    }

    let body = null
    try { body = await response.json() } catch { body = null }

    if (response.status === 401) {
      token.clear()
      state.me = null
      show('login')
      throw Object.assign(new Error('unauthenticated'), { code: 'E_NOT_LOGGED_IN', status: 401 })
    }
    if (response.status === 403 && body?.code === 'E_MUST_CHANGE_PASSWORD') {
      show('password')
      throw Object.assign(new Error('must-change-password'), { code: body.code, status: 403 })
    }
    return { ok: response.ok, status: response.status, body }
  }

  /** Where to go once authenticated. Every surface needs a signed-in user. */
  let afterAuth = null

  function onAuthenticated(handler) { afterAuth = handler }

  async function enter() {
    if (typeof afterAuth === 'function') await afterAuth()
  }

  async function doLogin() {
    const username = $('login-user').value.trim()
    const password = $('login-pass').value
    $('login-err').textContent = ''
    if (!username || !password) { $('login-err').textContent = '请输入用户名与密码'; return }
    const result = await service('/dsh-market/auth/login', {
      method: 'POST', body: { username, password }, auth: false,
    })
    if (!result.ok) {
      $('login-err').textContent = result.body?.detail || result.body?.code || `登录失败（HTTP ${result.status}）`
      return
    }
    token.set(result.body.token)
    global.localStorage.setItem(SERVICE_KEY, state.serviceUrl ?? '')
    $('login-pass').value = ''
    state.me = result.body.user ?? null
    if (result.body.mustChangePassword) {
      setWho(result.body.user?.displayName ?? username)
      show('password')
      return
    }
    await enter()
  }

  async function doChangePassword() {
    const next = $('pw-next').value
    const again = $('pw-next2').value
    $('pw-err').textContent = ''
    if (next.length < 12) { $('pw-err').textContent = '新密码至少 12 位'; return }
    if (next !== again) { $('pw-err').textContent = '两次输入的新密码不一致'; return }
    const result = await service('/dsh-market/auth/password', { method: 'POST', body: { newPassword: next } })
    if (!result.ok) {
      $('pw-err').textContent = result.body?.detail || result.body?.code || `改密失败（HTTP ${result.status}）`
      return
    }
    $('pw-next').value = $('pw-next2').value = ''
    await enter()
  }

  async function doLogout() {
    try { await service('/dsh-market/auth/logout', { method: 'POST' }) } catch { /* ignore */ }
    token.clear()
    state.me = null
    setWho('')
    status('')
    if (typeof config.onLogout === 'function') config.onLogout()
    show('login')
  }

  /**
   * Device-authorization flow, shared because it belongs to the platform rather than
   * to either surface: it signs THIS MACHINE in, so the DSH host plugin can act
   * without a human pasting credentials into a page.
   */
  function runActivate(userCode) {
    const code = $('act-code')
    const err = $('act-err')
    err.textContent = ''
    if (!userCode) { err.textContent = '请输入设备码'; return }
    service('/dsh-market/auth/device/approve', { method: 'POST', body: { userCode } })
      .then((result) => {
        if (!result.ok) {
          err.textContent = result.body?.detail || result.body?.code || `激活失败（HTTP ${result.status}）`
          return
        }
        code.value = ''
        status('设备已激活，可以回到本机继续安装。')
        show('login')
      })
      .catch(() => { /* request() already switched views */ })
  }

  async function startActivate() {
    const pending = global.__marketPendingActivation
    if (!pending) return
    $('act-code').value = pending
    try {
      const result = await service('/dsh-market/auth/me')
      state.me = result.body?.user ?? state.me
      state.isAdmin = Boolean(result.body?.user?.isAdmin || result.body?.admin)
      setWho(state.me?.displayName ?? state.me?.username ?? '')
      if (result.ok) show('activate')
    } catch { /* not signed in: login first, activation stays reachable from the link */ }
  }

  // --------------------------------------------------------------- form helpers

  function tag(text, cls) {
    const span = global.document.createElement('span')
    span.className = 'tag' + (cls ? ' ' + cls : '')
    span.textContent = text
    return span
  }

  function chip(text, on, onClick) {
    const button = global.document.createElement('button')
    button.type = 'button'
    button.className = 'chip' + (on ? ' on' : '')
    button.textContent = text
    button.addEventListener('click', onClick)
    return button
  }

  function trow(children) {
    const row = global.document.createElement('div')
    row.className = 'tr'
    for (const [text, cls] of children) {
      const cell = global.document.createElement('div')
      if (cls) cell.className = cls
      cell.textContent = text
      row.appendChild(cell)
    }
    return row
  }

  function miniButton(text, onClick, danger) {
    const button = global.document.createElement('button')
    button.className = 'btn btn-mini' + (danger ? ' btn-danger' : '')
    button.textContent = text
    button.addEventListener('click', onClick)
    return button
  }

  /**
   * Fetch the local host plugin's config, then decide what the user sees.
   *
   * The local half knows the service URL and the profile directory; the service is
   * authoritative for identity. Both are needed before any view is meaningful.
   */
  async function boot(options = {}) {
    const views = options.views ?? []
    config.views = views
    config.onView = options.onView ?? null
    config.onLogout = options.onLogout ?? null

    for (const name of views) {
      for (const id of [`view-${name}`]) {
        const el = $(id)
        if (!el) throw new Error(`shared boot: page declares view "${name}" but has no #${id}`)
      }
    }

    let localConfig = null
    try {
      const result = await local('/dsh-market/config')
      localConfig = result.body
    } catch { /* the local half may not be reachable; reported below */ }

    state.serviceUrl = localConfig?.serviceUrl ?? null
    state.serviceConfigured = Boolean(localConfig?.configured)
    state.profileDir = localConfig?.profileDir ?? null

    if (!state.serviceConfigured) {
      show('noService')
      return state
    }

    const pending = new global.URLSearchParams(global.location.search).get('user_code')
    if (pending) {
      global.__marketPendingActivation = pending
      show('login')
      await startActivate()
      return state
    }

    if (!token.get()) {
      show('login')
      return state
    }

    try {
      const me = await service('/dsh-market/auth/me')
      if (!me.ok) { show('login'); return state }
      state.me = me.body?.user ?? null
      state.isAdmin = Boolean(state.me?.isAdmin)
      setWho(state.me?.displayName ?? state.me?.username ?? '')
      await enter()
    } catch {
      /* request() already switched to login or password */
    }
    return state
  }

  global.MarketShell = {
    $,
    token,
    state,
    service,
    local,
    request,
    show,
    current,
    setWho,
    status,
    tag,
    chip,
    trow,
    miniButton,
    doLogin,
    doChangePassword,
    doLogout,
    runActivate,
    init: boot,
    onAuthenticated,
  }
})(globalThis)
