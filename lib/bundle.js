/**
 * @dsh-internal/dsh-plugin-marketplace — bundle host entry.
 *
 * Deliberately EMPTY, matching every shipped bundle (verified in app.asar:
 * `@deepseek-ai/dsh-base/lib/index.js` and
 * `@deepseek-ai/dsh-experimental-schedule-bundle/lib/index.js` both read
 * `export {}`).
 *
 * Why this matters: a bundle's own entry is audited by the desktop host, and a
 * non-activating bundle entry is reported as a fatal
 * "web boot: N entry did not activate". The bundle is a patch layer that
 * declares rows — it must not carry behaviour of its own. The host behaviour
 * lives in the row this bundle inserts, i.e. `./plugin` (see cordis.patch.yml).
 */

export {}
