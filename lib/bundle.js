/**
 * @dsh-internal/dsh-plugin-marketplace — bare-package-name entry.
 *
 * This module is what a `dsh.client` row loads, because such a row MUST name the
 * bare package (see cordis.patch.yml). The browser half itself is served
 * separately from `exports["./client"]`, so nothing here is needed for it.
 *
 * It is `export {}` by long-standing convention in this repo: the behaviour lives
 * in the `dsh-plugin-marketplace/plugin` row, so a bundle's own entry has nothing
 * to do. Every shipped DSH bundle is written this way.
 *
 * Keeping this entry empty is a CONVENTION, not something the loader enforces. The
 * activation audit in dsh-app-boot only asks whether each row's fiber reached
 * `active`; a row whose `apply` ran is active regardless of what it did.
 */

export {}
