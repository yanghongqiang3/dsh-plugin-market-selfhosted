/**
 * @dsh-internal/dsh-plugin-marketplace — bundle host entry.
 *
 * Empty on purpose: the behaviour lives in the row this bundle's patch inserts
 * (`./plugin`), so this entry has nothing to do. Every shipped bundle is written
 * the same way, which is why the convention was followed here.
 *
 * Correcting an earlier claim in this file: keeping this entry empty is a
 * CONVENTION, not something the loader enforces. The activation audit in
 * dsh-app-boot only asks whether each row's fiber reached `active`; a row whose
 * `apply` ran is active regardless of what it did. The earlier note here asserted
 * that a bundle entry doing work is "audited as a failing entry" — that is not
 * what the audit does, and this package's own diagnostics contradict it
 * (`[register] registered 5/5 routes` from a row that certainly does work).
 *
 * The real reason this package separates the two is simpler: `exports["."]` is
 * what a bare-package-name row would load, and this package is loaded through the
 * `./plugin` subpath row instead (see cordis.patch.yml).
 */

export {}
