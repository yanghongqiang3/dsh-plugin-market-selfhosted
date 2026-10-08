# 给 DSH Web 壳加一个入口

本文记录**给 DSH Web 界面增加一个插件入口**的完整做法，以及本项目为此踩过的每一个坑。

写它的原因很直接：这条路我返工了 **7 次**，其中 4 次失败是**我自己写错了检查、或者信了自己编的"约定"**，
而不是机制不允许。文档的价值就在于把这些弯路固化下来，让别人（和以后的我）不必再走。

- 适用：任何想在 DSH Web 界面里加一个按钮 / 面板 / 页面的插件
- 结论先说：**可行，而且不需要构建链**，但有三条硬要求，缺一条就静默失败
- 反面结论也先说：**不要用往 `document.body` 注入 DOM 的方式做入口**（理由见 §6）

---

## 1. 判定你要做的是哪一类

| 你想要 | 该用什么 | 要不要写客户端半边 |
|---|---|---|
| 一个「点了打开外部页面」的按钮 | `sidebar.footer.action` 等动作插槽 | 要 |
| 侧边栏里一个能切换主区域的面板 | 注册 `main` 面板 + `sidebar.panellist` 图标 | 要 |
| 聊天流里的一行 / 一块装饰 | `conversation.chat.node`、`conversation.composer.dock` | 要 |
| 只提供 HTTP 接口 / 后台能力 | 宿主半边路由 | **不要** |

**判断标准**：只要用户要在 DSH 界面里**看到或点到**它，就必须有客户端半边。
宿主半边（`lib/plugin.js`）负责服务、权限、字节；客户端半边（`lib/client.js`）负责渲染。

本项目做的是第一类，所以下面以它为主线。

---

## 2. 三条硬要求（缺一条就静默失败）

客户端插件要能加载，必须同时满足下面三条。**三条都满足才会工作，任何一条不满足的症状都极其模糊。**

### 2.1 `package.json` 必须声明 `dsh.client`，且导出 `./client`

```json
{
  "name": "dsh-plugin-marketplace",
  "type": "module",
  "exports": {
    ".":        { "default": "./lib/bundle.js" },
    "./plugin": { "default": "./lib/plugin.js" },
    "./client": { "default": "./lib/client.js" }
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-sidebar"]
    }
  }
}
```

- 声明了 `dsh.client` 却没有 `exports["./client"]` → `dsh-client-modules` 直接抛
  `declares dsh.client but exports no "./client" bundle`。
- `inject` 的作用是**声明客户端半边依赖哪些包**（只用来决定激活顺序，不是运行期 import）。
  官方模板 `templates/decoration/package.json` 里写的是
  `"inject": ["@deepseek-ai/dsh-client-ui-conversation"]`——**它指向声明目标插槽的那个包**。
  所以你要注册 `sidebar.*`，就得 inject `@deepseek-ai/dsh-client-ui-sidebar`。
  我第一版漏了这一条。

### 2.2 patch 层必须有**裸包名**那一行

```yaml
- insert:
    - id: marketplace
      name: dsh-plugin-marketplace/plugin    # 宿主半边，允许子路径
    - id: marketplace-client
      name: dsh-plugin-marketplace           # 客户端半边，必须是裸包名
```

**为什么必须是裸包名**：`dsh-client-modules` 用 `exactPackageSpecifier()` 解析行名，
含 `/` 的说明符返回 `undefined`，随后 `locatePkgJson()` 会把这条行**静默丢弃**——
没有报错，只是永远没有客户端模块。写成 `dsh-plugin-marketplace/client` 或
`./lib/client.js` 看起来更精确，实际什么都不做。

### 2.3 裸包名入口模块必须导出 `apply`

这是**最难发现的一条**，也是本项目卡最久的那条。

`exports["."]`（即 `lib/bundle.js`）就是裸包名那一行加载的模块。如果它写成：

```js
export {}        // ← 会失败
```

模块能导入成功，但接下来注册插件时被拒。抛出点在 **`@deepseek-ai/cordis`** 的
`registry.plugin()`（不是 loader）：

```js
registry.plugin(plugin, ...) {
  const callback = this.resolve(plugin)
  if (!callback)
    throw new Error('invalid plugin, expect function or object with an "apply" method, received '
                    + typeof plugin)
  ...
}
// resolve(plugin) 返回 undefined，除非 typeof plugin === 'function'
// 或者 isApplicable(plugin)（即它有 apply 方法）
```

空命名空间两样都不满足，于是收到的是：

```
invalid plugin, expect function or object with an "apply" method, received object
```

正确形式（与官方 `templates/decoration/index.js` 一致）：

```js
/** 宿主半边。行为在 ./plugin 那一行，这里什么都不做。 */
export const name = 'dsh-plugin-marketplace'
export function apply() {}
```

**当时我为什么写错**：我在注释里"论证"了空入口是"约定"，因为"行为都在 `./plugin` 那一行"。
这个推理看起来合理，但它是我**编出来的**，不是从机制推出来的——而且我还专门"验证"过它，
验证的是同一个错误前提。**只要一条注释在解释"为什么这样可以"，就应该去查它是否真的可以。**

---

## 3. 症状 → 病因对照表

| 你看到的 | 真实含义 | 去看哪里 |
|---|---|---|
| `N entry did not activate` + `<id> (<name>): failed to import` | **只表示 `entry.fiber === undefined`** | §3.1 |
| `client-modules: 1 client package failed to compose` | 客户端半边组装失败 | 错误文本里的 `package:` / `path:` |
| `declares dsh.client but exports no "./client" bundle` | §2.1 缺 `./client` 导出 | `package.json` |
| `invalid plugin, expect function or object with an "apply" method` | §2.3 裸包名入口没有 `apply` | `lib/bundle.js` |
| `/plugins/<pkg>/client.js` 返回 404 | 客户端 bundle 从未产出 | §3.1 再往上查 |
| 按钮渲染出来了但点了没反应 | 注册到了**面板选择器**插槽却没有面板 | §4.2 |
| 整个 web boot 抛 `unknown index injection row` | 注入行的 `kind` 不在合法列表里 | §6 |

### 3.1 `failed to import` 是个骗人的文案

`dsh-app-boot` 的 `inactiveEntries()` 里，这段逻辑决定了那句文案：

```js
const fiber = entry.fiber
if (fiber === void 0) {
  failures.push({ entry, outcome: { kind: 'failed', error: 'failed to import' } })
  continue
}
```

**它只判断 `fiber === undefined`**，不区分"模块找不到"和"模块被拒绝"。

真实原因在哪里被丢掉，要分两步看。loader 的 `_init()`：

```js
// @deepseek-ai/cordis-plugin-loader/lib/index.js
async _init() {
  let exports
  try {
    exports = await this.parent.tree.import(this.options.name, this.getOuterStack)
  } catch (error) {
    this.ctx.logger.error(error)   // ← 只覆盖「导入失败」
    return                          // ← fiber 保持 undefined
  } finally {
    this._initTask = void 0
  }
  const plugin = this.loader.unwrapExports(exports)
  this._patchContext([])
  this.loader.showLog(this, 'apply')
  this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack).ctx.fiber
  //             ^^^^ 这里抛的错在 try 之外：模块导入成功了，是「注册」这一步拒绝它
}
```

所以对 §2.3 那种情况，**导入是成功的**（`lib/bundle.js` 确实被 import 了），
失败发生在 `registry.plugin()`，该异常继续冒泡，再被记进 logger。
**而无论走哪条路，结果都一样：`fiber` 保持 undefined，审计只报那句 `failed to import`。**

**拿到真实错误的办法**：写一个探针插件，把 loader 的 logger 换掉。

```js
// 探针插件的 apply(ctx) 里
const logger = ctx.loader?.ctx?.logger
if (logger && typeof logger.error === 'function' && !logger.__probed) {
  const original = logger.error.bind(logger)
  logger.error = (...args) => {
    // 写到文件；这里能看到 "invalid plugin, expect function or object with an apply method"
    appendFileSync(LOG, args.map(describe).join(' ;; ') + '\n')
    return original(...args)
  }
  logger.__probed = true
}
```

探针必须**早于**目标行加载，所以在 patch 里插在它前面，或把它单独做成一个 bundle。
这条手段是本项目唯一一次真正定位到根因的方式——前面所有"从外面猜"的尝试都失败了。

---

## 4. 选插槽：先查 owner 怎么消费它

**插槽不是"放进什么都行"的位置。** `replaceRisk: none` 只表示**允许第三方注册**，
不代表**任何东西放进去都合理**。注册前必须读 owner 的消费方式。

### 4.1 怎么查

```
cordis_inspect_list                                    # 找到 client / Slots 提供者
cordis_inspect_query client Slots listSubTree {root: "<插槽名>"}
cordis_inspect_query client Service listService {service: "layout"}   # 点击行为
```

要读的字段：

| 字段 | 决定什么 |
|---|---|
| `kind` | `list` = 可多个；`single` = 只有一个，注册会争位 |
| `replaceRisk` | `none` 才适合第三方；`shadows-shipped-ui` 说明会顶掉官方 UI |
| `registration` | 注册选项（`id` 必填、`order`、`label`），**别猜** |
| `ownerProps` | 你的组件会收到什么 props（本项目就靠 `{ wide }` 适配折叠态） |
| `catalog.description` | owner 自己的说明，常常直接点破语义 |
| `occupants` | 现在有谁占着，可当参照 |

### 4.2 本项目踩的坑：`sidebar.panellist` 是面板选择器，不是图标位

我最初注册了两个座位，以为"两个都试试，用户看了再取舍"：

```js
slots.inject('sidebar.footer.action', ...)   // ✅ 底部按钮，能点
slots.inject('sidebar.panellist', ...)       // ❌ 渲染出来了，点了没反应
```

`sidebar.panellist` 的标题看着很合适（它的行紧挨着「插件」），但它的行是**面板选择器**：
owner 为每个**已注册的 main 面板**渲染一行，点击时调用 `layout.selectPanel(id)`。查契约：

```
selectPanel(panelId: MainPanelId | null): void
  Select a global central panel without changing the current Session.
  throws: if the selected main key is not registered; preserves the current selection.
```

我的 id 背后没有面板 → **得到一个看得见、点不动的行**。这比没有入口更糟，因为它看起来可用。

**两种正确做法**：

1. 只注册动作型插槽（`sidebar.footer.action`），点击打开外部页面 ← 本项目选的
2. 想做真面板，就要**同时**注册一个 `main` 面板页，再在 `sidebar.panellist` 提供图标

### 4.3 本项目实际用的座位

```js
slots.inject('sidebar.footer.action', () =>
  slots.register(
    { name: 'sidebar.footer.action', id: 'market', order: 10, label: '内部插件市场' },
    MarketFooterAction,
  ),
)
```

- `replaceRisk: none`，`kind: list`，`ownerProps: { wide: boolean }`
- `id` 用**自己的**新 id（文档明确：新 id 会被加到已有条目旁边；复用官方 id 会**替换**它）
- `wide: false` 表示侧边栏折叠成 56px 窄条 → 组件应渲染成图标

---

## 5. 客户端半边的写法

**不需要构建链。** 客户端产物就是一个普通的经典脚本，由
`dsh-client-modules` 通过 `/plugins/...` 路由下发给浏览器。官方模板
`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js`
就是手写文件。

### 5.1 骨架

```js
window.__ModuleLoader__.load({
  id: 'dsh-plugin-marketplace',        // 必须等于包名
  factory(require) {
    const React = require('react')     // React 来自浏览器模块表，不要自带
    return {
      name: 'dsh-plugin-marketplace',
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return          // 可选依赖：缺席就保持惰性
        slots.inject('sidebar.footer.action', () =>
          slots.register({ name: 'sidebar.footer.action', id: 'market', order: 10, label: '…' },
                         Component))
      },
    }
  },
})
```

### 5.2 硬性规则

| 规则 | 违反后果 |
|---|---|
| `factory` 的 `id` 必须**等于包名** | 行失败（"loaded without registering"） |
| 必须是经典脚本，不能有顶层 `import` / `export` | 加载失败 |
| 只 `require` 平台 seed 里的东西（`react`、`react-dom` 等） | 运行期抛错 |
| **不要** `require('@deepseek-ai/dsh-client-ui-primitives')` 等 Harness 客户端包 | 官方明确禁止；对方一变就崩 |
| 颜色只用主题 token（`--dsw-alias-*` / `--dsw-specific-*`） | 深浅色主题下不可读 |
| 不要在自己的组件之外写 DOM，不要往 `document.body` 追加 | 见 §6 |
| 资源注册放进 `apply`，用 `ctx.effect` / `ctx.on` 收尾 | 卸载后残留 |

### 5.3 可用的全局（官方 `Builtin` 提供者）

```
ctx     受限 Cordis Context：ctx.get / ctx.on / ctx.provide / ctx.effect
React   React 运行时（无 JSX 转换，用 React.createElement）
host    本包 Client → Host 的私有 JSON RPC：host.call(method, args)
styles  styles.insert(css) —— 包自有样式表，随 Client 运行清理
console 带包标签的日志
```

**注意 `fetch` 不在这份列表里。** 本项目仍然用了 `fetch('/dsh-market/open')`，
因为那个路由和页面同源；这是一处**未按文档走的实现**，见 §8「已知不确定」。

### 5.4 拿宿主才知道的信息

客户端半边不知道 webServer 绑的端口，所以由宿主提供：

```js
// 宿主 lib/plugin.js
['prefix', `${PREFIX}/open`, (req, res) => {
  json(res, 200, { ok: true, url: marketUrlRef.current }, req)
}]
```

```js
// 客户端
fetch('/dsh-market/open', { headers: { accept: 'application/json' } })
  .then(r => r.json())
  .then(body => { if (typeof body?.url === 'string') marketUrl = body.url })
```

**为什么一定要绝对 URL**：壳的 origin 是 `dsh-app://app`，相对 href 会变成**同窗口导航**，
走 Electron 的 `will-navigate`，**整个 SPA 被替换掉**，用户没有返回路径。
用 `window.open(url, '_blank', 'noopener,noreferrer')` 让主窗口的 `setWindowOpenHandler`
把它交给操作系统。

---

## 6. 不要做的事（官方明确禁止，我也都犯过）

| 禁止 | 为什么 | 我当时的做法 |
|---|---|---|
| 读别的插件的 DOM / 样式表来推算位置 | 类名是构建期哈希的，布局会变 | 靠文本找「工作区」再算坐标 |
| 在自己的组件之外写 DOM / 往 `document.body` 追加 | 绕过插槽的所有权与清理 | 注入一个 `<a>` 元素 |
| 自己实现 `preview.html`、模拟壳、截图脚本 | 模拟页面的截图**不是**运行插件的验证 | 建了 `serve-local.mjs` + 一堆 `shoot-*.mjs` |
| 选一个"没有分配空间"的位置硬塞 | owner 会重排，你会压到别人 | 塞进侧边栏行与行之间（那里只有 18px） |
| 页面里嵌 iframe 来渲染宿主页面 | iframe 拿不到主题 token / 深色模式 / locale | — |

**「模拟壳」这条路为什么必然失败**（我在这上面耗了最多轮次）：

- 侧边栏**折叠**时，「工作区」那几个字**根本不在 DOM 里**（实测侧栏宽 56px，无该节点），
  靠文本找锚点的方案直接失效；
- 真实的行是**带子元素的容器**，而"叶子文本节点"判据恰好把要测的行全排除；
- 类名是构建期哈希的；
- React 重渲染会移动目标，任何测量都只是快照；
- **最要命的**：每一轮都要一个模仿壳的夹具，而**夹具从来不完全等于壳**——
  我有两次"失败"其实是夹具或检查本身的产物，不是页面的问题。

**正确做法是选一个已经分配好空间的插槽**，让 owner 负责布局。这样折叠态、主题、
locale 全都自动正确。

---

## 7. 本项目的最终实现

### 7.1 文件与职责

| 文件 | 职责 |
|---|---|
| `lib/bundle.js` | 裸包名入口，导出 `apply`（§2.3，**不是** `export {}`） |
| `lib/plugin.js` | 宿主半边：路由、安装落盘、`/dsh-market/open` 提供市场 URL |
| `lib/client.js` | 客户端半边：注册 `sidebar.footer.action` |
| `cordis.patch.yml` | 两条行：宿主子路径 + 裸包名 |
| `package.json` | `dsh.client` + `./client` 导出 |

### 7.2 组件要点

```js
function MarketFooterAction(props) {
  // wide === false 表示侧边栏是 56px 窄条 → 只渲染图标
  return React.createElement(MarketButton, { wide: props?.wide !== false, size: 18 })
}
```

样式全部用 token，深浅色自动适配，不需要 media query：

```js
background: hover ? 'var(--dsw-alias-bg-layer-1)' : 'transparent',
color: 'var(--dsw-alias-label-primary)',
```

尺寸对齐宿主侧边栏行：`height: 36`、`borderRadius: 8`、`gap: 8`。

### 7.3 验证（这三层缺一不可）

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

# ① 宿主契约：入口是合法插件、路由注册齐全
& $node tools\test-host.mjs

# ② 安装与客户端契约：dsh.client、./client、factory id、bare-name 行、bundle 导出 apply、
#    不得注册无面板的 sidebar.panellist、只使用主题 token
& $node tools\verify-install.mjs "$env:USERPROFILE\.dsh\profiles\desktop"

# ③ 端到端：按钮**真的渲染**（需要 DSH 实例在跑 + 浏览器控制）
& $node tools\verify-native-entry.mjs 'http://127.0.0.1:3080/' 9420 "<token>"
```

**为什么三层都要**：

- 安装成功 / 行 active / bundle 被组装，**都不等于用户能看到它**；
- 而"bundle 被组装"本身也可能骗人——本项目就出现过
  `fiber=present` 加首页 boot wire 里有 URL，但插槽注册实际是死的（`panellist` 那次）。

### 7.4 三层验证各自的判据

| 层 | 看什么 | 为什么会骗人 |
|---|---|---|
| 宿主 | `stderr` 无 `did not activate`；两行 `fiber=present` | 行 active 只说明宿主模块被接受 |
| 客户端组装 | 首页 HTML 里 boot wire 含你的包 | 组装了不等于渲染了 |
| 渲染 | 页面上真的有那个按钮，且无异常 | ← 唯一可信的一层 |

首页 boot wire 长这样（`payload` 是 JSON 里的一段）：

```json
{"id":"dsh-plugin-marketplace",
 "url":"plugins/??dsh-plugin-marketplace/client.js&rev=0825c5c9136e",
 "inject":["@deepseek-ai/dsh-client-ui-sidebar"],
 "immediately":true}
```

注意 URL 是**相对**的（`plugins/...`，没有前导斜杠）。我按 `/plugins/...` 去请求得到 404，
一度误判"bundle 没产出"——**请求没命中不等于没产出**。

---

## 8. 已知不确定 / 未验证

诚实记下来，免得以后有人（包括我）把推断当成结论：

1. **客户端用 `fetch` 未经文档背书。** §5.3 列的可用全局里没有 `fetch`。
   本项目用它请求同源的 `/dsh-market/open`，实测工作。若未来受限，应改用
   `host.call()`（客户端 → 宿主私有 RPC）。
2. **`host.call` 的宿主侧注册方式未查明。** 官方文档只给出客户端签名，
   没有 Host 端如何声明可被调用的方法。本项目因此绕开了它。
3. **`sidebar.panellist` 的真面板做法未实做。** §4.2 的路线 2（注册 `main` 面板）是
   从 `layout.selectPanel` 契约推断的，没有落地验证过。
4. **`dsh.client.inject` 的完整语义未验证。** 文档只说它"只用于排序激活"。
   本项目加了 `@deepseek-ai/dsh-client-ui-sidebar`，但**未能证明**它是否必要——
   加之前和加之后都失败，失败根因是 §2.3。它可能仍然是必需的，只是被更大的问题掩盖了。
5. **loader 日志的落盘位置未找到。** 所以 §3.1 的探针是唯一可行手段，
   而不是"去看某个日志文件"。

---

## 9. 最小检查清单

加一个 UI 入口时按这个顺序做：

- [ ] 查 `Slots.listSubTree`，选一个 `replaceRisk: none`、**已经分配空间**的动作型插槽
- [ ] 读它的 `registration`（别猜字段）与 `ownerProps`（决定折叠态怎么渲染）
- [ ] 如果是 `panellist` 这类选择器插槽，确认你**同时**注册了对应的面板
- [ ] `package.json`：`dsh.client` + `exports["./client"]` + `inject` 指向声明方
- [ ] `cordis.patch.yml`：两条行，客户端那条用**裸包名**
- [ ] `lib/bundle.js`：**导出 `apply`**（不是 `export {}`）
- [ ] `lib/client.js`：`window.__ModuleLoader__.load({ id: 包名, factory })`，经典脚本
- [ ] 颜色只用主题 token；不 require Harness 客户端包；不在组件外写 DOM
- [ ] 跑 §7.3 三层验证，**最后一层必须在真实页面上看到它**
- [ ] 加一条预检断言，防止这次的错误再次出现

---

## 10. 参考来源

DSH 自带的官方技能文档与模板（在 Desktop 里位于 `app.asar` 内，
只有宿主进程自己的文件读取能打开；shell 的 `ls`/`cat`/`rg`/`node` 都打不开它）：

```
@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/
├── SKILL.md                       总体流程、知识来源优先级
├── references/host-plugin.md      bundle 清单、Host 导出形式、Config
├── references/ui-plugin.md        ★ 客户端半边：清单、模块加载器、插槽注册
├── references/practices.md        ★ 扩展点选择、UI 规则、主题 token
├── references/verification.md     ★ 没有浏览器控制时的验证边界
├── references/mcp-bundle.md
├── references/user-actions.md
└── templates/decoration/          四文件起步模板（package.json / cordis.patch.yml / index.js / client.js）
```

运行时权威（比文档更可信，因为是活的）：

```
cordis_inspect_query host   Service listService        # 宿主服务与方法签名
cordis_inspect_query client Service listService        # 客户端服务（如 layout）
cordis_inspect_query client Slots   listSubTree {root} # ★ 插槽拓扑、注册选项、ownerProps
cordis_inspect_query client Theme   listTokens         # ★ 可用的主题 token
cordis_inspect_query client Builtin listBuiltins       # 客户端半边可用的全局
cordis_inspect_query host   Config  listConfigs        # 查某个包的实际安装目录
```

**优先级**：活体 inspection > 包 README > 已安装包的 `lib/` 与 `lib/types/*.d.ts`。
文档与实测冲突时，以实测为准——但也别急着下结论：本项目的 `fetch` 就是"实测能用、
文档没写"的一处，已记在 §8。
