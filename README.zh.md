# dsh-plugin-market-internal

**中文** | [English](README.md)

DSH 内部插件市场：**一个私有市场服务端 + 一个 DSH 客户端插件**。

> 包名是 `dsh-plugin-market-internal`，GitHub 仓库名是 `dsh-plugin-market-selfhosted`；前者是 DSH 的安装/注册标识，后者只是仓库地址。

它不是把插件包丢进共享目录，而是提供一条受控的分发链路：管理员在服务端发布和授权，用户在 DSH 左侧栏点「内部插件市场」浏览、安装、更新；账号、权限、制品、审计数据全部在服务端，本机只负责落盘。

| 部分 | 位置 | 职责 | 权威 |
|---|---|---|---|
| **市场服务端** | `server/` | 账号 / 组 / 规则 / 会话 / 插件目录 / 制品存储 / 审计 / 统计 | **是** |
| **DSH 客户端插件** | `lib/` + `web/` | 把服务端**已授权**的插件、组合包和技能装进当前 DSH profile | 否 |

**为什么必须拆成两部分**：如果账号和权限放在每台机器上，就是一人一份 SQLite；管理员建的号别人登不上，改的规则只对自己生效，审计散在各人磁盘上——"统一管理"这个前提根本不成立。所以授权判定、制品字节和账目都在服务端，本机插件不做任何权限判断，只执行服务端允许它拉取的东西。

---

## 目录

- [安装](#安装)
- [使用场景](#使用场景)
- [实现的功能](#实现的功能)
- [架构与数据流](#架构与数据流)
- [在自己电脑上搭建](#在自己电脑上搭建)
- [日常使用](#日常使用)
- [部署到服务器](#部署到服务器)
- [运维手册](#运维手册)
- [安全设计](#安全设计)
- [测试](#测试)
- [已知限制](#已知限制)
- [排错](#排错)

---

## 安装

先部署市场服务端（本机、局域网或 Docker，见[在自己电脑上搭建](#在自己电脑上搭建)），再安装 DSH 客户端插件：

```bash
# 桌面版默认 profile 是 desktop；dsh web 用 web
dsh plugin --profile desktop add github:yanghongqiang3/dsh-plugin-market-selfhosted
```

`v*` tag 构建后会发布预构建包，也可以下载后本地安装：

```bash
dsh plugin --profile desktop add ./dsh-plugin-market-internal.tgz
```

装完设置 `MARKET_SERVICE_URL` 并重启 DSH，左侧栏底部会出现「内部插件市场」。

---

## 使用场景

- **团队内部分发 DSH 插件**：自研工具、内部集成、组合包统一从市场安装，不再手工传 `.tgz`。
- **分发技能（Skill）**：只含 `SKILL.md` 的技能包也能发布，装完几秒内进入会话目录。
- **受控发布**：默认拒绝，按组和 glob 规则授权；可以撤回（停止分发）和召回（要求客户端移除已装副本）。
- **统一升级**：客户端启动时自动检查市场自带插件的新版本；市场里的插件通过重新安装升级。
- **安装统计**：控制台按账号看"装了什么"，按制品看"安装人数 / 设备数 / 下载次数"。
- **私有化部署**：服务端零运行时依赖，可跑在本机、内网服务器或 Docker；不依赖任何外部市场。
- **可选单点登录**：DSH 账号与市场账号一对一绑定后，安装页自动取得会话，不必重复输密码。

**不适合**的用法：面向公网的商业化市场、按下载量计费、多租户 SaaS。这里没有这些能力，也不打算有。

---

## 实现的功能

### 市场服务端

- **账号与权限**
  - 账号、角色（admin / member）、权限组、组内 glob 插件规则；
  - **默认拒绝**：没有任何规则授予就装不了（管理员也一样，`E_NO_GROUP`）；
  - **deny 优先**：命中任意 deny 规则即拒绝；
  - **变更即时生效**：停用账号会吊销其全部会话，旧令牌下一个请求就是 401；
  - 密码使用 scrypt 存储，令牌只存哈希；登录失败锁定；7 天 refresh 轮换续期。
- **插件目录**
  - `/dsh-market/catalog` 列出全部制品，逐条给出 `canInstall` 与拒绝原因——看不到的插件更不可能申请权限；
  - 服务端搜索、筛选（插件 / 技能）与分页，安装页只渲染当前页。
- **发布**
  - 控制台上传 `.tar.gz` / `.tgz` / `.zip`，CLI `publish --dir` 上传或直接写库；
  - 支持 `--dry-run` 预检；默认 dry run，确认后才写入；
  - 发布状态 `draft` / `review` / `published` / `revoked`，只有 `published` 可安装；
  - 归档在写盘前检查：缺 `package.json`、非法 JSON、路径逃逸、符号链接、未知状态一律拒绝；
  - npm 布局与 zip 会被**归一化**为扁平 tar.gz 再入库，因此同一棵树永远得到同一个 sha256；
  - 只有 `SKILL.md` 的技能包也能发布，服务端自动补出 manifest。
- **制品与下载**
  - 确定性打包（mtime 固定、条目排序），发布时计算 sha256 存库；
  - 下载时服务端先重新哈希磁盘字节，不一致直接拒绝（`E_HASH_MISMATCH`）并记审计；
  - 下载接口会**再判一次权限**，无权限一个字节都不发。
- **撤回与召回**
  - 撤回（`revoked`）：停止分发，已安装副本继续工作；
  - 召回（`recalled`）：要求客户端在下次启动时移除已装副本，可撤销；
  - 支持召回单个版本或"当前所有版本"（`version: '*'`，显式快照，不是永久规则）；
  - 客户端移除后留回执（`<profile>/.dsh-market-recalled.json`），安装页顶部可见。
- **安装统计**
  - 客户端按设备上报当前安装快照（`install_devices` + `install_items`）；
  - 控制台账号行显示"已装"数量，制品行显示安装人数、设备数、下载次数，均可点开明细；
  - 口径明确：下载 ≠ 安装；未上报不等于 0。
- **身份绑定与自动登录**
  - DSH 账号 ↔ 市场账号一对一绑定，显式点击，不自动占用名额；
  - 绑定后，本机持有绑定密钥，安装页自动换会话；密钥只存哈希，退出即清本机密钥；
  - 登录仍保留为回退路径：绑定是归属记录，不是"钉死这台机器"。
- **自更新**
  - 服务端可携带市场插件自己的新版本（`publish:self`），客户端启动时比对版本，不同则替换；
  - 更新在下次启动生效；链接安装一律拒绝自动更新，避免改到开发者的工作树。

### DSH 客户端插件

- 在左侧栏底部注册原生入口 `sidebar.footer.action`，点击在系统浏览器打开安装页；折叠时自动变成图标。
- 安装 / 卸载 / 更新：
  - 安装四道关：服务端鉴权 → 双 sha256 校验 → 归档安全检查 → 按归档自称的 `dsh.bundle` 决定注册方式；
  - 组合包写入 `dsh.profile.bundles`，普通插件写入 profile patch 层的托管块；
  - 技能写入 `<profile>/.dsh-market-skills/`，通过 `ctx.skills.register` 注册，安装/卸载几秒内生效。
- 自动对账：
  - 启动时上报安装快照（`MARKET_AUTO_REPORT=0` 可关）；
  - 查询召回清单并移除被召回版本（`MARKET_AUTO_RECALL=0` 可关）；
  - 检查市场插件自身的新版本（`MARKET_AUTO_UPDATE=0` 可关）。
- **不做**任何授权判断、不保存账号/组/规则/目录，也不执行安装脚本。

### 部署方式

- Windows：`start-market.bat`
- Linux / macOS / WSL：`start-market.sh`
- 容器：`Dockerfile`（含健康检查、非 root、`/data` 卷）

---

## 架构与数据流

```
管理员 ──> 控制台 /console 或 CLI ──> 市场服务端（账号/规则/制品/审计）
                                            │
DSH 客户端插件 ── 目录 / 授权 / 下载 ────────┘
      │
      └── 解包、校验、写入当前 profile（组合包 / 插件 / 技能）
```

- **两个界面，两件事**
  - 安装页：`http://127.0.0.1:<DSH 端口>/market`，普通用户只看自己的目录并安装/卸载；
  - 控制台：`http://<服务端>:8787/console`，管理员管理账号、组、规则、发布、制品与统计。
- **两种归档，别混**
  - `tools/pack-dist.mjs`：给 DSH 安装**市场插件本身**，条目全在 `package/` 下；
  - `server/lib/pack.js`：市场登记的**制品**，扁平布局（`package.json` 在根部），上传时会把 `package/` 前缀剥掉。
- **数据位置**
  - 默认 `<仓库>/.market/`：`market.db`（SQLite，WAL）+ `artifacts/`（制品字节）；
  - `MARKET_DATA_DIR` / `MARKET_DB` / `MARKET_STORAGE` 可覆盖；Docker 中固定为 `/data`。
- **目录结构**

```
server/                 市场服务端（零运行时依赖）
├── index.mjs           启动入口 + 首次引导
├── cli.mjs             运维 CLI / 发布客户端
└── lib/                db、crypto、store、policy、artifacts、http、pack、layout、version
lib/                    DSH 客户端插件
├── bundle.js           裸包名入口（导出 apply）
├── plugin.js           宿主行：下载、校验、解包、注册、/market 与本地路由
├── client.js           客户端半边：注册侧栏入口
└── tar.js              受限 tar 读取（拒绝符号链接与路径逃逸）
web/                    两个界面 + 共用资源（无构建步骤）
tools/                  测试、契约预检、打包、只读诊断脚本
cordis.patch.yml        patch 层：宿主行 + 客户端行
start-market.bat        Windows 启动脚本
start-market.sh         Linux / macOS / WSL 启动脚本
Dockerfile              服务端镜像
```

---

## 在自己电脑上搭建

以下步骤在一台机器上完成即可：服务端监听 `127.0.0.1:8787`，DSH 客户端插件指向它。

### 0. 前置条件

- **Node ≥ 22.5**（服务端使用内置 `node:sqlite`）：`node --version`
- **DSH 已安装**，并且 `dsh` CLI 可用（`dsh --version`）
- 端口 `8787` 空闲
- 所有命令都在仓库根目录执行

### 1. 启动服务端

**Windows**

```powershell
.\start-market.bat
```

**Linux / macOS / WSL**

```bash
chmod +x start-market.sh
./start-market.sh
```

**Docker**

```bash
docker build -t dsh-plugin-market-internal .
docker run -d --name dsh-market \
  -p 8787:8787 \
  -v dsh-market-data:/data \
  dsh-plugin-market-internal
docker logs dsh-market
```

首次启动会自动创建数据库和初始管理员：

```
username  admin
password  dsh-admin
```

该账号首次登录必须改密。健康检查：`GET /dsh-market/health`。

Windows 与 Linux/macOS 启动脚本的参数一致：

| 参数 | 作用 |
|---|---|
| `--port 9000` | 换端口 |
| `--host 0.0.0.0` | 允许内网其他机器访问（开发用；生产见 Docker/反代一节） |
| `--data /var/lib/dsh-market` | 换数据目录 |
| `--check` | 只检查 Node、目录和权限，不启动 |

### 2. 初始化账号和权限

打开控制台：`http://127.0.0.1:8787/console`，用 `admin / dsh-admin` 登录并按提示改密。

然后创建权限组、规则和用户。规则是 **glob 模式**，不是"插件 → 组"的映射；加一条 `@dsh-internal/*` 后，以后发布的匹配插件自动对组成员可用。

```bash
node server/cli.mjs group:add  --id billing --description "计费组"
node server/cli.mjs grant:add  --group billing --pattern "@dsh-internal/*"
node server/cli.mjs user:add   --username alice --password "<至少12位的密码>" --groups billing
node server/cli.mjs member:add --user admin --group billing
node server/cli.mjs user:list
```

也可以在控制台里完成同样的操作。注意**默认拒绝**：没有组和规则，连 admin 也装不了，目录里会显示 `canInstall: false` 和原因。

发布权限属于 admin：普通成员只能浏览和安装。

### 3. 打包并安装 DSH 客户端插件

```bash
node tools/pack-dist.mjs
```

它会打印输出路径，通常是 `dist/dsh-plugin-market-internal-<version>.tgz`，然后把它装进你实际使用的 profile：

```bash
dsh plugin --profile desktop add "./dist/dsh-plugin-market-internal-<version>.tgz"
```

（路径以 `node tools/pack-dist.mjs` 打印的为准。）

> **profile 要对。** 桌面版默认用 `desktop`；`dsh web` 默认用 `web`。两个 profile 的
> `node_modules`、patch 层、技能目录互不共享——装进一个不会出现在另一个里。每个要用的
> profile 各装一次，或者固定只用一个 profile。

> **给其他同事安装时不需要仓库**：把 `dist/*.tgz` 发给他，他执行一次
> `dsh plugin --profile <profile> add <tgz>`，设置 `MARKET_SERVICE_URL` 后重启 DSH 即可；
> 之后的版本由市场自更新跟上。

### 4. 配置服务端地址并重启 DSH

客户端插件在启动时读一次 `MARKET_SERVICE_URL`，**必须设为用户级变量**（从开始菜单启动 DSH 时只继承用户级/系统级变量）：

**Windows**

```powershell
[Environment]::SetEnvironmentVariable('MARKET_SERVICE_URL', 'http://127.0.0.1:8787', 'User')
```

**Linux / macOS**

```bash
# 写进 ~/.profile 或 ~/.bashrc
export MARKET_SERVICE_URL=http://127.0.0.1:8787
```

然后**重启 DSH**。左侧栏底部会出现「内部插件市场」按钮；点击在系统浏览器打开安装页，也可以直接访问 `http://127.0.0.1:<DSH 端口>/market`。

### 5. 验证安装

- 侧栏入口出现、点得开；
- 安装页顶部显示的服务端地址正确；
- `~/.dsh/plugin-marketplace-diag.log` 里有 `[profile]`、`[register]`、`[skills]` 行；
- DSH stderr 没有 `failed to import`。

如果看到 `failed to import`，先检查 `node_modules/dsh-plugin-market-internal/lib/plugin.js` 是否真的在 `lib/` 下；文件扁平地躺在包根，说明归档没用 `package/` 前缀，重新跑 `node tools/pack-dist.mjs`。

### 6. 发布第一个插件

插件包最少需要一个 `package.json`（含 `name`、`version`）。可选的 `market.json` 提供市场元数据：

```json
{
  "summary": "计费插件",
  "owner": "billing",
  "channel": "stable",
  "dsh": ">=0.2.0-rc.2 <0.3",
  "state": "published"
}
```

先用 admin 登录并预检、发布：

```bash
node server/cli.mjs login --username admin --service http://127.0.0.1:8787
node server/cli.mjs publish --dir ./my-plugin --dry-run
node server/cli.mjs publish --dir ./my-plugin
```

也可以直接在控制台的发布表单上传 `.tar.gz` / `.tgz` / `.zip`。

技能包更简单：一个 `SKILL.md`（frontmatter 里要有 `name`、`description`）即可；建议在 frontmatter 里写 `version`，否则版本固定为 `0.1.0`，重发不会让已安装的人看到"更新"。

### 7. 在 DSH 里安装、更新、卸载

1. 打开「内部插件市场」，用市场账号登录（也可以先绑定 DSH 账号，之后自动登录）；
2. 在目录里点「安装」，确认后等待完成；
3. **插件和组合包要重启 DSH 才生效**，技能几秒内生效；
4. 更新 = 发布更高的版本号，再在安装页点「更新到 X」重新安装；更新是整目录替换，旧版本删掉的文件不会残留；
5. 卸载在安装页完成。

---

## 日常使用

### 发布与版本

- 发布前先 `--dry-run`，预检会告诉你类型、包名、版本、归一化后的 sha256；
- **更新必须提高版本号**。内容变了但版本没变，只是覆盖同一版本，已安装的人不会看到更新；
- `--state draft` 可以先发草稿，确认后再改为 `published`；`revoked` 会立即停止分发；
- CLI 和上传走同一套校验，不会出现"本地能发、上传被拒"。

### 撤回 vs 召回

| 动作 | 作用 | 够不到的地方 |
|---|---|---|
| 撤回（`revoked`） | 停止分发，目录不再出现，有权限也下载不到 | 已装副本继续工作 |
| 召回（`recalled`） | 要求客户端移除已装副本，可撤销 | 离线或不再启动 DSH 的机器 |

召回版本会被精确匹配（`1.0.0` 不会误删 `1.1.0`）；"全部版本"是执行那一刻的快照，之后发布的新版本不受影响。客户端移除后会在安装页留一条回执。

### 安装统计

控制台里：

- 账号行的「已装」= 该账号当前安装数量，点数字看明细；
- 制品行的「安装人数 / 下载次数」：安装人数按账号去重，可点开看账号列表；下载次数来自服务端下载审计。

读数字时记住：**下载 ≠ 安装**；未上报的机器不会出现在统计里（显示 `—` 或 `0` 不代表没装）；不保留历史安装事件；设备行目前没有 TTL。

### DSH 账号绑定

在安装页点「绑定」才会建立一对一关系；绑定成功后可以启用自动登录，之后打开安装页不再输密码。解绑由用户自己在安装页完成，不需要管理员。绑定是归属记录，不是使用限制：知道密码的人仍可在别处登录该市场账号。

### 市场插件自身的升级

开发机改版本号后：

```bash
node tools/pack-dist.mjs
node server/cli.mjs publish:self --archive dist/dsh-plugin-market-internal-<version>.tgz
```

服务端不需要重启，下一次客户端启动会自动换上（**重启 DSH 后生效**）。服务器上没有这个仓库时，也可以在服务器上用 `publish:self --dir .` 自行打包。

---

## 部署到服务器

### 局域网（不用 Docker）

```bash
./start-market.sh --host 0.0.0.0 --data /var/lib/dsh-market
```

其他机器的 DSH 设置：

```
MARKET_SERVICE_URL=http://<服务器IP>:8787
```

`MARKET_CALLBACK_HOST` 用来告诉服务和日志"客户端实际用什么地址访问"，反向代理或内网域名部署时应显式设置。

### Docker

镜像**只包含市场服务端**，不含 DSH 客户端插件；客户端插件仍然用 `dsh plugin add` 安装，并通过 `MARKET_SERVICE_URL` 指向这个服务。

```bash
docker build -t dsh-plugin-market-internal .

docker run -d --name dsh-market \
  -p 8787:8787 \
  -v dsh-market-data:/data \
  -e MARKET_CALLBACK_HOST=market.example.com \
  dsh-plugin-market-internal
```

- 数据全在 `/data`：SQLite 数据库 + 制品字节。备份时作为一个整体备份；只备份数据库而没有制品，已发布的插件无法安装。
- 用宿主机目录代替命名卷时，目录必须可被容器内 `node` 用户（uid 1000）写入：

  ```bash
  mkdir -p ./market-data && chown -R 1000:1000 ./market-data
  docker run -d -p 8787:8787 -v "$PWD/market-data:/data" dsh-plugin-market-internal
  ```

- 如果 Docker Hub 不可达，可以换基础镜像源构建：

  ```bash
  docker build \
    --build-arg NODE_IMAGE=<镜像源>/library/node:24-alpine \
    -t dsh-plugin-market-internal .
  ```

- 服务端本身只说 HTTP。对公网/企业网关部署时，把它放在 HTTPS 反向代理后面，然后让客户端把 `MARKET_SERVICE_URL` 指向 https 地址。
- 镜像内置健康检查（`/dsh-market/health`），`docker inspect` 可看状态。

### 组件之间的对应关系

| 组件 | 部署在哪 | 客户端怎么找到它 |
|---|---|---|
| 市场服务端 | 服务器 / 本机 / 容器 | `MARKET_SERVICE_URL` |
| DSH 客户端插件 | 每个 DSH profile 的 `node_modules` | 由 `dsh plugin add` 注册到 profile |
| 安装页 | DSH 宿主的 `/market` 路由 | 侧栏按钮或 `http://127.0.0.1:<DSH 端口>/market` |
| 控制台 | 服务端 `/console` | 浏览器直接访问服务端地址 |

---

## 运维手册

### 环境变量

**服务端**

| 变量 | 默认 | 说明 |
|---|---|---|
| `MARKET_HOST` | `127.0.0.1` | 监听地址；Docker 中为 `0.0.0.0` |
| `MARKET_PORT` | `8787` | 监听端口 |
| `MARKET_DATA_DIR` | `<仓库>/.market` | 数据目录；Docker 中为 `/data` |
| `MARKET_DB` | `<数据目录>/market.db` | 覆盖数据库文件 |
| `MARKET_STORAGE` | `<数据目录>/artifacts` | 覆盖制品目录 |
| `MARKET_CALLBACK_HOST` | `127.0.0.1` | 对外访问地址提示（反向代理/内网部署时设置） |
| `MARKET_MAX_UPLOAD_BYTES` | `67108864`（64 MiB） | 发布归档大小上限 |

**客户端**

| 变量 | 默认 | 说明 |
|---|---|---|
| `MARKET_SERVICE_URL` | 无（必填） | 市场服务端地址；不设时安装页显示"未配置市场服务端" |
| `MARKET_SERVICE_TIMEOUT_MS` | `30000` | 请求超时 |
| `DSH_PROFILE_DIR` | 自动检测 | 开发时链接安装可显式指定 profile |
| `MARKET_AUTO_UPDATE` | 开 | `0` 关闭市场插件自更新 |
| `MARKET_AUTO_REPORT` | 开 | `0` 关闭安装快照上报 |
| `MARKET_AUTO_RECALL` | 开 | `0` 关闭召回对账 |

### 常用 CLI

```bash
node server/cli.mjs bootstrap
node server/cli.mjs user:add   --username alice --password '<密码>' --groups billing [--admin]
node server/cli.mjs user:list
node server/cli.mjs user:pass   --username alice --password '<新密码>' --no-must-change
node server/cli.mjs user:status --username alice --status disabled
node server/cli.mjs group:add  --id billing --description "计费组"
node server/cli.mjs grant:add  --group billing --pattern "@dsh-internal/*" [--deny]
node server/cli.mjs grant:rm   --group billing --pattern "@dsh-internal/*"
node server/cli.mjs member:add --user alice --group billing
node server/cli.mjs bind:list
node server/cli.mjs bind:rm    --user alice
node server/cli.mjs catalog | audit [--limit 50] | installs [--limit 20] | prune
```

### 备份与迁移

1. 停服务端（或至少停写）；
2. 整体复制 `MARKET_DATA_DIR`（数据库 + `artifacts/`）；
3. 迁移到新机器后把 `MARKET_DATA_DIR` 指过去即可，账号、规则、制品和统计都在一起。

### 改了什么要重启什么

| 改动 | 生效方式 |
|---|---|
| `server/**` | 重启服务端 |
| `web/console.html`、`web/console.css` | 重启服务端（控制台由服务端提供） |
| `lib/**`、`cordis.patch.yml`、`package.json`、`web/market.*`、`web/shared.js` | 重新 `pack-dist` → 各客户端重装（或等自更新）→ 重启 DSH |
| 市场里的插件/技能制品 | 无需重启服务端；重新安装或等客户端更新 |

### 服务端长期运行

- Windows：可以放到任务计划程序，登录时启动 `start-market.bat`；
- Linux：交给 systemd、supervisor 或 Docker 的 `restart` 策略；
- Docker：`docker run` 时加 `--restart unless-stopped`。

---

## 安全设计

- **服务端是唯一权威**：客户端不做授权判断，只执行服务端返回的判定和字节。
- **默认拒绝 + deny 优先**：没有规则就不能装；停用账号立即吊销会话。
- **制品可信链**：确定性 tar.gz + sha256；下载前服务端重算哈希；客户端再按调用方和响应头两次校验。
- **归档安全**：只接受常规文件与目录，拒绝符号链接/设备文件，拒绝路径逃逸；解包在暂存目录完成后再落位。
- **不执行安装脚本**：市场只放文件、写注册，不运行包里的脚本。
- **写接口同源校验**：本机插件的安装/卸载/绑定写入只接受 DSH 自己的 Origin，防本机浏览器里的其他网页发起 CSRF。
- **路径包含检查**：所有写入/删除目标都必须落在 profile 或技能目录内；包名经过统一正则校验。
- **凭据**：密码用 scrypt；会话令牌与绑定密钥只存哈希；绑定密钥落在 profile 内权限 `0600`；解绑即失效。丢弃机器前先解绑。
- **传输**：服务端本身是 HTTP；跨机器或公网部署时放在 HTTPS 反向代理后面。

---

## 测试

```bash
node tools/run-all.mjs                 # 全部套件
node tools/run-all.mjs server          # 只跑名字匹配的套件
node tools/test-host.mjs               # 宿主入口与路由契约
node tools/test-server.mjs             # 服务端：登录/权限/发布/下载/哈希/审计
node tools/test-publish.mjs            # 发布上传：预检/归档/状态流转
node tools/verify-install.mjs "$HOME/.dsh/profiles/desktop"   # 已安装 profile 的契约预检
```

`run-all.mjs` 会把"没有输出 `RESULT:` 行"的套件也判为失败——一个什么都没输出的测试不是通过的测试。

---

## 已知限制

- **桌面端与 Web 端是两个 profile**：`desktop` 与 `web` 的 `node_modules`、patch、技能目录互不共享，各装一次；想只维护一份就让 Web 端也用 `desktop`（`dsh --profile desktop web`）。
- **统计是客户端自述**：未绑定、从未上报的机器没有数据；不保存历史事件；设备行不过期；共享设备的归属是"最近一次上报的账号"。
- **召回够不到离线机器**：拉取式客户端无法被强制，这是模型限制。
- **更新要重启**：插件和组合包的更新、市场插件自更新都在下次启动生效；技能不需要。
- **链接安装不自动更新**：`node_modules` 下是链接时拒绝改写，避免改到开发者工作树。
- **技能卸载后的 `/` 提示**：DSH 客户端按会话缓存技能列表，卸载后提示要新会话或重启才消失（模型侧已即时生效）。
- **没有开机自启**：服务端是前台进程，需要系统服务/Docker/计划任务托管。
- **服务端未做多租户**：一套部署就是一个组织的市场。

---

## 排错

| 现象 | 先查什么 |
|---|---|
| 安装页显示"未配置市场服务端" | `MARKET_SERVICE_URL` 是否设为**用户级**变量，是否重启了 DSH |
| `E_SERVICE_UNREACHABLE` / `E_SERVICE_TIMEOUT` | 服务端是否在跑、地址/端口是否正确、防火墙是否放行 |
| `failed to import` | 客户端包是否用 `tools/pack-dist.mjs` 打的（条目必须在 `package/` 下） |
| 目录里能看到插件但装不了 | 账号是否在组里、组是否有匹配的 allow 规则；看 `reason`（如 `E_NO_GROUP`） |
| 登录被拒 `E_MUST_CHANGE_PASSWORD` | 初始密码未改；先在控制台或 `cli.mjs passwd` 改密 |
| 别的机器连不上 | 服务端是否 `--host 0.0.0.0`，端口是否放行，`MARKET_CALLBACK_HOST` 是否指向可访问地址 |
| 改完服务端没变化 | 改的是 `server/**` / `web/console.*` 吗？重启服务端；改的是客户端文件则要重打包并重启 DSH |
| Docker 写 `/data` 失败 | 绑定宿主机目录时确认 uid 1000 可写（`chown -R 1000:1000`） |
| 安装统计没有数字 | 客户端是否绑定并上报；`MARKET_AUTO_REPORT` 是否被关 |

诊断日志：`~/.dsh/plugin-marketplace-diag.log`（客户端侧）。
