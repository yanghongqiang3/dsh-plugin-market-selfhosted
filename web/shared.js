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
    setMe(result.body.user)
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
   * Record the signed-in user and derive the admin flag.
   *
   * The service reports `role: 'admin' | 'member'` — there is no boolean `isAdmin`
   * field. Reading one anyway made every administrator look like a member, which
   * sent a freshly signed-in admin to 「需要管理员权限」. Derived here, once, so no
   * caller can get it wrong again.
   */
  function setMe(user) {
    if (user !== undefined && user !== null) state.me = user
    state.isAdmin = state.me?.role === 'admin'
    setWho(state.me?.displayName ?? state.me?.username ?? '')
    return state.me
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

  /**
   * A header row for a `trow`-built table.
   *
   * Takes the SAME shape as `trow` — `[[text, cls], …]` — and for a reason: the column
   * widths come from the classes, so a header cell and its body cell must carry the same
   * one or the columns drift apart. Building it from `trow` makes that the caller's only
   * option, rather than something to remember.
   *
   * The tables had no headings at all, so cells like 「普通」 and 「待改密」 were readable
   * only by someone who already knew what the columns were.
   */
  function thead(children) {
    const row = trow(children)
    row.classList.add('head')
    return row
  }

  function miniButton(text, onClick, danger) {
    const button = global.document.createElement('button')
    button.className = 'btn btn-mini' + (danger ? ' btn-danger' : '')
    button.textContent = text
    button.addEventListener('click', onClick)
    return button
  }

  // ------------------------------------------------------------- modal dialogs
  //
  // Every create/edit form goes through this, so they cannot drift apart in behaviour:
  // Esc closes, clicking the backdrop closes, focus starts in the first field, and the
  // submit button locks while the request is in flight (a double-click on 「创建」 used
  // to be able to fire two creates).
  //
  // The dialog lives in a <dialog> element, which gives focus trapping and the backdrop
  // for free rather than re-implementing both.

  /**
   * `openForm({ title, hint, fields, submitLabel, onSubmit })`
   *
   * `fields` is an array of:
   *   { name, label, type, value, placeholder, options, required, wide, hint }
   * `type` is a normal input type, or `'select'` for `options`, or `'chips'` for a
   * multi-select rendered as the same chips the tables use.
   *
   * `onSubmit(values)` returns `{ ok: true }` to close, or `{ ok: false, detail }` to
   * keep the dialog open with the reason shown — a failed edit must not discard what
   * the administrator typed.
   */
  function openForm(options) {
    const dialog = global.document.createElement('dialog')
    dialog.className = 'dlg'

    const form = global.document.createElement('form')
    form.className = 'dlg-form'
    dialog.appendChild(form)

    const heading = global.document.createElement('h2')
    heading.textContent = options.title ?? ''
    form.appendChild(heading)

    if (options.hint) {
      const hint = global.document.createElement('div')
      hint.className = 'hint'
      hint.textContent = options.hint
      form.appendChild(hint)
    }

    const body = global.document.createElement('div')
    body.className = 'dlg-body'
    form.appendChild(body)

    const inputs = {}
    for (const field of options.fields ?? []) {
      const wrap = global.document.createElement('label')
      wrap.className = 'field' + (field.wide ? ' wide' : '')
      const caption = global.document.createElement('span')
      caption.textContent = field.label ?? field.name
      wrap.appendChild(caption)

      if (field.type === 'chips') {
        const box = global.document.createElement('div')
        box.className = 'chips'
        inputs[field.name] = { kind: 'chips', box }
        for (const choice of field.options ?? []) {
          const on = (field.value ?? []).includes(choice.value)
          box.appendChild(chip(choice.label ?? choice.value, on, function toggle() {
            const now = this.classList.toggle('on')
            this.dataset.on = now ? '1' : ''
          }))
        }
        wrap.appendChild(box)
      } else if (field.type === 'select') {
        const select = global.document.createElement('select')
        for (const choice of field.options ?? []) {
          const option = global.document.createElement('option')
          option.value = choice.value
          option.textContent = choice.label ?? choice.value
          select.appendChild(option)
        }
        select.value = field.value ?? ''
        inputs[field.name] = { kind: 'input', el: select }
        wrap.appendChild(select)
      } else {
        const input = global.document.createElement('input')
        input.type = field.type ?? 'text'
        input.value = field.value ?? ''
        if (field.placeholder) input.placeholder = field.placeholder
        if (field.readonly) input.readOnly = true
        inputs[field.name] = { kind: 'input', el: input }
        wrap.appendChild(input)
      }

      if (field.hint) {
        const note = global.document.createElement('span')
        note.className = 'meta'
        note.textContent = field.hint
        wrap.appendChild(note)
      }
      body.appendChild(wrap)
    }

    const error = global.document.createElement('div')
    error.className = 'err'
    form.appendChild(error)

    const actions = global.document.createElement('div')
    actions.className = 'dlg-actions'
    const cancel = global.document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'btn'
    cancel.textContent = '取消'
    const submit = global.document.createElement('button')
    submit.type = 'submit'
    submit.className = 'btn btn-primary'
    submit.textContent = options.submitLabel ?? '保存'
    actions.appendChild(cancel)
    actions.appendChild(submit)
    form.appendChild(actions)

    const readValues = () => {
      const values = {}
      for (const [name, handle] of Object.entries(inputs)) {
        if (handle.kind === 'chips') {
          values[name] = [...handle.box.querySelectorAll('.chip.on')].map((el) => el.textContent)
        } else {
          values[name] = handle.el.value
        }
      }
      return values
    }

    const close = () => {
      dialog.close()
      dialog.remove()
    }
    /**
     * Remove the element however the dialog was dismissed.
     *
     * `close()` above is only one of the ways out: pressing Escape closes the dialog
     * natively, which fires `close` WITHOUT running our helper. The element then stayed
     * in the DOM forever — invisible (`<dialog>` without `open` is `display:none`), so it
     * looked fine, but every Escape leaked a node with all its listeners. Found by
     * `tools/probe-console-ui.mjs`: the `cancel` and `close` events both fired while the
     * element was still queryable.
     */
    dialog.addEventListener('close', () => dialog.remove())
    cancel.addEventListener('click', close)
    // Clicking the backdrop closes. The dialog element itself is the backdrop area, so a
    // click whose target IS the dialog (not a child) is a backdrop click.
    dialog.addEventListener('click', (event) => { if (event.target === dialog) close() })

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      error.textContent = ''
      submit.disabled = true
      const label = submit.textContent
      submit.textContent = '保存中…'
      try {
        const result = await options.onSubmit(readValues(), { close })
        if (result && result.ok === false) {
          error.textContent = result.detail ?? '保存失败'
          return
        }
        close()
      } catch (caught) {
        error.textContent = String(caught?.message ?? caught)
      } finally {
        submit.disabled = false
        submit.textContent = label
      }
    })

    global.document.body.appendChild(dialog)
    dialog.showModal()
    const first = Object.values(inputs).find((handle) => handle.kind === 'input' && !handle.el.readOnly)
    if (first) first.el.focus()
    return { dialog, close, readValues }
  }

  /** A yes/no dialog for destructive actions, in place of `confirm()`. */
  function openConfirm({ title, body, confirmLabel = '确定', danger = false }) {
    return new Promise((resolve) => {
      const dialog = global.document.createElement('dialog')
      dialog.className = 'dlg'
      const form = global.document.createElement('form')
      form.className = 'dlg-form'
      const heading = global.document.createElement('h2')
      heading.textContent = title ?? '确认'
      const text = global.document.createElement('div')
      text.className = 'hint'
      text.textContent = body ?? ''
      const actions = global.document.createElement('div')
      actions.className = 'dlg-actions'
      const cancel = global.document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'btn'
      cancel.textContent = '取消'
      const go = global.document.createElement('button')
      go.type = 'submit'
      go.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary')
      go.textContent = confirmLabel
      actions.appendChild(cancel)
      actions.appendChild(go)
      form.appendChild(heading)
      form.appendChild(text)
      form.appendChild(actions)
      dialog.appendChild(form)

      const finish = (answer) => {
        dialog.close()
        dialog.remove()
        resolve(answer)
      }
      // Same leak as the form dialog: Escape fires `close` without running `finish`.
      dialog.addEventListener('close', () => dialog.remove())
      cancel.addEventListener('click', () => finish(false))
      dialog.addEventListener('click', (event) => { if (event.target === dialog) finish(false) })
      form.addEventListener('submit', (event) => { event.preventDefault(); finish(true) })
      global.document.body.appendChild(dialog)
      dialog.showModal()
      go.focus()
    })
  }

  // ---------------------------------------------------------------- pagination
  //
  // Server-side: the shell only reports which page is wanted and how many rows exist.
  // Every list uses the same control so page size, wording and edge cases match.

  const PAGE_SIZES = [10, 20, 50]

  /**
   * `makePager({ mount, pageSize, onChange })`
   *
   * Renders into `mount(id)` and calls `onChange({ limit, offset })` whenever the page or
   * page size changes. It never holds the data — the caller re-fetches.
   */
  function makePager({ mount, pageSize = 20, onChange }) {
    const state = { limit: pageSize, offset: 0, total: 0 }
    const host = typeof mount === 'string' ? $(mount) : mount

    const render = () => {
      host.textContent = ''
      const pages = Math.max(1, Math.ceil(state.total / state.limit))
      const current = Math.floor(state.offset / state.limit) + 1

      const info = global.document.createElement('span')
      info.className = 'meta'
      info.textContent = state.total === 0
        ? '共 0 条'
        : `共 ${state.total} 条　第 ${current} / ${pages} 页`
      host.appendChild(info)

      const go = (offset) => {
        state.offset = Math.max(0, Math.min(offset, (pages - 1) * state.limit))
        render()
        onChange({ limit: state.limit, offset: state.offset })
      }

      const prev = miniButton('上一页', () => go(state.offset - state.limit))
      prev.disabled = current <= 1
      const next = miniButton('下一页', () => go(state.offset + state.limit))
      next.disabled = current >= pages
      const first = miniButton('首页', () => go(0))
      first.disabled = current <= 1
      const last = miniButton('末页', () => go((pages - 1) * state.limit))
      last.disabled = current >= pages
      for (const button of [first, prev, next, last]) host.appendChild(button)

      const size = global.document.createElement('select')
      for (const value of PAGE_SIZES) {
        const option = global.document.createElement('option')
        option.value = String(value)
        option.textContent = `每页 ${value}`
        size.appendChild(option)
      }
      size.value = String(state.limit)
      size.addEventListener('change', () => {
        // Keep the first visible row the same where possible. Jumping to row 0 on a page
        // size change loses the reader's place for no reason.
        const firstRow = state.offset
        state.limit = Number(size.value)
        go(Math.floor(firstRow / state.limit) * state.limit)
      })
      host.appendChild(size)
    }

    render()
    return {
      state,
      setTotal(total) { state.total = total; render() },
      reset() { state.offset = 0; render() },
      render,
      get params() { return { limit: state.limit, offset: state.offset } },
    }
  }

  /**
   * Decide where the service is, then show the right view.
   *
   * There are two ways this page can be served, and they need opposite treatment:
   *
   *  - **By the service itself** (the console at `/console`). The service URL is
   *    simply this origin — there is no DSH host plugin to ask, and asking it is
   *    wrong: `/dsh-market/config` is a route of the LOCAL plugin, so on the service
   *    origin it 404s and this page would conclude "not configured" and refuse to
   *    start. That is exactly what happened.
   *  - **By the DSH host plugin** (the install page at `/market`). Only this machine
   *    knows the bound service URL, so the config probe is required.
   *
   * `serveSelf` is declared by the page that the service serves.
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

    // Page-specific setup that must finish before the flow continues. The install
    // page uses it to read this machine's DSH identity, which has to be known before
    // the post-login binding runs — and, on a reload with a token already stored,
    // before `enter()` fires at all.
    if (typeof options.beforeBoot === 'function') await options.beforeBoot()

    if (options.serveSelf === true) {
      state.serviceUrl = global.location.origin
      state.serviceConfigured = true
      state.profileDir = null
    } else {
      let localConfig = null
      try {
        const result = await local('/dsh-market/config')
        localConfig = result.body
      } catch { /* the local half may not be reachable; reported below */ }

      state.serviceUrl = localConfig?.serviceUrl ?? null
      state.serviceConfigured = Boolean(localConfig?.configured)
      state.profileDir = localConfig?.profileDir ?? null
    }

    // A token issued by a different service is meaningless here: drop it rather
    // than showing a confusing 401.
    if (token.get() && global.localStorage.getItem(SERVICE_KEY) !== state.serviceUrl) token.clear()

    // Say which service the login is for. Rendered here rather than after a
    // successful sign-in, so it is visible on the very screen that needs it.
    const hint = $('login-service')
    if (hint) hint.textContent = state.serviceUrl ? `服务端：${state.serviceUrl}` : ''

    if (!state.serviceConfigured) {
      show('noService')
      return state
    }

    if (!token.get()) {
      show('login')
      return state
    }

    try {
      const me = await service('/dsh-market/auth/me')
      if (!me.ok) { show('login'); return state }
      setMe(me.body?.user)
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
    thead,
    miniButton,
    openForm,
    openConfirm,
    makePager,
    PAGE_SIZES,
    doLogin,
    doChangePassword,
    doLogout,
    init: boot,
    onAuthenticated,
  }
})(globalThis)
