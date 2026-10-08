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

## 5. 升级

重新打包、把新 tgz 给对方、再执行一次 `add` 即可（pnpm 会覆盖）。然后重启 DSH。

```powershell
node tools\pack-dist.mjs
# 对方机器：
dsh plugin --profile <profile> add ".\dsh-plugin-marketplace-0.1.0.tgz"
```

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

market 的制品格式是扁平的，因为 `inspectArchive` 是**在归档根**读 `package.json`。
这意味着**市场制品格式不支持子目录**——一个带 `lib/` 的插件包打成扁平归档后，
结构会丢失。我的客户端也是这样（`lib/` + `web/`），所以**当前不能靠市场来分发它自己**。

要修的话，得让 `inspectArchive` 接受并规范化 `package/` 前缀，同时让 `paths.js`/
`lib/tar.js` 的解包保持目录结构。这是一处已知限制，写在这里免得下次又踩。

---

## 8. 检查清单

**开发机（一次）**

- [ ] `node tools/pack-dist.mjs` 打出的归档，条目**都在 `package/` 下**

**每台客户端**

- [ ] `dsh plugin --profile <p> add <tgz>` 没有报错
- [ ] profile 的 `dsh.profile.bundles` 里有 `dsh-plugin-marketplace`
- [ ] `node_modules\dsh-plugin-marketplace\lib\plugin.js` **确实在 `lib\` 下**
- [ ] `MARKET_SERVICE_URL` 是**用户级**变量，指向服务器地址
- [ ] **重启过 DSH**（装完包要重启，设完变量也要重启）
- [ ] stderr **没有** `failed to import`
- [ ] 左侧栏底部看得到入口，点得开
- [ ] 安装页上显示的服务端地址是对的
