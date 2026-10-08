/**
 * @dsh-internal/dsh-plugin-marketplace — bundle host entry.
 *
 * Empty on purpose: the behaviour lives in the row this bundle's patch inserts
 * (`./plugin`), so this entry has nothing to do. Every shipped bundle is written
 * the same way, which is why the convention was followed here.
 *
 * Keeping this entry empty is a CONVENTION, not something the loader enforces.
 * The activation audit in dsh-app-boot only asks whether each row's fiber reached
 * `active`; a row whose `apply` ran is active regardless of what it did.
 *
 * Note on `exports["."]`: this file is the bare-package-name entry, which is what
 * a `dsh.client` row would load. That arrangement is written but disabled — see
 * cordis.patch.yml for what was tried and what blocked it.
 */

export {}
