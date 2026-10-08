/**
 * The one rule for "where is the manifest inside this archive".
 *
 * Shared by the service and the DSH host plugin on purpose. They disagreed, and the
 * disagreement was a real defect: `inspectArchive` accepted an npm-layout archive (everything
 * under `package/`) while the client looked up `package.json` at the ROOT ONLY, so the market
 * accepted an artifact the client could not install — `E_NOT_PACKAGE` at the last step, after
 * a successful publish and a successful download.
 *
 * This is the same reason `version.js` is shared: two implementations of a rule that MUST
 * agree will eventually disagree, and the symptom appears far from the cause.
 *
 * Pure: no imports, no filesystem. Both packers ship it (see INCLUDE_FILES).
 */

/** Prefixes that mean "the manifest is not at the root". */
export function normaliseArchiveName(name) {
  return String(name).replace(/^\.\//, '')
}

/**
 * Work out the prefix that must be stripped to reach a package root.
 *
 * @param {Iterable<string>} names archive entry names
 * @returns {{ ok: true, prefix: string, layout: 'flat'|'package'|'wrapped' }
 *          | { ok: false, code: string, detail: string }}
 */
export function detectPackagePrefix(names) {
  const cleaned = [...names].map(normaliseArchiveName)
  const hasRoot = cleaned.includes('package.json')
  const hasNpm = cleaned.includes('package/package.json')

  if (hasRoot && hasNpm) {
    // Guessing here would silently install the wrong tree.
    return {
      ok: false,
      code: 'E_NOT_PACKAGE',
      detail: '归档同时存在根级与 package/ 下的 package.json，布局不明确',
    }
  }
  if (hasRoot) return { ok: true, prefix: '', layout: 'flat' }
  if (hasNpm) return { ok: true, prefix: 'package/', layout: 'package' }

  /**
   * A single shared top-level directory.
   *
   * Right-clicking a folder and choosing "compress" wraps everything in a directory named
   * after the folder (`my-skill/SKILL.md`, `my-skill/package.json`), so an otherwise perfect
   * archive has no manifest where it is expected. `package/` is just one instance of this
   * shape, which is why one rule covers both.
   */
  const topLevel = new Set()
  for (const name of cleaned) {
    const slash = name.indexOf('/')
    // A top-level FILE means there is no single wrapping directory.
    if (slash < 0) return noPackage()
    topLevel.add(name.slice(0, slash))
  }
  if (topLevel.size !== 1) return noPackage()
  const [wrapper] = [...topLevel]
  const prefix = `${wrapper}/`
  if (!cleaned.includes(`${prefix}package.json`)) return noPackage()
  return { ok: true, prefix, layout: 'wrapped' }
}

function noPackage() {
  return {
    ok: false,
    code: 'E_NOT_PACKAGE',
    detail: '归档内没有 package.json（如果压缩时多包了一层目录，也已经尝试过剥掉，仍没找到）',
  }
}

/** Re-key entries through the prefix, so callers see package-relative paths. */
export function stripPrefixFromEntries(entries, prefix) {
  if (prefix === '') return new Map(entries)
  const out = new Map()
  for (const [name, value] of entries) {
    const cleaned = normaliseArchiveName(name)
    if (!cleaned.startsWith(prefix)) continue
    out.set(cleaned.slice(prefix.length), value)
  }
  return out
}
