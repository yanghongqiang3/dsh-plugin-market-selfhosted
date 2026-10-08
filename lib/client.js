/**
 * Client half — the in-app entry.
 *
 * A plain script, NOT a build output. `dsh-client-modules` serves this file at
 * `/plugins/??<pkg>/client.js` and loads it with a classic `<script>` tag, so it
 * registers itself through the loader facade. That is exactly how the shipped
 * template under `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/
 * templates/decoration/` does it — no bundler is involved.
 *
 * Two rules from `dsh-client-modules` decide whether this activates at all:
 *
 *   - the registration `id` must equal the package name exactly, or the loader
 *     concludes the script "loaded without registering" and the row fails;
 *   - `require()` only reaches the platform seed words plus already-materialised
 *     rows. The seed is built by the shell's `rM()` and contains
 *     react / react-dom / react/jsx-runtime / @deepseek-ai/cordis /
 *     @deepseek-ai/dsh-client-store / .../ui-slots / .../ui-primitives /
 *     .../ui-dockkit — so this file stays inside that list.
 *
 * Slot seats used (both declared by the shipped `ui-sidebar`):
 *   sidebar.panellist    — the global panel icons, where 插件 sits
 *   sidebar.footer.action — optional actions beside Settings
 *
 * Both open the market in the user's browser. They deliberately do not navigate,
 * because the shell's own origin is `dsh-app://app`: a same-window navigation
 * replaces the shell's single-page app and strands the user with no way back.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-marketplace',
  factory(require) {
    const React = require('react')

    /** Where the market is. The port is only known to the host half. */
    let marketUrl = null
    let pending = null

    function resolveUrl() {
      if (marketUrl !== null) return Promise.resolve(marketUrl)
      pending ??= fetch('/dsh-market/open', { headers: { accept: 'application/json' } })
        .then((response) => response.json())
        .then((body) => {
          marketUrl = typeof body?.url === 'string' ? body.url : null
          return marketUrl
        })
        .catch(() => {
          pending = null
          return null
        })
      return pending
    }

    function openMarket() {
      resolveUrl().then((url) => {
        if (url === null) return
        // A new window is the point: the main window's setWindowOpenHandler hands
        // http/https to the operating system, so DSH keeps its UI.
        window.open(url, '_blank', 'noopener,noreferrer')
      })
    }

    const panelStyle = {
      display: 'block',
      width: '100%',
      height: '100%',
      padding: 0,
      border: 0,
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
    }

    function MarketGlyph({ size }) {
      return React.createElement(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size ?? 18,
          height: size ?? 18,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        React.createElement('path', { d: 'M4 8.5 6 4h12l2 4.5' }),
        React.createElement('path', { d: 'M4.5 8.5h15V19a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z' }),
        React.createElement('path', { d: 'M9.5 12h5' }),
      )
    }

    function MarketFooterButton() {
      return React.createElement(
        'button',
        {
          type: 'button',
          title: '内部插件市场（在浏览器中打开）',
          onClick: openMarket,
          style: panelStyle,
        },
        React.createElement(MarketGlyph, { size: 18 }),
      )
    }

    function MarketPanelIcon(props) {
      return React.createElement(
        'button',
        {
          type: 'button',
          title: '内部插件市场（在浏览器中打开）',
          'aria-label': '内部插件市场',
          onClick: (event) => {
            event.preventDefault()
            event.stopPropagation()
            openMarket()
          },
          style: panelStyle,
        },
        React.createElement(MarketGlyph, { size: props?.size ?? 18 }),
      )
    }

    return {
      name: 'dsh-plugin-marketplace',
      // `slots` is the only service needed; the shipped ui-sidebar must have
      // declared its seats before we may register into them, which
      // `slots.inject` waits for.
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'market', order: 10, label: '内部插件市场' },
            MarketPanelIcon,
          ),
        )
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'market', order: 10, label: '内部插件市场' },
            MarketFooterButton,
          ),
        )
      },
    }
  },
})
