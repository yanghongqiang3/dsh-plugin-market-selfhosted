/**
 * @dsh-internal/dsh-plugin-market-selfhosted — bare-package-name entry.
 *
 * This module is what a `dsh.client` row loads, because such a row MUST name the
 * bare package (see cordis.patch.yml). The browser artifact is served separately
 * from `exports["./client"]`.
 *
 * WHY THIS IS NOT `export {}`
 *
 * An earlier revision of this file was empty, with a comment asserting an empty
 * bundle entry was "the convention" because the behaviour lives in the `./plugin`
 * row. That reasoning was wrong and it silently broke the browser half: the loader
 * validates every row's module and rejects an empty namespace with
 *
 *   invalid plugin, expect function or object with an "apply" method, received object
 *
 * The row then never produces a fiber, which the activation audit reports only as
 * the unhelpful `failed to import`. Nothing ever reached the client-modules layer,
 * so the client bundle was never served and the slot was never registered. The real
 * error was visible only by intercepting the loader's own logger.
 *
 * The documented Host form (`references/host-plugin.md`, `templates/decoration/
 * index.js`) is a module exporting `apply`, so export one. It has nothing to do —
 * all behaviour lives in the `./plugin` row.
 */

export const name = 'dsh-plugin-market-selfhosted'

/** No-op host side; the `./plugin` row owns all behaviour. */
export function apply() {}
