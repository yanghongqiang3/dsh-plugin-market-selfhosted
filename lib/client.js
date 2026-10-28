/**
 * Client half — the native in-app entry.
 *
 * Written to the official contract rather than by imitation:
 *
 *   - `references/ui-plugin.md`: a plain script that registers a lazy factory whose
 *     id EQUALS the package name, via `window.__ModuleLoader__.load`. React comes
 *     from the browser module table; no bundler, no duplicate React.
 *   - `references/practices.md`: contribute through `ctx.slots.inject(ownerKey, …)`
 *     so a registration is disposed when the owning declaration collapses and
 *     reinstalled when it returns. Do NOT write DOM outside the component and do
 *     NOT append to `document.body` — the previous revision of this plugin did
 *     exactly that, and it was the wrong mechanism for a UI entry.
 *   - Styling uses only the `--dsw-alias-*` / `--dsw-specific-*` tokens the Theme
 *     inspect provider lists, so light and dark both work with no media query.
 *     Literal colours are for artwork only; the icon uses `currentColor`.
 *   - No Harness Client package is `require`d. `dsh.client.inject` only orders
 *     activation; the control is written by hand and matched to the host.
 *
 * Seat used: `sidebar.footer.action` — "Optional actions beside Settings at the
 * sidebar foot", replaceRisk none, owner props `{ wide }`, declared by
 * `@deepseek-ai/dsh-client-ui-sidebar`.
 *
 * It opens the market in the user's browser and deliberately does not navigate: the
 * shell's origin is `dsh-app://app`, so a same-window navigation would replace the
 * single-page app and strand the user with no way back.
 *
 * NOT USED: `sidebar.panellist`. It looks like the natural seat for a plugin-style
 * entry — its rows sit right beside 插件 — but its rows are PANEL SELECTORS: the owner
 * renders one row per registered main-panel key and calls `layout.selectPanel(id)` on
 * click, and that method throws for an id owning no panel. Registering a glyph there
 * without also registering a panel produced a row that was visible and did nothing
 * when clicked. That is worse than having no entry, because it looks available.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-market-selfhosted',
  factory(require) {
    const React = require('react')

    const ENTRY_ID = 'market'
    const LABEL = '内部插件市场'

    // Filled from the host half once `webServer` is bound; the client cannot know
    // the port. The fallback is the documented path for the HTTP-served shell.
    let marketUrl = '/market'

    function openMarket() {
      // Absolute URL in a new window. The main window's handler hands http/https
      // to the operating system, so DSH keeps its UI.
      window.open(marketUrl, '_blank', 'noopener,noreferrer')
    }

    function MarketIcon({ size }) {
      return React.createElement(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: 'none' },
        },
        React.createElement('path', { d: 'M4 8.5 6 4h12l2 4.5' }),
        React.createElement('path', { d: 'M4.5 8.5h15V19a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z' }),
        React.createElement('path', { d: 'M9.5 12h5' }),
      )
    }

    /**
     * The control, matched to the host's sidebar rows.
     *
     * 36px tall and 8px radius mirror the shipped sidebar rows; colours and hover
     * surfaces are tokens so both themes work without a media query.
     */
    function MarketButton({ wide, size }) {
      const [hover, setHover] = React.useState(false)
      return React.createElement(
        'button',
        {
          type: 'button',
          title: LABEL,
          'aria-label': LABEL,
          onClick: openMarket,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: wide ? 'flex-start' : 'center',
            gap: 8,
            width: wide ? '100%' : 36,
            height: 36,
            padding: wide ? '0 8px' : 0,
            border: 0,
            borderRadius: 8,
            background: hover ? 'var(--dsw-alias-bg-layer-1)' : 'transparent',
            color: 'var(--dsw-alias-label-primary)',
            cursor: 'pointer',
            font: 'inherit',
            textAlign: 'left',
          },
        },
        React.createElement(MarketIcon, { size: size ?? 18 }),
        wide
          ? React.createElement(
            'span',
            { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            LABEL,
          )
          : null,
      )
    }

    /** The footer seat receives the column state, so it can render wide or narrow. */
    function MarketFooterAction(props) {
      return React.createElement(MarketButton, { wide: props?.wide !== false, size: 18 })
    }

    return {
      name: 'dsh-plugin-market-selfhosted',
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        // Optional seat: stay inactive instead of throwing when it is absent.
        if (slots === undefined) return

        // The host half owns the bound port; ask it rather than guessing. Both the
        // market page and this route are served by the same webServer, so the call
        // is same-origin.
        fetch('/dsh-market/open', { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then(
            (body) => {
              if (typeof body?.url === 'string' && body.url.length > 0) marketUrl = body.url
            },
            () => { /* keep the relative fallback */ },
          )

        // One seat only. `sidebar.panellist` is deliberately not registered: its rows
        // select a main panel, and an id with no panel behind it produces a dead row.
        slots.inject('sidebar.footer.action', () =>
          slots.register(
            { name: 'sidebar.footer.action', id: ENTRY_ID, order: 10, label: LABEL },
            MarketFooterAction,
          ),
        )
      },
    }
  },
})
