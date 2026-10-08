// Check that the guides only reference things that actually exist, and that their code
// snippets match the real files. A guide full of plausible-looking paths is worse than
// no guide.
import { readFileSync, existsSync } from 'node:fs'

/**
 * Every guide, not just one. The distributing guide was added later and would otherwise
 * have been unchecked — and it is the one whose central claim (the `package/` prefix) was
 * itself discovered by breaking it.
 */
const DOCS = ['docs/adding-a-ui-entry.md', 'docs/distributing.md']
const sources = DOCS.filter((file) => existsSync(file)).map((file) => [file, readFileSync(file, 'utf8')])
const doc = sources.map(([, text]) => text).join('\n')
let problems = 0
const ok = (label, condition, extra = '') => {
  if (condition) console.log(`ok    ${label}${extra ? `  ${extra}` : ''}`)
  else {
    problems += 1
    console.error(`FAIL  ${label}${extra ? `  ${extra}` : ''}`)
  }
}

for (const [file] of sources) ok(`文档存在且被扫描：${file}`, true)

// 1. Every project-relative path the docs name must exist.
//
// Only BACKTICKED paths are checked: bare `lib/index.js` and `lib/types/` appear in
// the section about reading an INSTALLED PACKAGE's layout, which is resolved through
// the plugin Config's `packageDir`, not relative to this repository. Widening the
// scan to all matches produced exactly those two false failures.
const referenced = new Set()
for (const m of doc.matchAll(/`((?:lib|tools|web|server|docs)\/[A-Za-z0-9._/-]+)`/g)) referenced.add(m[1])
console.log(`文档引用的项目内路径: ${referenced.size} 个`)
for (const rel of [...referenced].sort()) {
  ok(`存在 ${rel}`, existsSync(rel))
}
// The doc also quotes a path INSIDE an installed DSH package (the loader source, in a
// code comment) and refers to reading an installed package's `lib/` tree. Those
// resolve through the plugin's own package directory, not relative to this
// repository, so they are deliberately excluded from the existence check above. What
// matters is that the doc says where they DO come from.
ok(
  '说明了已安装包的位置从哪来',
  doc.includes('已安装包的 `lib/`'),
)

// 2. Code snippets must match the real files.
const client = readFileSync('lib/client.js', 'utf8')
ok(
  '文档里的注册片段与 lib/client.js 一致',
  client.includes("slots.inject('sidebar.footer.action'") &&
    client.includes("id: ENTRY_ID, order: 10, label: LABEL"),
)
ok('lib/client.js 不注册 sidebar.panellist（代码中）', !client
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .includes('sidebar.panellist'))

const bundle = readFileSync('lib/bundle.js', 'utf8')
ok('lib/bundle.js 导出 apply', /export\s+function\s+apply/.test(bundle))

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
ok('package.json dsh.client.platform 是 web', pkg.dsh?.client?.platform === 'web')
ok('package.json 有 ./client 导出', Boolean(pkg.exports?.['./client']))
ok(
  'package.json dsh.client.inject 指向 sidebar 包',
  JSON.stringify(pkg.dsh?.client?.inject) === JSON.stringify(['@deepseek-ai/dsh-client-ui-sidebar']),
)

const patch = readFileSync('cordis.patch.yml', 'utf8')
ok('cordis.patch.yml 有裸包名行', /^\s+name:\s*dsh-plugin-marketplace\s*$/m.test(patch))

// 3. The doc must not promise things we have not verified.
const claims = [
  ['未验证项已标注', doc.includes('## 8. 已知不确定')],
  ['明确写了不要 DOM 注入', doc.includes('不要用往 `document.body` 注入 DOM')],
  ['写明三层验证', doc.includes('### 7.3 验证')],
]
for (const [label, condition] of claims) ok(label, condition)

/**
 * 4. The distribution guide's central claim, checked against the packer itself.
 *
 * Every entry MUST land under `package/`. A flat archive installs successfully and
 * then silently loses its directory structure — measured both ways on this machine:
 * entries at the root become `plugin.js` at the package root, `exports` point at files
 * that do not exist, and both loader rows fail with `failed to import`. A guide that
 * states this rule while the tool violates it would be worse than no guide.
 */
{
  const packer = existsSync('tools/pack-dist.mjs') ? readFileSync('tools/pack-dist.mjs', 'utf8') : ''
  ok('存在 tools/pack-dist.mjs', packer.length > 0)
  if (packer.length > 0) {
    ok('打包工具以 package/ 作为 staging 根', /join\(stage, 'package'\)/.test(packer))
    ok(
      '打包工具会拒绝 package/ 之外的条目',
      /entries\.filter\(\(entry\) => !entry\.startsWith\('package\/'\)\)/.test(packer),
    )
  }
  const guide = existsSync('docs/distributing.md') ? readFileSync('docs/distributing.md', 'utf8') : ''
  // Match the SUBSTANCE, not a heading: an earlier version pinned the exact title text
  // and failed the moment the wording changed, which says nothing about the guide.
  ok(
    '分发文档写明了 package/ 前缀是必须的',
    guide.includes('package/') && guide.includes('必须') && guide.includes('丢失'),
  )
  ok('分发文档写明了与市场制品格式不同', guide.includes('与市场上卖的插件不是一个格式'))
  ok('分发文档写明了 dsh plugin add 这一条命令', guide.includes('dsh plugin --profile'))
}

console.log(problems ? `\nRESULT: ${problems} problem(s)` : '\nRESULT: all checks passed')
process.exit(problems ? 1 : 0)
