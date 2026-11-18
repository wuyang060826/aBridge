# aBridge

**通过 MCP，让 Agent 操作你授权的电脑、Android 手机和浏览器。**

[快速开始](#快速开始) · [客户端](#3-连接设备) · [GitHub Releases](https://github.com/xerrors/aBridge/releases/latest) · [评测与验证](#agent-benchmark) · [Yuxi 集成](#与-yuxi-一起使用) · [文档](#文档)

## 解决什么问题

aBridge 把设备上的应用、文件和浏览器会话接入 MCP。你可以按 Agent 分配设备和能力：

- **操作 OA 与业务系统**：复用浏览器 Profile 的登录态，查找信息和填写网页表单。
- **处理桌面与服务器任务**：在 Mac 上观察并操作桌面，或在已授权的 Mac 和 Linux 设备上运行 Shell、读写文件。
- **操作 Android 应用**：通过预览版观察屏幕、点按、滑动和输入文本，在授权目录中读写文件。

## 工作方式

![Agent 通过 MCP 连接 aBridge Server，macOS、Linux、Android 和浏览器客户端分别通过 WebSocket 连接 Server。](docs/assets/architecture.svg)

Server 提供 MCP、账户、设备授权和会话管理。各客户端独立安装、授权并直接连接 Server。每个浏览器 Profile 对应一个设备，扩展在该 Profile 中为任务创建独立标签页。

## 快速开始

独立使用按以下四步完成：**部署 Server → 创建账户 → 连接设备 → 配置 Agent**。已有 Yuxi 的用户可先看 [Yuxi 集成](#与-yuxi-一起使用)。

### 1. 部署 Server

最新正式 [GitHub Release 为 0.4.18](https://github.com/xerrors/aBridge/releases/tag/v0.4.18)。Server 通过 Release 的 tarball 运行，需要 npm 和 Node.js 22.x（22.13 起）、23.x（23.4 起）或 24 及以上版本：

```sh
npm exec --yes \
  --package=https://github.com/xerrors/aBridge/releases/download/v0.4.18/xerrors-abridge-0.4.18.tgz \
  -- abridge --web
```

默认监听 [127.0.0.1:8765](http://127.0.0.1:8765)。`--web` 在本机打开实例管理页面，可通过 `--data-dir` 指定持久目录。

<details>
<summary>使用 Docker</summary>

下面使用已发布的 **0.4.17** 镜像，支持 Linux amd64 和 arm64：

```sh
docker run -d --name abridge --restart unless-stopped \
  -p 127.0.0.1:8765:8765 \
  -v abridge-data:/data \
  -e ABRIDGE_PUBLIC_ORIGIN=http://127.0.0.1:8765 \
  ghcr.io/xerrors/abridge:0.4.17
```

镜像版本单独发布。更新时复用 `abridge-data` 卷。通过 [GHCR 镜像列表](https://github.com/xerrors/aBridge/pkgs/container/abridge) 查询可用标签。

</details>

跨机器连接时，设备和 Agent 都需要能访问 Server。请设置对外的 `ABRIDGE_PUBLIC_ORIGIN`，并配置支持 WebSocket 的 HTTPS 反向代理。[部署与源码运行](docs/deployment.md)

### 2. 创建账户

首次启动会生成实例管理员 Token。使用上面的 Docker 示例时，在本机终端获取管理员链接：

```sh
docker exec abridge node -e '
const fs = require("node:fs");
const token = fs.readFileSync("/data/server.db.admin-token", "utf8").trim();
console.log(process.env.ABRIDGE_PUBLIC_ORIGIN + "/#admin_token=" + encodeURIComponent(token));
'
```

该链接包含管理员凭据，请勿分享。打开链接，在“实例管理”中创建普通账户，再以普通账户登录管理台，管理自己的设备和 Agent 连接。**实例管理员身份不代替普通账户，也不授予设备操作权限。**

### 3. 连接设备

按需安装客户端，并填写设备可以访问的 Server 地址。

| 客户端           | 能力与要求                                                    | 安装与连接                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **浏览器扩展**   | 网页观察、导航、点击、填表、执行浏览器代码。Chrome 116+。     | 从 [Chrome 应用商店](https://chromewebstore.google.com/detail/abridge-for-browser/jbkhngckehhhhkbgpjlifbbchhbeodjc) 安装扩展，通过浏览器授权。                                      |
| **macOS App**    | 屏幕观察、键鼠、Shell、UTF-8 文件。Apple Silicon，macOS 14+。 | 从 [GitHub Release](https://github.com/xerrors/aBridge/releases/tag/v0.4.18) 下载 macOS ZIP，通过浏览器授权，并在系统设置授予所需权限。                                             |
| **Linux CLI**    | Shell、UTF-8 文件、systemd 后台运行。Linux amd64 / arm64。    | 从 [GitHub Release](https://github.com/xerrors/aBridge/releases/tag/v0.4.18) 下载对应架构的包，用管理台签发的 Device Token 绑定。[安装说明](apps/linux-client/README.md#安装与绑定) |
| **Android 预览** | 屏幕观察、触摸、文本输入、授权目录读写。Android 13+。         | 从当前源码构建 APK 和配套 Server，用 Device Key 绑定并在 Android 设置开启无障碍。[构建与绑定](apps/android/README.md)                                                               |

0.4.18 的 macOS ZIP 使用 ad hoc 签名。Android 预览已合入 main，请从同一份源码构建 APK 和支持设备时间握手的 Server。[macOS 安装](docs/deployment.md#macos-app) · [扩展源码安装](docs/browser-profile-design.md)

### 4. 配置 Agent

在管理台创建 **Agent 连接**，选择允许访问的设备、能力与有效期。将生成的 **Agent Key** 配入支持 Streamable HTTP 的 MCP 客户端；Codex、OpenCode、ZCode 等客户端的具体配置入口以各自文档为准。

以下是 MCP 连接参数；不同客户端的外层配置格式可能不同：

```json
{
  "url": "http://127.0.0.1:8765/mcp",
  "headers": { "Authorization": "Bearer <AGENT_KEY>" }
}
```

云端 Agent 需将示例地址换成它可以访问的 Server 地址。连接后按 `devices_list` → `session_open` → 工具操作 → `session_close` 使用。

## 与 Yuxi 一起使用

aBridge 可以与 [Yuxi](https://github.com/xerrors/Yuxi) 一起部署，复用 Yuxi 的账户体系；通过 Yuxi 的对外入口及容器内部网络集成，无需为 aBridge 单独开放公网端口。设备仍连接到部署中为 aBridge 配置的可达地址。

两种接入路径的区别：

| 路径          | 账户登录           | MCP 调用认证                               |
| ------------- | ------------------ | ------------------------------------------ |
| **独立使用**  | 管理员创建本地账户 | 管理台生成的 Agent Key                     |
| **Yuxi 集成** | OIDC 单点登录      | 显式启用平台委托后，由平台签发短期委托令牌 |

OIDC 登录本身不授予 MCP 调用权限，浏览器 ID Token 也不能直接作为 MCP 访问令牌。平台连接仍受用户设备授权、本机开关与系统权限限制。部署参数、回调地址及容器内认证请求配置见 [OIDC 登录与平台 MCP 委托](docs/deployment.md#可选-oidc-登录与平台-mcp-委托)。

## Agent Benchmark

评测结果按客户端和任务集记录。各套件使用自己的任务、种子和预算，完整数据与测量版本见报告。

<!-- benchmark:coverage:start -->

| 客户端           | 公开 Agent 任务                                            | 已验证的范围                                            | 证据                                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chrome 扩展**  | MiniWoB++ **12/12**                                        | 实际 Chrome 扩展，6 类网页任务                          | [方法](docs/benchmarks/miniwob.md) · [数据](docs/benchmarks/miniwob-v2-results.json)                                                                                 |
| **Android 预览** | AndroidWorld 回归 **15/15（100%）**；挑战 **15/30（50%）** | Android 13 模拟器，覆盖文件管理、笔记和跨应用任务       | [方法](docs/benchmarks/android-world.md) · [回归数据](docs/benchmarks/android-world-results.json) · [挑战数据](docs/benchmarks/android-world-challenge-results.json) |
| **macOS App**    | 暂无公开任务分数                                           | 原生 App 构建、设备连接与执行回归                       | [原生验证](tools/README.md)                                                                                                                                          |
| **Linux CLI**    | 暂无公开任务分数                                           | amd64 / arm64 CI，真实 Server 联调覆盖 Shell 和文件工具 | [Linux 验证](apps/linux-client/README.md)                                                                                                                            |

<!-- benchmark:coverage:end -->

<details>
<summary>Chrome MiniWoB++ 逐题结果、耗时与复现</summary>

<!-- benchmark:miniwob:start -->

真实 **gpt-6.1-sol（medium）Agent** 通过 aBridge 完成公开 MiniWoB++ 任务：**12/12（100.0%）**。任务、种子和预算在跑分前冻结，无重试，全部结果保留。

同模型目录与评测器的基线 **5/12** → 修复后 **12/12**；模型、任务 prompt、seed 0/1 和预算不变。基线已包含真实浏览器启动修复；两侧均固定同一份现有模型元数据，避免目录刷新超时。另用额外 seed=2 验证：**6/6**，单独统计。标准审核剔除 **0** 例。

![浏览器工具优化前后对照](docs/benchmarks/miniwob-v2-comparison.svg)

| 任务                     | 修复前 | 修复后 | Agent P50（秒） | 工具调用总数 | 已知输入 / 输出 tokens | 用量覆盖 |
| ------------------------ | ------ | ------ | --------------- | ------------ | ---------------------- | -------- |
| `form-sequence-3`        | 2/2    | 2/2    | 72.0            | 12           | 417797 / 858           | 2/2      |
| `email-inbox-forward-nl` | 0/2    | 2/2    | 84.8            | 10           | 384893 / 1028          | 2/2      |
| `book-flight`            | 0/2    | 2/2    | 146.1           | 23           | 852591 / 1711          | 2/2      |
| `navigate-tree`          | 0/2    | 2/2    | 42.7            | 4            | 194238 / 498           | 2/2      |
| `click-menu-2`           | 2/2    | 2/2    | 60.1            | 8            | 321924 / 812           | 2/2      |
| `multi-layouts`          | 1/2    | 2/2    | 66.0            | 10           | 361814 / 820           | 2/2      |

每例限 180 秒 / 40 次工具调用，并发 2；仅开放观察、读取、操作、等待，支持 DOM 与截图，不开放 JS 执行、源码直接读取或判分接口。P50 包含 CLI 启动和模型调用，已启动的失败也计时。表中 token 为已知样本合计（输入含缓存），超时未返回用量视为未知，不能按 0 计费；CLI 不提供实际美元账单。

失败分类：无。用量覆盖 12/12；会话清理 12/12。

模型元数据通过CLI本地目录参数固定，未改全局配置、模型或任务prompt；这不消除网络和模型响应波动。失败全部保留，不能仅凭小样本宣称稳定速度或成本优势。

模型目录 SHA-256：578e4bab76fbd3999747b7d3c8c34b83a4cdbef4a3bd033f21f0399e094f1c3d；逐字复制实际缓存的元数据，不修改模型指令或能力。

测量快照：v0.4.16 / c02c42b。环境：Apple M4 / darwin arm64 / Chrome/153.0.8010.12 / Node v22.23.5 / codex-cli 0.166.0；记录时间 2026-11-18T02:07:05.629Z。

这是 **6 类任务、每类 2 个种子的小样本适配子集**，原始任务限时统一延长至 180 秒，不是官方榜单成绩；单次前后对照仍有模型随机性，也不能单独证明 aBridge 优于其他工具或覆盖 macOS App。固定策略的 30/30 仅作为执行链冒烟历史数据，与 Agent 分数分开。[方法与限制](docs/benchmarks/miniwob.md) · [工具修复报告](docs/benchmarks/browser-reliability-v2.md) · [全量报告](docs/benchmarks/cases-all.md) · [标准审核报告](docs/benchmarks/cases-conforming.md) · [逐次实测数据](docs/benchmarks/miniwob-v2-results.json)。

```sh
npm run benchmark:miniwob
```

<!-- benchmark:miniwob:end -->

</details>

### AndroidWorld

两台 Pixel 6 / Android 13 模拟器负责运行公开任务。Agent 通过 Android 客户端观察和操作，AndroidWorld 生成数据并独立判分。回归集覆盖文件管理与笔记编辑，挑战集增加了跨应用录入和长流程任务。独立的直接文件接口验收 **3/3**，单列于 [AndroidWorld 报告](docs/benchmarks/android-world.md)。

## 授权与安全边界

- **设备与能力显式授权**：每个 Agent 连接可选择设备、能力和有效期；设备本机可以暂停或关闭能力，自动重连不会解除这些限制。
- **凭据各司其职**：Admin Token 用于实例管理，Device Key 用于设备连接，Agent Key 用于 MCP 调用，三者不能互换。
- **沿用用户的执行环境**：浏览器脚本具有当前站点登录用户的页面权限；Shell 与文件工具在已授权设备上执行。请按任务分配所需能力。
- **未知操作不盲目重放**：断连或超时可能发生在副作用之后；应查询原操作状态、重新观察，再决定下一步。撤销权限不能回滚已执行的操作。

## 文档

| 文档                                           | 内容                                             |
| ---------------------------------------------- | ------------------------------------------------ |
| [安装与维护](docs/deployment.md)               | Docker、Node.js、App、反向代理、升级与 OIDC 配置 |
| [架构与执行契约](docs/architecture.md)         | 模块职责、工具接口、会话、去重、取消与结果语义   |
| [浏览器客户端](docs/browser-profile-design.md) | Profile 授权、任务标签、网页工具及浏览器代码接口 |
| [Server API](apps/server/README.md)            | 管理员接口、Server 运行方式与分发说明            |
| [贡献指南](.github/CONTRIBUTING.md)            | 开发环境、检查命令与提交规范                     |

[下载发布产物](https://github.com/xerrors/aBridge/releases) · [报告问题](https://github.com/xerrors/aBridge/issues) · [Apache-2.0 许可证](LICENSE)
