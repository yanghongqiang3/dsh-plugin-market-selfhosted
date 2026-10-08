# dsh-plugin-marketplace

DSH 内部插件市场，由**两部分**组成：

| 部分 | 位置 | 职责 | 权威 |
|---|---|---|---|
| **市场服务端** | `server/` | 账号 / 组 / 规则 / 会话 / 设备码 / 插件目录 / 制品存储 / 审计 | **是** |
| **本机插件** | `lib/` + `web/` | 把服务端**已授权**的插件装进当前 DSH profile | 否 |

> **为什么必须拆**：账号和权限如果放在本机，就是每台机器一份 `~/.dsh/market/data/market.json`。
> 那样管理员建的号别人登不上、改的规则只对自己生效、审计散在各人机器上——
> "管理员手动添加用户"这个需求根本无法成立。所以权威在服务端，本机只负责落盘。

**应用内入口（原生）**：DSH 左侧栏底部的「内部插件市场」按钮，注册在官方插槽
`sidebar.footer.action`（设置按钮旁边）。点击**在系统浏览器中打开** `/market`，DSH 主界面不受影响。
也可以直接在浏览器访问 `http://127.0.0.1:<DSH 端口>/market`。

它是**真正的客户端插件**（`lib/client.js` + `package.json` 的 `dsh.client`），不是注入的 DOM，
所以侧边栏折叠成 56px 时会自动变成图标、跟随主题 token——这些注入方案都做不到。

> **只注册一个座位，这是有意的。** `sidebar.panellist` 看起来更"原生"（它的行紧挨着「插件」），
> 但那是一组**面板选择器**：owner 为每个已注册的主面板渲染一行，点击时调用
> `layout.selectPanel(id)`，而**没有面板的 id 会抛错**。只注册图标不注册面板，就会得到一个
> 看得见、点不动的行——比没有入口更糟。`verify-install.mjs` 现在会拦住这种写法。

---

## 0. 市场服务端

零运行时依赖：HTTP 用 `node:http`，数据库用 Node 内置的 `node:sqlite`。
**要求 Node ≥ 22.5。**

### 0.1 一键启动（Windows）

```powershell
.\start-market.bat
```

默认监听 `127.0.0.1:8787`，**数据放项目内的 `.market\`**（数据库 + 制品）。
该目录已在 `.gitignore` 里，不会进版本库，也不会跟着发布包走。
首次运行自动建库并打印初始管理员 `admin` / `dsh-admin`。

| 参数 | 作用 |
|---|---|
| `--port 9000` | 换端口 |
| `--host 0.0.0.0` | 允许内网其他机器访问（同时设置 `MARKET_CALLBACK_HOST`） |
| `--data D:\data` | 换数据目录 |
| `--check` | 只做环境检查后退出，不启动服务 |

脚本先找系统 PATH 里的 `node`，版本不够再回退到 DSH 自带运行时，并在启动前校验
Node 版本与当前目录，避免"启动了但其实跑不起来"。

### 0.2 手动启动（Linux / macOS / 服务器）

```bash
node server/cli.mjs bootstrap        # 只跑一次
MARKET_PORT=8787 node server/index.mjs
```

环境变量：`MARKET_HOST`（默认 `127.0.0.1`）、`MARKET_PORT`（8787）、`MARKET_DATA_DIR`（`.market`）、
`MARKET_DB`、`MARKET_STORAGE`、`MARKET_CALLBACK_HOST`、`MARKET_MAX_UPLOAD_BYTES`（默认 64 MB）。

### 0.3 发布插件：不需要服务器 shell 权限

**方式一：上传（推荐，CI 也能用）**

```bash
# 1) 用你的市场账号登录；令牌存到 ~/.dsh/market-token.json（权限 0600）
node server/cli.mjs login --username alice --service http://10.0.0.5:8787

# 2) 先预检：服务端只解析、不写入，告诉你它将会发布什么
node server/cli.mjs publish --dir ./my-plugin --dry-run

# 3) 确认无误后正式发布
node server/cli.mjs publish --dir ./my-plugin
node server/cli.mjs publish --dir ./my-plugin --state draft    # 先发草稿
node server/cli.mjs whoami                                     # 看当前身份
node server/cli.mjs logout                                     # 清除本地令牌
```

发布走 `POST /dsh-market/publish`，默认 **dry run**，加 `?commit=1` 才写入。
归档在写盘**之前**就被检查：非法 gzip、缺 `package.json`、非法 JSON、路径逃逸（`../`）、
绝对路径、符号链接条目、未知状态——全部拒绝并记审计。上传上限见 `MARKET_MAX_UPLOAD_BYTES`。

**方式二：直接写本机数据库**（需要能访问服务器的文件系统）

```bash
node server/cli.mjs publish --dir ./my-plugin
```

没给 `--service` 且本地没有令牌时走这条路。

### 0.4 本机运维命令

```powershell
& $node server\cli.mjs bootstrap
& $node server\cli.mjs group:add  --id billing --description "计费组"
& $node server\cli.mjs user:add   --username alice --password <初始密码> --groups billing [--admin]
& $node server\cli.mjs grant:add  --group billing --pattern "@dsh-internal/*" [--deny]
& $node server\cli.mjs grant:rm   --group billing --pattern "@dsh-internal/*"
& $node server\cli.mjs member:add --user alice --group billing
& $node server\cli.mjs user:list | catalog | audit [--limit 50] | prune
& $node server\cli.mjs user:pass   --username alice --password <新密码> --no-must-change
& $node server\cli.mjs user:status --username alice --status disabled
```

### 0.5 插件包要准备什么

`package.json` 必需（要有 `name` 与 `version`）。可选一个 `market.json`：

```json
{ "summary": "计费插件", "owner": "billing", "channel": "stable",
  "dsh": ">=0.2.0-rc.2 <0.3", "permissions": ["tools"], "state": "published" }
```

`state` 可以是 `draft` / `review` / `published` / `revoked`；**只有 `published` 可被安装**。
缺省字段从 `package.json` 推断。

### 0.6 接口

```
GET  /dsh-market/health                     无需认证
POST /dsh-market/auth/login                 登录 → 令牌
POST /dsh-market/auth/logout
GET  /dsh-market/auth/me
POST /dsh-market/auth/password              首登必改时唯一放行的接口
POST /dsh-market/auth/device/start|poll|approve|token
GET  /dsh-market/catalog                    按调用者授权过滤，每条带 canInstall/reason
GET  /dsh-market/detail
GET  /dsh-market/download                   校验 SHA256 后才下发，响应头带 x-artifact-sha256
POST /dsh-market/authorize                  只做判定，不传字节
POST /dsh-market/publish                    上传归档；默认 dry run，?commit=1 写入（仅 admin）
GET  /dsh-market/admin/users|groups|artifacts
POST /dsh-market/admin/users|password|status|role|groups|membership|grants|artifacts/state
```

### 0.7 三条不可动摇的规则

1. **默认拒绝** —— 没有任何规则授予就不能装（连管理员也一样，`E_NO_GROUP`）。
2. **deny 优先** —— 命中任一 deny 规则即拒绝，无论有多少 allow。
3. **变更即时生效** —— 停用账号会当场吊销其全部会话，旧令牌下一个请求就是 401。

### 0.8 制品的可信链条

发布时算 sha256 存库；下载时**服务端先把磁盘上的字节重新哈希一遍**，不一致就拒绝下发
（`E_HASH_MISMATCH` + 审计 `artifact.corrupt`），而不是把可疑字节发出去让客户端发现。
归档是**确定性打包**（mtime 固定为 0、条目排序），同样的目录树永远得到同样的哈希。

### 0.9 服务端测试

```powershell
& $node tools\test-server.mjs     # 57 项：引导/登录/权限/发布/下载/哈希/设备码/审计
& $node tools\test-publish.mjs    # 35 项：CLI 登录/预检/上传/畸形归档/状态流转
```

---

## 1. 本机插件（客户端）

### 1.1 配置

**必须**告诉本机插件服务端在哪，否则页面会显示"未配置市场服务端"：

```
MARKET_SERVICE_URL=http://10.0.0.5:8787
```

设为 DSH 的环境变量后重启 DSH。可选：`MARKET_SERVICE_TIMEOUT_MS`（默认 30000）、`DSH_PROFILE_DIR`。

然后重启 DSH。**左侧栏底部、设置按钮旁边会出现「内部插件市场」**，点击在系统浏览器中打开；
也可以直接访问 `http://127.0.0.1:<DSH 端口>/market`。

> 侧边栏折叠成 56px 的窄条时，入口会自动变成图标（`SidebarFooterActionOwnerProps` 的
> `wide: false`）。这是插槽给的，不需要自己判断宽度。

### 1.2 它做什么、不做什么

| 做 | 不做 |
|---|---|
| 向服务端要目录、要判定、要字节 | **不做任何授权判断** |
| 本地再校验一遍 sha256 | 不保存账号、组、规则 |
| 解包并写入本机 profile | 不保存插件目录 |
| 写 `dsh.profile.bundles` 或 profile patch 层 | 不执行安装脚本 |
| 注册客户端插槽入口（`sidebar.footer.action`） | 不注入 DOM、不测量壳的布局、不注册无面板的面板行 |

本机接口：

```
GET  /market                    市场页面（自行调用服务端）
GET  /dsh-market/config         告诉页面服务端在哪
GET  /dsh-market/installed      本机已装（从 profile 自己的文件推断）
POST /dsh-market/install        { token, name, version, sha256 } → 下载 → 校验 → 解包 → 注册
POST /dsh-market/uninstall      { name } → 删文件 + 摘注册
```

### 1.2.1 页面顶部要为空

DSH 的窗口是无边框的（`titleBarStyle: "hidden"`），Electron 把
最小化/最大化/关闭三个按钮**画在渲染内容之上**（主进程里
`titleBarOverlay: { height: 40 }`）。所以：

- 页面在顶部**保留 40px 不渲染内容**（`body { padding-top: var(--titlebar) }`），
  标题栏 `sticky` 也停在这条下面。否则本页自己的标题和右上角按钮会钻到窗口按钮底下。
- **可拖拽区（`-webkit-app-region: drag`）必须避开右上角那 ~180px**。
  我第一版让拖拽条横跨整个顶部，结果**它吞掉了关闭按钮的点击**——
  点关闭变成了收起整个 DSH 窗口。现在拖拽条止于控件区左侧，控件角显式设为 `no-drag`。
这两条由 `web/market.html` 自己实现（`body.chrome` 类 + `--titlebar` / `--window-controls`
变量），只在桌面壳里生效（检测 `globalThis.dshDesktopBoot`）；浏览器里打开时
`--titlebar: 0`，不会多出空白。

验证方式：在桌面壳里打开 `/market`，用 CDP 量 `elementFromPoint` —— 拖拽条不得占用控件角，
控件左侧仍须可拖拽，标题与右上角按钮都必须在控件条下方。

### 1.3 安装时的四道关

1. **服务端鉴权** —— `download` 会再判一次，无权限直接 403，一个字节都不发。
2. **哈希校验** —— 本机把下载字节重新哈希，与**调用方手里的**和**响应头里的** sha256 都比一遍。
3. **归档安全** —— 只接受常规文件与目录；拒绝软/硬链接、设备文件；任何逃逸出暂存目录的路径直接拒绝。
4. **按归档自称注册** —— 注册方式取自归档内的 `package.json`（是否声明 `dsh.bundle`），不取调用方的说法。

### 1.4 注册规则（踩过的坑）

两件事必须分清，我在这里错过：

**① `dsh.profile.bundles` 里放的不是"插件"，而是"哪几层 patch 要生效"。**
被列进去的唯一效果是：该包的 `dsh.bundle.patch` 被当作一层 patch 应用。
**它本身不会变成一条 loader 行**——把文件复制进 `node_modules` 也一样，什么都不挂载。
只有 patch 里 `- insert:` 出来的行才会挂载东西。

判定"是不是组合包"的依据是 **`dsh.bundle.patch` 存在**，不是 `dsh.bundle` 存在。
`dsh-app-boot` 用的就是 `dsh.bundle.patch !== void 0`，并且会为 `bundles` 里
任何缺 patch 的包抛 `declares no dsh.bundle`——**整个 profile 加载失败**。
（`lib/plugin.js` 起初写成 `Boolean(pkg.dsh.bundle)`，会踩这个坑，已改。）

**② 所以注册方式取决于包提供了什么：**

| 包提供 | 记到哪里 | 谁负责挂载 |
|---|---|---|
| `dsh.bundle.patch`（组合包） | `dsh.profile.bundles` | 它自己的 patch 层 |
| 只是普通插件 | profile 的 `cordis.patch.yml` 加一条 insert 行 + `file:` 依赖 | 那条 insert 行 |

托管行包在标记块里：

```
# >>> dsh-plugin-marketplace managed rows (do not edit inside) >>>
- insert:
    - id: 'market-dsh-internal-dsh-plugin-calc'
      name: '@dsh-internal/dsh-plugin-calc/plugin'
# <<< dsh-plugin-marketplace managed rows <<<
```

**运维人员自己的内容只当文本处理，卸载后逐字节还原**（测试里有断言）。

> 关于 `lib/bundle.js` 为什么是空的：那只是**沿用官方惯例**。我原先在注释里断言
> "组合包自己的入口做了事会被审计为失败行"——**这个说法不成立**。激活审计只问每条行的
> fiber 是否到了 `active`，而 `apply` 正常返回的行就是 active，不管它做了什么。
> 本包自己的诊断日志（`registered 6/6 routes`）就来自一条"做了事"的行。
>
> **但"行 active"不等于"客户端模块可用"。** 这是两件事：行 active 只说明宿主模块被接受了；
> 客户端半边还要 `dsh-client-modules` 组装出 bundle 并注册进插槽。踩过的坑见 §4.1.1。

### 1.5 测试

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node tools\test-host.mjs                                    # 宿主入口与路由契约
& $node tools\test-server.mjs                                  # 服务端
& $node tools\test-publish.mjs                                 # 发布/上传
& $node tools\verify-install.mjs "$env:USERPROFILE\.dsh\profiles\desktop"   # 安装与客户端契约预检
```

`verify-install.mjs` 里那组"客户端契约"断言值得单独说：它们守的是**让客户端半边能加载的
每一条硬性要求**（`dsh.client` 声明、`exports["./client"]`、factory id 等于包名、bare-name 行、
`lib/bundle.js` 导出 `apply`）。每一条都是被违反过、而且症状极不明显的那种。

端到端验证（需要浏览器控制、且需要 DSH 实例在跑）：

```powershell
& $node tools\verify-native-entry.mjs 'http://127.0.0.1:3080/' 9420 "<token>"
```

它断言原生按钮**真的渲染出来了**（而不只是被组装了），并报告页面异常。

---

## 2. 目录

```
server/                       独立市场服务端（零依赖）
├── index.mjs                 启动入口 + 首次引导
├── cli.mjs                   运维 CLI
└── lib/
    ├── db.js                 SQLite schema
    ├── crypto.js             scrypt 密码 + sha256 令牌
    ├── store.js              全部读写 + 登录锁定 + 会话吊销
    ├── policy.js             **唯一权威**判定
    ├── artifacts.js          确定性 tar.gz + sha256 + 下载校验
    └── http.js               HTTP 路由

lib/                          本机插件（客户端）
├── bundle.js                 组合包半边：**必须为空**（export {}）
├── plugin.js                 host 行：下载 → 校验 → 解包 → 注册
└── tar.js                    受限 tar 读取（拒绝符号链接与路径逃逸）
web/market.html               市场页面（自包含，无构建步骤）
cordis.patch.yml              patch 层：一行 insert 指向 plugin.js
tools/                        测试与本地夹具
```

## 3. 已知限制

- 发布只能通过 CLI（`publish`），页面里还没有上传入口。
- 已装状态来自本机 profile 文件，不是服务端上报的清单。
- 服务端是前台进程，需要靠 `start-market.bat` 手动拉起；没有做成开机自启。

## 4. 排错

### 4.1 客户端插件是怎么进到页面里的

**这是本项目最容易搞错的地方**，我在这里返工过多次，所以写清楚。

桌面壳**不通过 HTTP 提供它的 index**。Electron 的 `protocol.handle('dsh-app', …)` 是这样分派的：

```js
if (url.hostname === "shell") return serveWebDocument(request, join(app.getAppPath(), "renderer"));
if (url.hostname === "app") {
  if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname.startsWith("/assets/") …)
    return serveWebDocument(request, join(resources.dsh, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist"));
  …
  return forwardWebRequest(request, hostUrl, hostCookie);   // 只有非 index 才转发给宿主
}
```

`dsh-app://app/` 直接从磁盘读 `dsh-web-frontend/dist/index.html`。所以：

| 通道 | HTTP 壳（`dsh web`） | Electron 桌面壳 |
|---|---|---|
| `webServer.register`（路由） | ✅ | ✅（非 index 路径会转发给宿主） |
| `webServer.tapIndex`（`renderIndex` → `applyIndexTaps`） | ✅ | ❌ 从磁盘读，根本不经过 `renderIndex` |
| **`webserver/index-inject` 行** | ✅ | ✅ **唯一有效的通道** |

**我的插件不再自己往这个通道里塞东西**（早先版本塞了一个 `document.body` 入口，那套已废弃）。
现在用这个通道的是 `@deepseek-ai/dsh-client-modules`：

```js
ctx.on("webserver/index-inject", (table) => { table.push(...bootInjections(this.composed)); });
```

它把客户端 bundle 的 URL 和 `inject`/`immediately` 一起送进页面。所以**客户端插件能不能用，
取决于这个通道通不通**——这也是为什么本地没有任何 HTML 可改时它依然能工作。

Electron 下注入行的路径是 **IPC**，不是 HTML 改写：

```
dsh-desktop-host: process.send({ type:'ready', injections: ctx.webServer.collectIndexInjections() })
electron main:    ipcMain.handle(DESKTOP_IPC.boot, () => ({ injections, streamBaseUrl }))
renderer:         for (const row of injections) switch (row.kind) {
                    case 'style': head.append(<style>{row.text})
                    case 'html':  (row.placement==='head'?head:body).insertAdjacentHTML('beforeend', row.html)
                    …
                    default: throw new Error('web boot: unknown index injection row …')
                  }
```

**两个后果**：

1. 行必须注册**早于** `collectIndexInjections()`（宿主 report ready 时只收集一次）。
2. **未知的 `kind` 会让整个 web boot 抛异常**。合法 kind 只有：
   `global` / `script` / `script-src` / `script-preload` / `style` / `html`。
   两种壳接受的 kind 完全一样。

### 4.1.1 客户端半边为什么曾经一直不激活

症状只有一行、而且极具误导性：

```
dsh: warning: 1 entry did not activate
marketplace-client (dsh-plugin-marketplace): failed to import
```

**`failed to import` 只表示 `entry.fiber === undefined`**（见 dsh-app-boot 的 `inactiveEntries`），
真实原因被 loader 交给了它自己的 logger，外部看不到。用探针拦截 `ctx.loader.ctx.logger.error`
之后才拿到：

```
invalid plugin, expect function or object with an "apply" method, received object
```

原因是 `lib/bundle.js` 写成了 `export {}`——**我当时的注释还声称这是"约定"**。
而 loader 会校验每条行的模块，空命名空间直接判为非法插件 → 该行没有 fiber → 客户端模块
从未被组装 → `/plugins/??<pkg>/client.js` 一直 404 → 插槽从未注册。

**现已改为导出 `apply`。** 两条行都应 `fiber=present`，且首页 boot wire 里能看到：

```json
{"id":"dsh-plugin-marketplace","url":"plugins/??dsh-plugin-marketplace/client.js&rev=…",
 "inject":["@deepseek-ai/dsh-client-ui-sidebar"],"immediately":true}
```

`tools/test-host.mjs` 和 `tools/verify-install.mjs` 都守这条契约。

### 4.2 接口前缀为什么不能是 `/api`

`@deepseek-ai/dsh-client-connection` 把整个 `/api` 前缀作为自己的 RPC 通道占用：

```js
requestRejection(request) {
  if (!isTrustedApiRequest(request, this.trustedHosts)) return 403
  return this.browserAuth.isAuthenticated(request) ? undefined : 401
}
```

普通 `fetch` 不带这套浏览器认证状态，于是 `/api/*` 会在**任何自有路由执行之前**回
`401`，响应体是纯文本 `unauthorized`、没有 content-type。

**自检特征**：连一个不存在的路径也回同样的 401，就说明拒绝来自连接层；
自己的鉴权一定返回 JSON 错误体。所以市场接口挂在 **`/dsh-market/*`**。

### 4.3 YAML 里 `@` 开头的值必须加引号

`id: @foo` 会让 YAML 解析失败（`bad indentation of a mapping entry`）。生成的托管行一律单引号包裹。

### 4.4 服务端连不上

页面会显示"未配置市场服务端"（没设 `MARKET_SERVICE_URL`）或
`E_SERVICE_UNREACHABLE` / `E_SERVICE_TIMEOUT`（设了但连不上）。
本机诊断日志：`~/.dsh/plugin-marketplace-diag.log`。

## 5. 回滚

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
# 1) 删掉本机插件的注册与文件（在市场页对每个已装项点「卸载」，或手工：）
#    - 从 profile package.json 的 dsh.profile.bundles / dependencies 移除 dsh-plugin-marketplace
#    - 从 cordis.patch.yml 移除托管块
#    - 删除 node_modules/dsh-plugin-marketplace
# 2) 重启 DSH
```
