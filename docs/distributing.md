# 把内部插件市场装到其他 DSH 客户端

本文回答一个问题：**别的同事的 DSH 上，怎么出现这个「内部插件市场」入口。**

结论先给：**一条命令**。但那条命令之前有两件事要先做对，而其中一件我在实测时才发现。

---

## 0. 快速版

```powershell
# ① 在开发机打一个分发包（只做一次）
cd E:\workspace\dsh
node tools\pack-dist.mjs
#   -> dist\dsh-plugin-marketplace-0.1.0.tgz

# ② 把 tgz 分发出去（共享盘 / 内部文件服务器），在每台客户端上安装
dsh plugin --profile <profile> add ".\dsh-plugin-marketplace-0.1.0.tgz"

# ③ 每台客户端把环境变量指向服务端，然后重启 DSH
[Environment]::SetEnvironmentVariable('MARKET_SERVICE_URL', 'http://<服务器>:8787', 'User')
```

**① 只做一次；② 和 ③ 每台客户端都要做。**

前提是**服务端已经部署在一台大家都访问得到的服务器上**——那是服务端部署的事，
不是客户端分发的事。

> `dsh plugin add` 会一次做完三件事：写进 profile 的 `dependencies`、
> **加进 `dsh.profile.bundles`**、用 pnpm 装进 profile 的 `node_modules`。
> 第三件是关键（见 §2）。

---

## 1. `package/` 前缀是必须的（我在这里踩了一次）

npm 包的 tarball 必须把**所有条目放在一个 `package/` 目录下**。这是 npm/pnpm 用来
确定包根位置的约定。我在本机两边都验证过：

| 归档布局 | pnpm 装出来的结果 |
|---|---|
| 条目在根：`lib/plugin.js` | ❌ 装成 `plugin.js`（**`lib/` 段丢失**），`exports` 指向不存在的文件，两条 loader 行都 `failed to import` |
| 条目在 `package/` 下：`package/lib/plugin.js` | ✅ 目录结构正确，两条行都激活，侧栏入口渲染 |

所以 `tools/pack-dist.mjs` 是**先建一个 staging 目录、里面只有一个 `package/`**，
再从那个目录打包——而不是给条目名加前缀，因为打包函数是按相对根目录读取的。

**这个坑的症状极具误导性**：pnpm 报告安装成功、`dependencies:` 也打印了、
`node_modules/<name>` 也出现了，只是**里面的文件是扁平的**。然后 DSH 报
`failed to import`，而你会去查 loader，不会想到是 tar 布局。

---

## 2. 为什么 `dsh.profile.bundles` 必须被写入

客户端入口是**客户端半边**（`lib/client.js` + `package.json` 的 `dsh.client`）。
它和宿主半边不一样，**必须**：

1. profile 的 `dsh.profile.bundles` 里有这个包名 → 它的 `dsh.bundle.patch` 才会被当成一层 patch 应用；
2. patch 里有**裸包名**那一行 → `dsh-client-modules` 才会把客户端半边组装进 boot graph；
3. `node_modules` 里有这个包 → 裸包名才解析得到。

实测过一件事，值得记下来：**把包直接复制进 profile 的 `node_modules`（不是 junction）
也能工作**。所以裸包名是从 **profile 目录**解析的，不要求包在 DSH 安装目录里。
`dsh plugin add` 三条都做到，所以它是正确的分发方式。

---

## 3. 客户端要知道服务端在哪

**部署形态**：服务端跑在一台大家都访问得到的服务器上。客户端只做一件事——把环境变量
指向那个地址。

```powershell
# 每台客户端机器，用户级环境变量，然后重启 DSH
[Environment]::SetEnvironmentVariable('MARKET_SERVICE_URL', 'http://<服务器>:8787', 'User')
```

三个要点：

1. **用户级变量**，不是只在当前 PowerShell 窗口里 `set`。从开始菜单启动 DSH 时只继承
   用户级/系统级变量——这是最常见的"明明设了却不生效"。
2. **设完要重启 DSH**。宿主插件在 `apply` 时读一次这个变量，之后不会重读。
3. **怎么确认配对了**：安装页和控制台都会显示当前用的服务端地址。配错能立刻看出来，
   不用去翻日志。

> 服务端地址可以是 `http://`；如果放在反向代理后面用 `https://`，也照填。这是服务端部署的
> 事，客户端不关心它怎么被代理——只要浏览器和客户端都能访问到那个 URL。

<details>
<summary>开发时服务端就在本机（与本部署无关，仅备查）</summary>

本机跑服务端时它默认只监听 `127.0.0.1`，别的机器连不上。要让同网段能访问：

```powershell
.\start-market.bat --host 0.0.0.0
```

实测：绑到 `0.0.0.0` 后可从内网地址访问 health 与控制台。`--host` 同时会设
`MARKET_CALLBACK_HOST`，否则服务端拼出来的 URL 仍是 `127.0.0.1`，别的机器点不动。

**这只适用于"服务端恰好在你机器上"的开发场景。** 真实部署里服务端在服务器上，
客户端不需要任何 `--host` 参数。
</details>

---

## 4. 装完之后

1. **重启 DSH**（package 变了）。
2. 左侧栏底部出现「内部插件市场」，点击可在浏览器打开安装页。
3. 安装页登录后可以：
   - 看自己的插件目录（默认拒绝：没有规则就什么都看不到）；
   - 安装 / 卸载；
   - **绑定 / 解绑自己的 DSH 账号**（一对一，不需要管理员）。
4. 权限、账号、发布在**服务端控制台** `http://<服务器>:8787/console`。

### 装完怎么确认成功

看 DSH 的 stderr：

```
✅ 什么都不打印
❌ dsh: warning: N entry did not activate
   marketplace (dsh-plugin-marketplace/plugin): failed to import
```

看到 `failed to import`，先查这一件事：`node_modules\dsh-plugin-marketplace\lib\plugin.js`
**是否真的在 `lib\` 下**。如果文件是扁平的（`plugin.js` 直接在包根），就是 §1 那个
`package/` 前缀问题——归档打错了。

---

## 5. 升级（更新插件自己）

**必须升 `package.json` 里的 `version`，否则更新会静默不生效。**

```powershell
# ① 开发机：先改版本号，再打包
#    package.json  "version": "0.1.0"  ->  "0.1.1"
node tools\pack-dist.mjs
#   -> dist\dsh-plugin-marketplace-0.1.1.tgz

# ② 每台客户端：装新包，然后重启 DSH
dsh plugin --profile <profile> add ".\dsh-plugin-marketplace-0.1.1.tgz"
```

> **为什么版本号是必须的——实测过一次，很反直觉：**
>
> 不升版本号、只把同一个路径下的 tgz 重新打好再 `add`，**文件不会变**。
> 实测：装 0.1.0（`lib/plugin.js` 哈希 `0F571A46…`），原地重打一个内容不同的 0.1.0，
> 再 `add` 同一路径 —— 哈希仍是 `0F571A46…`，新内容从未落盘。
> pnpm 按 tarball 路径 + 版本号判定，**不看内容**。
>
> 升到 0.2.0 后同样的操作立刻生效：版本变了、哈希变成 `42C4C1CF…`、新内容到位。
>
> 所以"更新没生效"的第一嫌疑永远是**忘了改版本号**。
>
> 实在不能升版本号时，退路是让 pnpm 忘掉这个依赖：
> `dsh plugin --profile <p> remove dsh-plugin-marketplace` 再 `add`，
> 或者删掉 profile 的 `node_modules/.pnpm` 后重装。

**装完必须重启 DSH。** 包是启动时读的，不重启就还是旧代码在跑。

**验证更新是否真的生效**（别只看命令有没有报错）：

```powershell
# 版本号对不对
(Get-Content "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-plugin-marketplace\package.json" -Raw | ConvertFrom-Json).version
# 文件是不是新的（哈希应当与开发机打包时的内容对应）
Get-FileHash "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-plugin-marketplace\lib\plugin.js" -Algorithm SHA256
```

> **改了什么要重打包**见 §8。控制台（`web/console.*`）与 `server/**` 属于服务端，
> 改它们**不需要**动客户端包。

---

## 6. 卸载

```powershell
dsh plugin --profile <profile> remove dsh-plugin-marketplace
```

然后从 profile 的 `package.json` 里去掉 `dsh.profile.bundles` 中的这一项
（`remove` 不一定代劳），并重启 DSH。

---

## 7. 与市场上卖的插件不是一个格式（重要）

同一个仓库里有**两种归档**，别混淆：

| | 用途 | 布局 | `package.json` 位置 |
|---|---|---|---|
| `tools/pack-dist.mjs` 产出的 | **给 DSH 装这个插件本身** | 全部在 `package/` 下 | `package/package.json` |
| `server/lib/pack.js` 产出的 | 市场登记的**制品**（别人要装的插件） | 扁平 | 归档根 `package.json` |

market 的制品格式以**扁平**为准，但 `inspectArchive` **现在也接受 npm 布局**
（全部条目在 `package/` 下），并把前缀归一到读取视图里。两件事因此同时成立：

- 上传一个用 `npm pack` 打出来的包不再被 `E_NOT_PACKAGE` 拒绝；
- 子目录不会再丢——`package/lib/plugin.js` 报告为 `lib/plugin.js`，就是安装后该在的位置。

> 这条曾经是一处**已知限制**：市场完全无法分发带子目录的包。现在没有了。
> 布局由归档自己决定，两种混用时按「不明确」拒绝，而不是猜。

---

## 8. 这个插件现在会自己更新（§5 的替代路径）

从这一版起，客户端**启动时会问服务端要包**，不同就自动换上，下次启动生效。
所以日常升级不再需要分发 tgz。

### 发布新版本的完整步骤

```powershell
# ① 开发机 —— 先改版本号，再打包
#    package.json  "version": "0.1.0"  ->  "0.1.1"
node tools\pack-dist.mjs
#   -> dist\dsh-plugin-marketplace-0.1.1.tgz

# ② 服务器 —— 把包放上去（一条命令）
$env:MARKET_DATA_DIR = '<服务端的数据目录>'    # 与 start-market.bat 用的一致
node server\cli.mjs publish:self --archive dist\dsh-plugin-marketplace-0.1.1.tgz
```

之后每台客户端**下次启动 DSH 时自动跟上**。

#### 不要手动往 `artifacts\self` 拷文件

那个目录由 `publish:self` 自己写，它要写**两样**东西：

```
<数据目录>\artifacts\self\marketplace.tgz     包的字节
<数据目录>\artifacts\self\marketplace.json    版本 + sha256
```

**只放 tgz 不放 json 是没用的** —— 服务端回答 `GET /dsh-market/self` 时读的是那个
描述文件，没有它就等于「没放包」，客户端只会记一条 `skipped`。

#### 服务端不需要重启

实测：放包前后各问一次 `/dsh-market/self`，**未重启服务端**就变了版本：

```
放包前                0.1.0  sha=822fe875682aca92
放 0.3.0 后（未重启）  0.3.0  sha=faa45c8761caac21
```

服务端每次请求都重新读盘并**校验哈希**，所以换了字节会立刻反映出来。

#### 服务器上没有这个仓库时

`publish:self` 有两条路，第二条不需要开发机产出：

```powershell
node server\cli.mjs publish:self --archive <tgz>   # 已经打好包
node server\cli.mjs publish:self --dir .           # 用服务器上的检出，自己按 npm 布局打包
```

`--dir` 会自己按 npm 布局（条目全在 `package/` 下）打包，**不需要 `tools/`**。

§5 那套手工 `dsh plugin add` 仍然有效，而且**新机器的首次安装只能用它** ——
那时客户端还没有这个插件，自然也没人去问服务端。

机制、硬约束（必须重启）、以及为什么拒绝链接安装，见 README §0.4。

---

## 9. 哪些改动要重打包，哪些不要

**问过的问题**：「控制台不是和服务端在一起吗？为什么改控制台要重打包插件？」

**答案是：不需要。我当时说错了。** 控制台由**服务端**提供，与插件包无关。

实测（`tools/probe-console-source.mjs`）：把一个标记写进**服务端那份** `console.html`，
该服务端的 `/console` 原样返回了它。所以：

| 改了什么 | 生效方式 |
|---|---|
| `web/console.html`、`web/console.css` | **重启服务端**。与插件包无关 |
| `server/**` | **重启服务端** |
| `web/market.html`、`web/market.css`、`web/shared.js` | 重启 DSH（`shared.js` 两个界面共用） |
| `lib/**`、`cordis.patch.yml`、`package.json` | **重打包 + 每台客户端重装 + 重启 DSH** |

**为什么包里不再含 `web/console.*`**：本机插件从不读它们——它的资源白名单
（`lib/plugin.js` 的 `PAGE_ASSETS`）**故意不含** console，并有测试断言
`console.css` 经插件路由返回 404。包里带一份就是死重，而且有个很坏的失败模式：
**如果有人从已安装的包里启动服务端，它会提供一份冻结的控制台快照**，改仓库永远不生效。
（这也正是我一度以为"改控制台要重打包"的原因——包里那份让这个说法看起来合理。）

---

## 10. 检查清单

**开发机（一次）**

- [ ] `node tools/pack-dist.mjs` 打出的归档，条目**都在 `package/` 下**
- [ ] 归档里**没有** `web/console.*`（那是服务端的页面，不属于客户端包）

**每台客户端**

- [ ] `dsh plugin --profile <p> add <tgz>` 没有报错
- [ ] profile 的 `dsh.profile.bundles` 里有 `dsh-plugin-marketplace`
- [ ] `node_modules\dsh-plugin-marketplace\lib\plugin.js` **确实在 `lib\` 下**
- [ ] `MARKET_SERVICE_URL` 是**用户级**变量，指向服务器地址
- [ ] **重启过 DSH**（装完包要重启，设完变量也要重启）
- [ ] stderr **没有** `failed to import`
- [ ] 左侧栏底部看得到入口，点得开
- [ ] 安装页上显示的服务端地址是对的
