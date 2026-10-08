# dsh-plugin-marketplace

DSH 内部插件市场，由**两部分**组成：

| 部分 | 位置 | 职责 | 权威 |
|---|---|---|---|
| **市场服务端** | `server/` | 账号 / 组 / 规则 / 会话 / 设备码 / 插件目录 / 制品存储 / 审计 | **是** |
| **本机插件** | `lib/` + `web/` | 把服务端**已授权**的插件装进当前 DSH profile | 否 |

> **为什么必须拆**：账号和权限如果放在本机，就是每台机器一份 `~/.dsh/market/data/market.json`。
> 那样管理员建的号别人登不上、改的规则只对自己生效、审计散在各人机器上——
> "管理员手动添加用户"这个需求根本无法成立。所以权威在服务端，本机只负责落盘。

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

然后访问 `http://127.0.0.1:<DSH 端口>/market`。

### 1.2 它做什么、不做什么

| 做 | 不做 |
|---|---|
| 向服务端要目录、要判定、要字节 | **不做任何授权判断** |
| 本地再校验一遍 sha256 | 不保存账号、组、规则 |
| 解包并写入本机 profile | 不保存插件目录 |
| 写 `dsh.profile.bundles` 或 profile patch 层 | 不执行安装脚本 |

本机接口：

```
GET  /market                    市场页面（自行调用服务端）
GET  /dsh-market/config         告诉页面服务端在哪
GET  /dsh-market/installed      本机已装（从 profile 自己的文件推断）
POST /dsh-market/install        { token, name, version, sha256 } → 下载 → 校验 → 解包 → 注册
POST /dsh-market/uninstall      { name } → 删文件 + 摘注册
```

### 1.3 安装时的四道关

1. **服务端鉴权** —— `download` 会再判一次，无权限直接 403，一个字节都不发。
2. **哈希校验** —— 本机把下载字节重新哈希，与**调用方手里的**和**响应头里的** sha256 都比一遍。
3. **归档安全** —— 只接受常规文件与目录；拒绝软/硬链接、设备文件；任何逃逸出暂存目录的路径直接拒绝。
4. **按归档自称注册** —— 注册方式取自归档内的 `package.json`（是否声明 `dsh.bundle`），不取调用方的说法。

### 1.4 注册规则（踩过的坑）

`dsh.profile.bundles` 里**只能放组合包**（每个都必须声明 `dsh.bundle`）。往里塞普通插件会让
profile 加载失败。而只把文件复制进 `node_modules` 什么都不会挂载——DSH 只加载 patch 层插入的东西。所以：

- 声明了 `dsh.bundle` → 记入 `dsh.profile.bundles`
- 普通插件 → 在 profile 的 `cordis.patch.yml` 里加一条 insert 行，并补一条 `file:` 依赖

托管行包在标记块里：

```
# >>> dsh-plugin-marketplace managed rows (do not edit inside) >>>
- insert:
    - id: 'market-dsh-internal-dsh-plugin-calc'
      name: '@dsh-internal/dsh-plugin-calc/plugin'
# <<< dsh-plugin-marketplace managed rows <<<
```

**运维人员自己的内容只当文本处理，卸载后逐字节还原**（测试里有断言）。

### 1.5 联调测试（真实浏览器 + 真实服务端 + 真实 profile）

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
& $edge --headless=new --remote-debugging-port=9350 --user-data-dir="$env:TEMP\edge-integ" about:blank
& $node tools\test-integration.mjs 9350
```

断言的是**最终效果**：点完安装后，那个临时 profile 的 `package.json` 里真的有依赖、
`cordis.patch.yml` 里真的有托管行、磁盘上真的有插件文件；点卸载后全部干净退回。

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

- **应用内没有可见入口**：市场页要在浏览器打开 `http://127.0.0.1:<DSH 端口>/market`。
  壳页面注入（`tapIndex`、`index-inject` 行）在 Electron 桌面壳下不生效，见 §4.1。
- 发布只能通过服务端 CLI（`publish`），页面里没有上传入口。
- 已装状态来自本机 profile 文件，不是服务端上报的清单。

## 4. 排错

### 4.1 为什么壳页面注入在 Electron 下无效

`@deepseek-ai/dsh-host-webserver` 的注释是决定性的：

> *"It knows no harness concepts and serves no files; the composing application owns dist
> serving. **Electron uses file:// plus IPC instead**, and this package never prints the URL."*

`register`（路由）对 Electron 有效，但 **index 管线**（`tapIndex` / `webserver/index-inject` 行，
两者都由 `renderIndex` → `applyIndexTaps` 消费）只作用于 HTTP 提供的 index.html。

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
