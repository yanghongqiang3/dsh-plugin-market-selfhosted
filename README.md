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

**身份绑定（可选，手动）**：DSH 账号与市场账号可以**一对一**绑定。安装页登录后显示本机
DSH 账号是谁，用户**点按钮**才绑定。

> **为什么不自动绑。** 第一版在登录时自动绑定，但那会在用户不知情的情况下占用一个
> **稀缺名额**（一对一）：登错市场账号就悄悄消耗掉一次绑定，而且只有管理员能释放。
> 现在改为显式点击，并且按钮会**先查再用**——被占用时直接显示「已被占用」，
> 而不是让用户点完才失败。
>
> 绑定是**一对一**的：一个 DSH 账号只能绑一个市场账号，反之亦然，由数据库双向唯一约束强制。
> 做法与坑见 §1.6。

---

## 0. 市场服务端

零运行时依赖：HTTP 用 `node:http`，数据库用 Node 内置的 `node:sqlite`。
**要求 Node ≥ 22.5。**

### 0.0 两个界面，两件事

这个项目有**两个互不重叠的界面**，因为它们是两种不同的工作：

| 界面 | 地址 | 谁用 | 能做什么 |
|---|---|---|---|
| **DSH 客户端入口** | DSH 左侧栏底部按钮 → `http://127.0.0.1:<DSH 端口>/market` | 普通用户 | **只看自己的目录 + 安装 / 卸载**。没有权限管理、没有发布 |
| **服务端控制台** | `http://<服务端>:8787/console`（直接开浏览器，**不经过 DSH**） | 管理员 | 账号（含 DSH 绑定）、权限组、插件规则、**发布插件**、制品状态 |

为什么分开：

- 以前是一个页面加一个「权限管理」标签。结果**每个用户都能看到一个自己点不动的管理页**，
  而管理员要做策略配置时得先穿过一个插件目录。
- 权限判定**从来**都在服务端（客户端页面改不了任何东西），所以把管理面独立成一个 URL
  既不降低安全性，也不需要 DSH 在场。控制台不读 DSH 的任何东西——没有 host 插件、
  没有本地 profile、没有壳，浏览器 + 地址就能用。
- `tools/verify-install.mjs` 现在会**双向**检查这条边界：安装页不得调用任何 admin / publish
  路由，控制台不得调用任何 install / uninstall 路由。

两个界面共用 `web/shared.js`（令牌、请求、登录/改密/登出）与 `web/market.css`
（配色与深浅色）。共用部分只有一份，所以不会各自腐烂；各自的页面只声明自己的视图与流程。

#### 控制台的列表与表单

管理列表都走**服务端分页**（`limit`/`offset`）并带搜索框，四个列表（账号 / 权限组 / 规则 /
制品）用同一套响应形状：

```
{ ok, entries, total, limit, offset }     // 旧字段名（users/groups/grants/artifacts）同时保留
```

`offset` 超出范围返回**空页而不是错误**（列表可能在打开期间变短），`limit` 钳到 200，
非法值退回默认 20。

**新增与修改都在弹窗里**（`shared.js` 的 `openForm`）。原来的做法是把新建表单常驻在表格旁边，
表格因此只剩半页宽；现在那一列还给了数据。破坏性操作走 `openConfirm`，不用浏览器的 `confirm()`。

**DSH 绑定显示在账号行里**，不再是一个独立标签页：绑定是账号的属性，管理员看到「alice」
这一行时就该知道它绑了哪个 DSH 账号，不必去另一页按用户名比对。未绑定的行显示 `—`。

> 表格在修好之前**完全没有样式**：`trow()` 生成的类名是 `.tr`，而 `market.css` 里写的是
> `.trow`，两边对不上，所以没有 flex、没有行分隔线、没有省略号。两个界面都受影响。
> 预检现在会断言 `.tr` 规则存在、`.trow` 不残留。

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

#### 发布表单里为什么没有「权限组」

这个问题被问过，所以把理由写下来：**发布和授权是两个不同的问题，发布不授予任何访问。**

实测（`tools/probe-grant-flow.mjs`）：

| 步骤 | 结果 |
|---|---|
| 发布制品，不指定任何组 | 制品进入市场 |
| 没有任何规则的成员看 catalog | **看得到**该条目，但 `canInstall: false`，原因 `E_NO_GROUP` |
| 给组加一条 **glob** 规则 `@dsh-internal/dsh-plugin-*` | `status 200` |
| 把成员加进该组 | 该插件**立刻** `canInstall: true` |

关键在于**规则是模式，不是「这个插件 → 这个组」的映射**：

- 加 `@dsh-internal/dsh-plugin-*` 一条规则，之后发布的**所有**匹配插件**自动**对相关人可用；
- 没人需要回头为每个新插件再点一次授权；
- 所以发布表单里选组是多余的——选或不选，结果一样，纯属误导。

反过来，把组塞进发布表单还有实际害处：

- 它把「**这个制品可以进市场吗**」（可信/审查问题，发布者关心）
  和「**谁能装它**」（授权问题，组管理员关心）**混成一个动作**；
- 它诱导人以为「不在这里选组 = 没人能用」，于是去逐个插件选组，
  这恰好绕开了 glob 规则这个更强的机制。

`catalog` 故意**列出装不了的插件并给出原因**：这样能回答「同事有、我为什么看不到」，
比藏起来好排查。被策略把关的是**安装**，不是可见性。

**想让某个组能用某个插件**：控制台「组 → 插件规则」加一条匹配的规则即可，
那才是这件事该在的地方。

#### 更新一个插件

**没有单独的 update 接口。更新 = 再装一次更高的版本。**

装 1.0.0 的人要升到 2.0.0，就是重新 `POST /dsh-market/install`（客户端上就是再点一次按钮）。
页面里那个「更新到 X」按钮的判据只有一条：**catalog 报的版本 ≠ 本机已装版本**。

实测（`tools/probe-update-flow.mjs`，16 项，驱动真正的 install 路由并检查落盘文件）：

| 行为 | 结果 |
|---|---|
| 装 1.0.0 | ✅ 文件到位 |
| 发布 2.0.0 后 catalog 报 2.0.0 | ✅ 与本机 1.0.0 不同 → 页面出现更新按钮 |
| 更新到 2.0.0 | ✅ |
| 1.0.0 独有的 `lib/only-in-v1.js` | ✅ **没有残留**（整目录替换，不是叠加） |
| 代理行数量 | ✅ 仍是一条，没有重复行 |
| 重复装同一版本 | ✅ 幂等 |
| 按版本号装回 1.0.0 | ✅ 文件也回去了 |

更新是**整目录替换**（`installEntry` 先删目标目录再展开），所以新版本删掉的文件不会残留——
这点很重要，否则磁盘上的包会和发布出去的不一致。装完返回 `needRestart: true`，**要重启 DSH**。

#### 版本选择：一次真实缺陷的修复

「最新版本」原来取的是 **`ORDER BY published_at DESC`（最近发布的）**，不是**版本最高的**。
这两者不等价，而且差别是**把降级当成升级**：

按 2.0.0 → 1.5.0 → 1.0.0 的顺序发布（从旧分支发一个热修就是这样）时，实测结果是

```
catalog 报 1.0.0
装着 2.0.0 的客户端被提示「更新到 1.0.0」
不带版本号的下载拿到 1.0.0
```

同一个表达式里还有第二个缺陷：它**完全不管 `state`**，所以一个被 `revoked` 的最新版本
仍被报成"最新"。`policy` 会拒绝它（`E_REVOKED`）——但那是在用户已经看到一个
**点了必然失败**的按钮之后。

现在两处都修了（`server/lib/artifacts.js`）：

- 版本比较按 semver 规则在 JS 里做（SQLite 排不了语义版本：`ORDER BY version DESC` 会把
  1.9.0 排在 1.10.0 上面）；
- 只有 `state = 'published'` 的版本参与"最新"的选举，所以撤回一个版本会**回落到上一个可用版本**；
- 非 semver 的版本号在**发布时**就被拒绝，而不是让它在排序里产生未定义行为。

19 项断言覆盖这些规则，含 `1.10.0 > 1.9.0`、`1.0.0 > 1.0.0-rc.1`、`rc.10 > rc.9`、
`alpha < alpha.1 < beta < rc < 正式`、构建元数据不参与排序。

### 0.4 插件自己的自动更新

**客户端启动时向服务端问一句「你带的包是哪个版本」，不同就换上，下次启动生效。**

#### 发布新版本只有两步

```powershell
# ① 开发机 —— 先改版本号，再打包
#    package.json  "version": "0.1.0"  ->  "0.1.1"
node tools\pack-dist.mjs
#   -> dist\dsh-plugin-marketplace-0.1.1.tgz

# ② 服务器 —— 把包放上去（一条命令，不用重启服务端）
$env:MARKET_DATA_DIR = '<服务端的数据目录>'      # 与 start-market.bat 用的一致
node server\cli.mjs publish:self --archive dist\dsh-plugin-marketplace-0.1.1.tgz
```

之后每台客户端**下次启动 DSH 时自动跟上**，不再需要分发 tgz、也不再需要手工 `dsh plugin add`。

**版本号必须先改。** pnpm 按「路径 + 版本号」判定，只重打同版本的包再装，文件根本不会变
（§0.3 末尾有实测）。

**不要手动往 `artifacts\self` 拷文件。** 那个目录由 `publish:self` 自己写，而且要写两样：

```
artifacts\self\marketplace.tgz      包的字节
artifacts\self\marketplace.json     版本 + sha256
```

**只放 tgz 是没用的** —— 服务端回答 `/dsh-market/self` 时读的是那个描述文件，
没有它等于「没放包」，客户端只会记一条 `skipped`。

**服务端不用重启。** 实测：放包前后各问一次 `/dsh-market/self`，未重启服务端版本就变了
（`0.1.0` → `0.3.0`）。它每次请求都重新读盘并校验哈希。

服务器上没有这个仓库时，用 `publish:self --dir .`：它按 npm 布局自己打包，**不需要 `tools/`**。

#### 为什么放在服务端

两件事逼出了这个设计：

1. **市场没法分发它自己。** 市场存的是扁平归档，而可安装的 npm tarball 必须把所有条目放在
   `package/` 下 —— 否则 pnpm 会把 `lib/plugin.js` 装成 `plugin.js`（§7 有实测）。
   而且「用市场装市场」本身就是循环。
2. **服务端和插件是一起部署的。** 谁更新服务端，手上就有新构建。所以服务端是那个包
   最自然的存放处，不需要再维护第二条分发通道。

接口是两条，都不需要认证：`GET /dsh-market/self` 报版本与 sha256，
`GET /dsh-market/self/download` 给字节。它们**不在 catalog 里**，也不受 `policy` 管辖——
这不是市场数据，而是「正在跟这个服务端说话的那个客户端」。

#### 硬约束：必须重启才生效

**运行中的插件无法替换自己已加载的代码。** 实测（`tools/probe-swap-mechanics.mjs`）：
覆盖一个已加载的 `.js` 在这台机器上**会成功**，但进程仍然从内存里执行**旧代码**。
所以自动更新只能做到「把新版本准备好」，生效要等下次启动。

**做不到「装完立刻生效」**——那需要重启 DSH，而那不是插件能做的事。

#### 链接安装一律拒绝

`node_modules/dsh-plugin-marketplace` 经常是个**链接**：pnpm 的布局，以及开发时把
profile 指向工作树。**往这种路径里写会写穿到真实源码。** 实测
`lstat().isSymbolicLink()` 为真、`readlink()` 给出目标。

所以检测到链接就**拒绝自动更新**，只在诊断日志里记一条 `refused`。这是有意的：
自动更新绝不能悄悄改掉某人的工作树。

#### 换版怎么做的（不破坏现场）

```
下载 → 校验 sha256（与 /self 报的一致 + 响应头一致）
     → 解到 <target>.staging，验证里面的 package.json 就是它声称的版本
     → rename(target -> .previous)，rename(.staging -> target)
     → 删掉 .previous
```

**先把新树完整准备好，再动物料**：下载中断或校验失败时，运行中的安装**一个字节都没变**。
两次 rename 之间失败会把 `.previous` 挪回去。

#### 失败一律不致命

| 情况 | 行为 |
|---|---|
| 服务端没放包 | `skipped`，继续跑现有的 |
| 版本相同或服务端更旧 | `current`，什么都不做 |
| 是链接安装 | `refused`，不动 |
| 下载失败 / sha 不符 / 解包失败 | `failed`，运行中的安装保持不变 |

全部记进诊断日志（`.dsh\plugin-marketplace-diag.log` 的 `[self-update]` 行）。
关掉自动更新：环境变量 `MARKET_AUTO_UPDATE=0`。

> **「发布」这一步无法自动化**：总得有人把新包放到服务器上。所以这是
> 「一次发布，客户端自动跟上」，不是无人值守。

### 0.5 本机运维命令

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

### 0.6 插件包要准备什么

`package.json` 必需（要有 `name` 与 `version`）。可选一个 `market.json`：

```json
{ "summary": "计费插件", "owner": "billing", "channel": "stable",
  "dsh": ">=0.2.0-rc.2 <0.3", "permissions": ["tools"], "state": "published" }
```

`state` 可以是 `draft` / `review` / `published` / `revoked`；**只有 `published` 可被安装**。
缺省字段从 `package.json` 推断。

### 0.7 接口

```
GET  /dsh-market/health                     无需认证
POST /dsh-market/auth/login                 登录 → 令牌
POST /dsh-market/auth/logout
GET  /dsh-market/auth/me
POST /dsh-market/auth/password              首登必改时唯一放行的接口
GET  /dsh-market/catalog                    按调用者授权过滤，每条带 canInstall/reason
GET  /dsh-market/detail
GET  /dsh-market/download                   校验 SHA256 后才下发，响应头带 x-artifact-sha256
POST /dsh-market/authorize                  只做判定，不传字节
POST /dsh-market/identity/bind              把令牌所属的市场账号与 DSH 账号绑定（一对一）
GET  /dsh-market/identity/me                看自己的绑定
POST /dsh-market/identity/unbind            解除自己的绑定（不需要管理员）
GET  /dsh-market/identity/lookup            未登录；只回答某个 DSH 账号是否已被占用
GET  /dsh-market/self                        未登录；服务端携带的插件自身版本 + sha256
GET  /dsh-market/self/download               未登录；该包的字节
GET  /dsh-market/admin/identity             列出全部绑定（仅 admin）
POST /dsh-market/admin/identity/unbind      按任一侧解绑（仅 admin）
POST /dsh-market/publish                    上传归档；默认 dry run，?commit=1 写入（仅 admin）
GET  /dsh-market/admin/users|groups|artifacts
POST /dsh-market/admin/users|password|status|role|groups|membership|grants|artifacts/state
```

> **设备授权流已删除。** 它曾经存在（`auth/device/start|poll|approve|token`），但**没有
> 消费方**：CLI 从不用它，安装页只调过 `approve`，而它当初要解决的那个问题——「插件里不直接
> 登录、回到网页授权」——后来由 DSH 账号绑定解决了（§1.6）。
>
> 删掉它同时消除了两个真实缺陷：
>
> - `device/start` **没有频率限制**，每次调用写一行库。服务端一旦部署到可访问的地址，
>   同网段的人就能刷它；过期记录只在 `prune` 时清，不是自动的。
> - 它返回的 `verificationUrl` 用 `?activate=<code>`，而页面读的是 `user_code`，
>   所以那个链接**打不开授权界面**——一个发出去就注定失败的链接。
>
> 相关的一并移除：`device_auths` 表与索引、`DEVICE_TTL_MS`、`store` 的四个设备方法、
> 页面里的激活视图与 `runActivate`。`dsh_bindings.device_id` 是**另一回事**
> （DSH 设备指纹），未受影响。

### 0.8 三条不可动摇的规则

1. **默认拒绝** —— 没有任何规则授予就不能装（连管理员也一样，`E_NO_GROUP`）。
2. **deny 优先** —— 命中任一 deny 规则即拒绝，无论有多少 allow。
3. **变更即时生效** —— 停用账号会当场吊销其全部会话，旧令牌下一个请求就是 401。

### 0.9 制品的可信链条

发布时算 sha256 存库；下载时**服务端先把磁盘上的字节重新哈希一遍**，不一致就拒绝下发
（`E_HASH_MISMATCH` + 审计 `artifact.corrupt`），而不是把可疑字节发出去让客户端发现。
归档是**确定性打包**（mtime 固定为 0、条目排序），同样的目录树永远得到同样的哈希。

### 0.10 服务端测试

```powershell
& $node tools\test-server.mjs     # 57 项：引导/登录/权限/发布/下载/哈希/设备码/审计
& $node tools\test-publish.mjs    # 35 项：CLI 登录/预检/上传/畸形归档/状态流转
```

---

### 0.11 市场也能装 skill

**插件和 skill 是两种东西，安装方式完全不同。**

| | 插件（package.json） | skill（SKILL.md） |
|---|---|---|
| 谁来装载 | cordis loader，启动时 mount | **没有 loader**，agent 按需读取 |
| 安装时写什么 | profile 的 `cordis.patch.yml` 插一行（或 `dsh.profile.bundles`） | **什么都不写**，只放文件 |
| 发布时服务端记录 | `kind: "plugin"` 或 `"bundle"` | `kind: "skill"`（据此标注与校验） |
| 放在哪 | `<profile>/node_modules/<包名>` | `<profile>/.dsh-market-skills/<包名扁平化>` |
| 怎么进会话 | loader 自动 mount | 宿主插件启动时 `ctx.skills.register` |
| 生效 | **重启 DSH**（loader 只在启动时读） | **即时**（轮询目录，装完就进目录） |

#### 发布一个 skill

skill 包 = **一个最小的 `package.json`（市场元数据）+ `SKILL.md`**，其余 `references/`、
`scripts/`、`assets/` 原样带上：

```json
{
  "name": "@dsh-internal/skill-release-checklist",
  "version": "1.0.0",
  "dsh": { "market": { "kind": "skill", "owner": "platform", "summary": "发布前检查清单" } }
}
```

```markdown
---
name: release-checklist        # 必填，kebab-case，这是模型看到的名字
description: 发布前的检查清单。  # 必填
whenToUse: 准备发布时            # 可选
---

正文……
```

> `kind: "skill"` 是关键。没有它，市场会把它当插件：插一行 loader 记录，然后因为找不到
> 可加载的入口而在启动时报 `failed to import`。

然后照常发布（`node server/cli.mjs publish --dir <目录>`），客户端就会在目录里看到它，
安装按钮与插件完全一样。

#### 跑全套

```powershell
node tools/run-all.mjs            # 全部
node tools/run-all.mjs skill      # 只跑名字里含 skill 的
```

**别再用「数 ok 行」的临时脚本。** 我这么干过一次：`probe-skill-install.mjs` 在第一行就崩了
（那次改动让发布时校验开始拒绝它自己的夹具），于是它输出 `ok=0 FAIL=0`，
汇总脚本报出「565 通过、0 失败」——而总数其实比改动前**少了 15**，尽管刚加了 27 项断言。

**一个什么都没输出的套件不是通过的套件，是没有跑起来的套件。** 所以 `run-all.mjs` 把下面
任一条都算失败：退出码非 0、没有打印 `RESULT:` 行、出现 `FAIL` 行，并以 `INCOMPLETE`
和退出码 1 结束，明确告诉你总数不可信。

#### 安装页的筛选与分页

安装页有三个 tab：**全部 / 插件 / 技能**，服务端分页（每页 10 / 20 / 50），结果仍是卡片，
每张卡片的**第一个标签就说明它是技能还是插件**——两者安装方式完全不同（插件要重启，
技能几秒内生效），光看名字不一定分得出来。

**两个 tab 覆盖三种存储类型**：组合包归入「插件」。组合包只是多带一层 patch 的插件包，
从安装的人眼里与普通插件没有区别。tab 上的计数由服务端给出，所以标签不会和实际筛选行为脱节。

**筛选与搜索都在服务端做。** 这一点是被分页逼出来的：在整份目录一次返回时，浏览器里筛选
和它等价；一旦分页，客户端筛选就只在**当前页**里找，别的页上的条目会被报成「没有匹配」——
不报错，只是安静地找不到。

> 目录**列出全部条目并逐条标注能否安装**，不是只列有权限的。这是既定设计：看不到某个插件
> 就无从申请它的权限。安装页上原本那句「只显示你的权限组被授权的条目」是错的，已改。

#### 技能包里不需要 package.json

**只有一个 `SKILL.md` 的技能可以直接发布。** 这是生态里 skill 的格式，要求旁边再放一个
`package.json` 是本市场的要求，不是格式的要求——而它产生的死胡同很难看：发布者压缩了自己的
技能、选中、然后看到「归档内没有 package.json」，一个他没有任何理由期待存在的文件。

服务端改为**自己补出那个 manifest**：名字取 frontmatter 的 `name`，摘要取 `description`，
`kind` 强制为 skill，版本默认 `0.1.0`。发布表单里有两个可选输入可以覆盖后两项——

| 字段 | 为什么不能从 SKILL.md 推 |
|---|---|
| **包名** | 权限规则按包名匹配，所以 `@dsh-internal/*` **匹配不到**一个裸的 `my-skill`。留空就用 frontmatter 的名字；要让你已有的规则生效，填 `@作用域/名字` |
| **版本** | 更新按版本比较。从不声明版本的技能可以发布，但**永远不会显得比已装的更新** |

两者都会在预检里显示出来（「已按 SKILL.md 补出一个：name=… version=…」），所以没有任何东西被
悄悄决定。也可以在 `SKILL.md` 的 frontmatter 里写 `version: 1.2.0`。

> 入库后仍然是同一种形状：**扁平 tar.gz + 根部的 package.json**。补出的 manifest 会被注入归档，
> 所以权限匹配、更新比较、客户端安装与卸载全都不需要为新情况开分支。

#### 发布时可以用 zip

控制台上传接受 **.tar.gz / .tgz / .zip**。Windows 上右键「压缩文件夹」就是 zip，不该逼人先装工具。

zip **不是第二种存储格式**：服务端读出来、重新打成规范的 tar.gz 再入库，所以存储、哈希、下载、
客户端解包仍然只看一种格式。**打包时的外层目录也会被剥掉**（npm 的 `package/`，或压缩时产生的
同名目录），因此入库结果始终是「`package.json` 在根部」这一种布局。

预检会告诉你发生了什么：类型、上传了多少字节、入库多少字节、以及剥掉了哪层前缀。公布的是
**归一化之后**的 sha256，也就是客户端下载后会用来校验的那一份。

> 顺带修掉一个既有 bug：`inspectArchive` 一直接受 npm 布局，而客户端只在根上找
> `package.json` —— 于是市场能发布、能上架、能下载，**客户端却在最后一步报 E_NOT_PACKAGE**。
> 布局规则现在抽成 `server/lib/layout.js`，两侧共用，不会再各自漂移。

#### 控制台认识技能

服务端在**发布时**就记录类型（`plugin` / `bundle` / `skill`），所以：

- **制品列表**有一列「类型」，技能会标出来；发布**预检**第一行就写明「将发布：技能 xxx@1.0.0」。
- **残缺的技能在发布时就被拒绝**，不再等到客户端安装那一刻：

  | 错误 | 情形 |
  |---|---|
  | `E_SKILL_MISSING` | 声明了 `kind: "skill"` 却没有 `SKILL.md` |
  | `E_SKILL_BAD_FRONTMATTER` | 没有 frontmatter，或缺 `name` / `description` |
  | `E_SKILL_BAD_NAME` | `name` 不是 kebab-case |

  在此之前，这样的包**能发布、能出现在目录里、能点安装**，然后在最后一步失败——
  而发布者早已拿不到反馈。

- **CLI 与上传走同一套校验。** 此前 `publish --dir` 完全跳过检查，比上传还宽松：
  连 `dsh.bundle.patch` 指向的文件缺失都能从目录发出去，同样的包上传却会被拒。
- 旧数据库开机会自动补上 `kind` 列，历史行按 `plugin` 读出。

#### 撤回 ≠ 召回（这是两个不同的承诺）

| 动作 | 作用 | 够不到的地方 |
|---|---|---|
| **改状态 → revoked** | **停止分发**：目录里不再出现，有权限也下载不到（`E_REVOKED`） | 已安装的副本**继续工作**，客户端甚至不知道发生过 |
| **召回** | 要求每台客户端**移除**已安装的副本（可逆） | 离线、或再也不会启动 DSH 的机器 |

两者**刻意分开**：如果 `revoked` 本身就等于召回，那么"先下架、修好再放回"就会变成清空所有人的安装。

| | 生效时间 |
|---|---|
| 技能 | **几秒**（轮询目录，删除即注销） |
| 插件 | **下次启动 DSH**（装载器只在启动时读） |

**被召回的版本会同时停止分发**——一边要求移除、一边继续提供是说不通的。客户端目录里不再出现它，
`latest` 也不会指向它（所以不会出现「更新到 <被召回的版本>」）。

**每次移除都会留回执**（`<profile>/.dsh-market-recalled.json`），安装页顶部会显示移除了什么 ——
东西从 profile 里无声消失，比召回本身要解决的问题更糟。

客户端靠**绑定密钥**换会话后查询（与自动登录同一条路径），所以不需要额外配置；
`MARKET_SERVICE_TOKEN` 存在时优先用它。`MARKET_AUTO_RECALL=0` 可以关掉整个对账。

> **拿不到凭据时不猜、不删** —— 对账会明确报告 `no-credential` 并保持原样。
> **按名字+版本精确匹配** —— 召回 1.0.0 不会删掉已装的 1.1.0。

> **诚实的边界**：召回够不到**再也不会启动 DSH 的机器**，也够不到离线的机器。拉取式客户端
> 无法被强制，这不是实现缺陷，是模型本身的限制 —— 所以召回弹窗里把这句话写给了操作员。

#### 更新一个技能（以及一个会静默失效的坑）

**版本号必须提高，客户端才会看到更新。** 更新与否是按版本比较的，所以：

| 做法 | 结果 |
|---|---|
| 改内容，版本仍是 1.0.0 | **覆盖**已发布的那一版；已安装 1.0.0 的人**收不到** —— 版本相同，页面不出现更新按钮 |
| 改内容，版本提到 1.1.0 | 页面出现「更新到 1.1.0」，装了就有 |

预检会把这两种情况分开说明，并在内容变了而版本没变时**明确告诉你后果和改法**：

- 内容完全相同 → 说明这是**空操作**（不是"改了没生效"）
- 内容不同 → 警告**已安装的人收不到**，并建议一个下一个补丁号

**版本号写在哪里？** 由包自己决定，三选一：

| 位置 | 何时用 |
|---|---|
| **`SKILL.md` 的 frontmatter 加一行 `version: 1.1.0`** | **推荐。** 你本来就在改这个文件，版本和内容在一起，不会忘 |
| 包里的 `package.json` | 想同时显式控制 name 与 version |
| 发布表单的「版本」框 | **只在包内完全没有版本信息时生效**；包声明了版本就以包为准，表单不覆盖它 |

> 为什么必须有版本：**「更新」需要可比的大小关系。** 哪里都不写版本时它固定为 `0.1.0`，
> 重发只是覆盖 —— 在语义上不存在"更新"这回事。这不是市场的任性，是「更新」本身需要方向。

#### 已知限制：卸载技能后，`/` 菜单里的提示要等新会话才消失

卸载一个技能后，**模型侧立刻生效**（`skill` 工具马上找不到它，实测如此），但 **DSH 输入框里打 `/`
时那个技能名还会提示** —— 直到新开一个会话或重启 DSH。

原因是 DSH 客户端自己的缓存，不是本插件的：

```js
const fetchCatalog = (sessionId) => {
  const existing = fetches.get(sessionId)
  if (existing !== void 0) return existing      // 命中就直接返回旧结果
  ...
}
ctx.remote.$on('agent-preset/selected', invalidate)
ctx.on('connection/reset', clearAll)
```

`/` 菜单的列表**按会话缓存一次**，只有「选择了预设」「连接重置」「组件卸载」三种情况会清它。
**技能注册表的变动没有订阅进去**，所以运行时注销不会让这个缓存失效。缓存按 `sessionId` 键，
因此**新会话没有条目 → 必然重新拉取**。

> 本插件**刻意不**去伪造 `agent-preset/selected` 事件来强制刷新：那个事件的含义是「本会话切换了
> 预设」，而且会**写进会话日志**的 `agentPreset` 投影。为了清缓存而发它，会让日志与实际运行状态
> 不符 —— 那是往数据里掺假，不是修 bug。

#### 为什么放市场自己的目录，不放 `~/.dsh/skills`

DSH 的 skill 根有四个（`<项目根>/.dsh/skills`、`<项目根>/.agents/skills`、`~/.dsh/skills`、
`~/.agents/skills`），**市场一个都不用**。理由是归属：`~/.dsh/skills` 是你自己手写 skill 的
地方，市场往里放东西之后就分不清哪些是它装的——卸载时**可能删掉你手写的**。

所以市场通过 `ctx.skills.register`（注册表文档里明确支持的扩展点）只读自己那个目录。
卸载就是删目录，空目录也会一并清掉。

注册不是只在启动时做一次：插件每 2 秒重读该目录，**安装 / 改正文 / 卸载都会在几秒内反映到
会话目录里，不需要重启**。这一点比插件好——插件必须重启，因为 loader 只在启动时读一次。

> 重新注册要小心：`register()` 在同一个 layer 里是**先到先得**的，直接覆盖同名条目会被忽略
> 并只留一条警告。所以改了正文的技能必须**先 dispose 再注册**，否则目录里留着的还是旧正文，
> 而看起来像是更新成功了。

#### 拒绝而不是半装

装进去之前就会检查：`SKILL.md` 缺失（`E_SKILL_MISSING`）、frontmatter 缺失或调用开关不是
布尔值（`E_SKILL_BAD_FRONTMATTER`）、`name` 不是 kebab-case（`E_SKILL_BAD_NAME`）——
任一不合规都**不留目录**。一个坏 skill 也不会拖垮其他 skill 或插件：注册时逐个 try，
失败的记进诊断日志并跳过。

```powershell
# 看市场装了什么技能（kind=skill）
Invoke-RestMethod http://<服务端>:8787/dsh-market/installed   # 由宿主插件提供，见 /dsh-market/installed
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
& $node tools\test-bindings.mjs                                # 绑定的 1:1 约束（直接打数据库）
& $node tools\test-binding-http.mjs                            # 绑定路由（含越权与冲突码）
& $node tools\verify-install.mjs "$env:USERPROFILE\.dsh\profiles\desktop"   # 安装与客户端契约预检
& $node tools\check-docs.mjs                                   # 文档里的路径与代码片段是否仍然属实
```

`test-bindings.mjs` 与 `test-binding-http.mjs` 分工明确：前者证明**数据库约束**在两个方向
都成立（这条规则的实际执行点），后者证明**路由**没有绕过它——包括最关键的一条：
市场账号只能来自令牌，不能来自请求体。

`verify-install.mjs` 里那组"客户端契约"断言值得单独说：它们守的是**让客户端半边能加载的
每一条硬性要求**（`dsh.client` 声明、`exports["./client"]`、factory id 等于包名、bare-name 行、
`lib/bundle.js` 导出 `apply`、不得注册无面板的 `sidebar.panellist`、只使用主题 token）。
每一条都是被违反过、而且症状极不明显的那种。

`check-docs.mjs` 守的是文档本身：它扫描 `docs/adding-a-ui-entry.md` 里提到的每个项目内路径
是否真实存在、代码片段是否仍与 `lib/client.js` 等文件一致。**文档会腐烂，所以让它可执行。**

端到端验证（需要浏览器控制、且需要 DSH 实例在跑）：

```powershell
& $node tools\verify-native-entry.mjs 'http://127.0.0.1:3080/' 9420 "<token>"
```

它断言原生按钮**真的渲染出来了**（而不只是被组装了），并报告页面异常。

### 1.6 身份绑定：DSH 账号 ↔ 市场账号

**目的**：让用户不必在两处维护身份。DSH 那边已经登录了账号，安装页就直接用它。

#### 数据从哪来

宿主插件从 DSH 的组合账号服务读到账号，**实测结果**：

| 调用 | 返回 | 代价 |
|---|---|---|
| `ctx.get('deepseekAccount')` | 服务对象 | 无 |
| `getDeviceIdentity()` | `{ deviceId, osVersion }`，`userId` **不在里面** | 无（读本地凭证记录） |
| `getProfile({version,locale,timezoneOffsetSeconds})` | `{ status:'ready', id, name, contact }` | **要联网**，向 `platform.deepseek.com` 发请求 |
| 再调 `getDeviceIdentity()` | `{ deviceId, userId, osVersion }` | 无 |

> **`userId` 不会自己出现。** 实现里 `getPlatformSession()` 是这么算的：
> `userId: lastProfile?.token === stored.token ? lastProfile.profile.value.id : null`
> ——只有**成功读过一次 profile** 之后，账号 ID 才可用。

#### 一对一规则

**一个 DSH 账号只能绑一个市场账号，反之亦然。** 两个方向都由数据库唯一约束强制，
测试逐条验证（`tools/test-bindings.mjs`）。

冲突返回**两个不同的错误码**，因为处理方式不同：

| 错误码 | 含义 | 该怎么办 |
|---|---|---|
| `E_DSH_ALREADY_BOUND` | 这台机器的 DSH 账号已经绑了别的市场账号 | 在安装页把当前绑定解绑，或用那个市场账号登录 |
| `E_MARKET_ALREADY_BOUND` | 这个市场账号已经绑了别的 DSH 账号 | 在安装页解绑后再试，或让管理员处理 |

同一对重复绑定是**幂等成功**（`unchanged: true`），所以刷新页面不会报错。

#### 绑定是「归属记录」，不是「使用限制」

这个问题被问过一次，所以把实测结论写下来：**一个市场账号绑给了某个 DSH 账号之后，
它仍然可以在任何时候、任何机器、任何别的 DSH 账号下登录。**

实测（`tools/probe-binding-scope.mjs`，全部通过）：

| 行为 | 结果 |
|---|---|
| alice 的市场账号绑到 `dsh-alice` | ✅ 成功 |
| 再用同一个市场账号登录（携带的是**别的** DSH 账号） | ✅ **成功**，会话正常可用 |
| 这次登录是否改变绑定 | ❌ 不改变，仍是 `dsh-alice` |
| 能否用已绑定的市场账号去绑第二个 DSH 账号 | ❌ `409 E_MARKET_ALREADY_BOUND` |
| 第二个 DSH 账号是否被偷偷占用 | ❌ 没有，仍空闲 |

**为什么是这样**：登录只校验市场账号的密码，请求里根本不带 DSH 身份。绑定记录的是
「谁拥有谁」，它拦住的是**新建绑定**（一对一），不是**使用**。

**这意味着什么**：绑定的作用是让"这个市场账号属于这台机器的 DSH 账号"这件事有据可查，
并防止一个名额被两个身份反复认领。它**不是**"把市场账号钉死在这台机器上"。
知道密码的人在哪都能用——和普通账号密码体系一样。

**如果目标是钉死**，那就得换个设计：登录请求要带上本机 DSH 身份，服务端拒绝与绑定不符的
登录。需要说清的是，那种检查**只防误用、不防攻击**——客户端可以谎报身份，直接对服务端发请求
就能绕过。真正的强制只能靠密码/令牌本身。

#### 手动绑定，不自动

**登录不会建立绑定，只有点击按钮才会。**

第一版在 `onAuthenticated` 里自动绑定，理由是"省一次操作"。但绑定是**一对一**的，
也就是说这个名额是**稀缺**的：

- 用户登错市场账号 → 名额被悄悄占用 → 只有管理员能释放；
- 用户不知道为什么自己的 DSH 账号"已经绑过了"。

所以现在：

1. 登录后只**读取**绑定状态（`GET /identity/me`）并展示；
2. 按钮先查 `GET /identity/lookup?dshUserId=…`，被占用就直接显示「该 DSH 账号已被占用」并禁用；
3. 只有点击才 `POST /identity/bind`。

`lookup` 存在的主要理由就是这个：**一个点了必然失败的按钮，比一个提前说明情况的按钮更糟。**
它只回答 `bound` 与否，**不说绑给了谁**——未登录的调用者不该能枚举别人的账号。

#### 解绑是用户自己的事，不是管理员的事

**安装页上的「解绑」按钮可用，不需要管理员。**

第一版把它锁给了管理员，理由是"解绑影响两侧"。那是错的：

- 绑定是**用户自己**的账号关联。让他去找管理员才能撤销，等于把一次登错变成一张工单；
- 而且那次实现里安装页的按钮对**所有人**都是禁用的——包括管理员自己。
  于是**谁都解不了**，只能去服务端控制台。这正是它被报告上来的原因。

自解绑路由（`POST /dsh-market/identity/unbind`）**不接收任何标识**：它释放的是调用方令牌
所属的那条绑定。所以没有东西可以伪造，也碰不到别人的绑定。测试验证了这一点：
带着 `{ dshUserId: '别人的', marketUsername: '别人的' }` 去请求，解掉的仍是他自己的。

管理员路由仍然保留，用于用户自己动不了的情况：DSH 账号的主人已离职，或市场账号要改派。

解绑有确认对话框，不额外要求密码——一个用"再绑一次"就能撤销的操作，确认就够了。

#### 身份不能来自请求体

市场账号那一侧**只取自令牌**，永远不读请求体。测试专门验证：带
`{ dshUserId, marketUsername: 'alice' }` 去请求、但令牌属于 bob 时，**绑定给 bob**。

DSH 账号那一侧来自本机插件的 `/dsh-market/identity`，它**不转发平台凭据**——
`getPlatformSession()` 会返回活的 token，而只想显示身份的页面没有理由持有它。
`verify-install.mjs` 断言宿主半边从不调用 `getPlatformSession`，且身份函数里不出现 `token`。

#### 读不到就没有

三种情况都**不是错误**，只是没有身份可用，页面退回普通登录：

| `source` | 含义 |
|---|---|
| `account` | 有稳定账号 ID，可以绑定 |
| `device-only` | 已登录但没读到账号 ID（未调用 profile / 读取失败） |
| `none` | 未登录 DSH，或账号服务不可用 |

> **因此它不能作为唯一权威。** 依赖「用户登录着 DSH 账号」且「网络可达」，
> 所以账号登录必须保留为回退路径——这不是可选设计，是前提。

#### 自动登录（绑定之后不用再输密码）

**DSH 账号已登录 + 已绑定 + 本机持有绑定密钥 => 安装页自动取得会话，不出现登录框。**

关键在于**账号 ID 不是凭据**。实测：宿主插件的 `/dsh-market/identity` 会**反射任意 Origin**，
所以用户访问的**任何网站**都能读到他的 DSH 账号 ID（该路由当前就返回
`access-control-allow-origin: <你的 origin>`）。如果这个 ID 足以换到会话，
**任何网站都能接管你绑定的市场账号**。

所以真正的凭据是一个**绑定密钥**：

| 时机 | 发生什么 |
|---|---|
| 绑定成功 | 服务端生成随机密钥，**只在这里下发一次**，库里只存哈希 |
| 页面 | 把密钥交给**宿主插件**（`POST /dsh-market/link`），插件写进 profile 的 `.dsh-market-link.json` |
| 下次打开 | 页面向插件要会话（`GET /dsh-market/session`），插件拿密钥换会话并返回令牌 |
| 重新绑定 | 密钥**轮换**，旧的立刻失效 |
| 解绑 | 服务端删掉绑定（密钥随之无效），页面同时清掉本机那份 |
| **点「退出」** | **同时清掉本机密钥**。否则退出只清掉会话，下一次打开又会拿密钥换一个新会话 —— **「退出」形同虚设** |
| 退出后想恢复 | 绑定行出现「在此设备启用自动登录」，点一下即可（**不必先解绑**） |

> 退出**只关闭本机的自动登录**，不影响绑定本身：名额仍是那个 DSH 账号的。

密钥**从不进入浏览器**：页面只向插件要结果，插件持有凭据。插件的两条路由都
**校验 Origin 必须是 DSH 自己的来源**，所以别的网站 ask 也拿不到会话（实测返回
`E_FOREIGN_ORIGIN`）。`/identity/me` 与 `/admin/identity` **都不返回密钥**。

> 绑定密钥存在 profile 里，权限 0600。它是本机凭据：谁拿到它就能换到那个市场账号的会话，
> 所以丢弃机器时要一并处理（解绑即可让它失效）。

#### 会话自动续期（7 天）

服务端从第一版起就签发 `refresh`（有效期 7 天）并把哈希存进了 `sessions`，但**两边都没有
兑换过它**——所以会话 2 小时一到就只能重新登录，那个 7 天窗口只是纸面上的。

现在：页面把 refresh 存起来，遇到 401 时**兑换一次**再重试（只重试一次，失败的兑换会清掉
两个令牌，否则会死循环）。兑换是**轮换制**：旧的 token 与 refresh 一起被替换，所以泄漏的
refresh 只能用一次，合法持有者下一次调用会立刻失败而不是两边静默共用一个会话。

登出会**一并吊销 refresh**——否则「登出」会在下一次请求时自动登回来。账号被停用后
refresh 也立即失效。19 项断言见 `tools/probe-refresh.mjs`。

#### 管理

**日常解绑由用户自己在安装页完成**，不需要管理员。下面这些是管理员用于"用户自己动不了"
的情况：账号主人已离职、市场账号要改派、或需要直接查看谁占了哪个名额。

控制台「身份绑定」面板可以查看与解绑。CLI：

```bash
node server/cli.mjs bind:list
node server/cli.mjs bind:add --dsh-user <DSH 账号 ID> --user <市场账号> [--name 显示名]
node server/cli.mjs bind:rm  --dsh-user <DSH 账号 ID>     # 或 --user <市场账号>
```

`bind:rm` 支持两个方向，因为变更可能发生在任意一侧（换机器、重装，或人员调整）。

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
    └── http.js               HTTP 路由 + 控制台页面与静态资源

lib/                          本机插件（DSH 客户端半边）
├── bundle.js                 裸包名入口：**必须导出 apply**（写成 export {} 会失败，见 §4.1.1）
├── plugin.js                 host 行：下载 → 校验 → 解包 → 注册；提供 /market 与其资源
├── client.js                 客户端半边：注册 sidebar.footer.action 原生入口
└── tar.js                    受限 tar 读取（拒绝符号链接与路径逃逸）

web/                          两个界面 + 共用件（无构建步骤）
├── market.html               DSH 入口：只做安装 / 卸载
├── console.html              服务端控制台：账号、权限、发布、制品
├── shared.js                 **共用**：令牌、请求、登录/改密/登出/设备授权、表单小工具
├── market.css                **共用**：配色、深浅色、窗口控件留白
└── console.css               控制台专有：双栏布局、导航轨、发布预览

cordis.patch.yml              patch 层：两行 insert（宿主子路径 + 裸包名）
docs/adding-a-ui-entry.md     **给 DSH 加插件入口的完整做法与踩坑记录**
tools/                        测试、契约预检、只读诊断脚本
```

> 想自己加一个 UI 入口，或者想知道这个入口为什么长这样，直接读
> [`docs/adding-a-ui-entry.md`](docs/adding-a-ui-entry.md)。里面写了三条硬要求、
> 症状对照表、插槽怎么选，以及本项目为此返工的每一个坑。

## 3. 已知限制

- 发布已可在**服务端控制台**上传 `.tar.gz`（预检 → 确认发布），CLI `publish` 仍然可用。
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
