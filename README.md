<img src="docs/assets/overview.png" width="100%" alt="aBridge connects agents to macOS and browsers through MCP; Windows and Android are planned." />

aBridge 希望解决的是我们的云端Agent 所面临的用户 Profile 缺失的问题，希望通过这个工具可以接入用户的多台设备、浏览器（操作OA系统、填写表单、复用登录状态）。

aBridge 本身分为**服务端和客户端**，服务端负责连接安装在用户设备上的客户端，**同时对外暴露 MCP 服务**，MCP服务的鉴权分为 Token 和 OAuth 两种。可以接入 Codex、OpenCode、Zcode。

aBridge 可以和 [Yuxi](https://github.com/xerrors/Yuxi)一起部署，使用 **Yuxi 的账户体系**认证，同时不需要对外暴露额外的 IP 和端口，Yuxi 和 aBridge 使用**容器内网络通信**。

| 客户端                  | 能力                       | 运行环境                   |
| ----------------------- | -------------------------- | -------------------------- |
| **aBridge App**         | 屏幕、键鼠、Shell、文件    | Apple Silicon，macOS 14+   |
| **aBridge for Browser** | 网页观察、导航、点击和填充 | Chromium 扩展，Chrome 116+ |


[GitHub Releases](https://github.com/xerrors/aBridge/releases) 提供 Server tarball、浏览器 ZIP 和 macOS 包。

## 部署 Server

### Docker（推荐）

```sh
docker run -d \
  -p 8765:8765 \
  -v abridge-data:/data \
  ghcr.io/xerrors/abridge:0.4.12
```

本机访问 [http://127.0.0.1:8765](http://127.0.0.1:8765)。数据和管理员凭据保存在 `abridge-data` 命名卷中，重建容器时复用该卷。

远程部署需设置 `ABRIDGE_PUBLIC_ORIGIN`，推荐通过 HTTPS/WSS 反向代理访问。首次管理员登录、创建账户及升级步骤见 [Docker 部署](docs/deployment.md#docker-镜像)；更新时保留数据卷。

### npx

需要 Node.js 22.13.0+ 与 npm，无需 Docker。公共 npm 包尚未发布，目前直接使用 GitHub Release tarball：

```sh
npx --yes \
  --package=https://github.com/xerrors/aBridge/releases/download/v0.4.12/xerrors-abridge-0.4.12.tgz \
  abridge --web
```

默认监听 `127.0.0.1:8765`；`--web` 打开本机管理员链接。数据保存在系统用户数据目录，可用 `--data-dir` 指定持久目录。

状态目录、端口、管理员 API、HTTPS 反向代理和无图形环境配置见 [安装与维护](docs/deployment.md)。

## 安装客户端

### 浏览器扩展

推荐从 [Chrome 应用商店安装 aBridge for Browser](https://chromewebstore.google.com/detail/abridge-for-browser/jbkhngckehhhhkbgpjlifbbchhbeodjc)。安装扩展后仍需连接自己的 aBridge Server。

点击扩展图标，填写 Server 地址并完成授权，再在管理台将设备加入 Agent 连接。每个 Profile 独立注册；浏览器退出时设备离线，扩展不能自行启动浏览器。源码加载与使用说明见 [浏览器客户端](docs/browser-profile-design.md)。

### macOS App

从 [GitHub Releases](https://github.com/xerrors/aBridge/releases) 下载 Apple Silicon 包。当前使用 ad hoc 签名且未公证；源码构建与安装见 [安装与维护](docs/deployment.md#macos-app)。

填写 Server 地址并完成授权后，启用所需能力。屏幕与键鼠操作还需为实际安装的 App 授予录屏和辅助功能权限。

## MCP 接入

在管理台创建 Agent 连接并授权设备与能力，将生成的 Agent Key 填入支持 Streamable HTTP 的 MCP 客户端：

```json
{
  "url": "http://127.0.0.1:8765/mcp",
  "headers": { "Authorization": "Bearer <AGENT_KEY>" }
}
```

按 `devices_list` → `session_open` → 工具操作 → `session_close` 使用。Device Key 用于设备连接，Agent Key 用于 MCP 调用，两者不可互换；实际可用能力仍受设备授权、本机开关和系统权限限制。

| 范围       | 工具                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| 设备与会话 | `devices_list`、`device_get`、`session_open`、`session_close`                                    |
| 桌面       | `computer_open`、`computer_apps`、`computer_windows`、`computer_observe`、`computer_act`         |
| 浏览器     | `browser_open`、`browser_observe`、`browser_act`、`browser_read`、`browser_wait`、`browser_exec` |
| Shell      | `command_execute`、`command_status`、`command_cancel`                                            |
| 文件       | `files_list`、`file_read`、`file_write`                                                          |

导航和动作返回下一步可使用的观察；短命令直接返回输出，长命令才需继续等待。接口时效、分页和失败语义见 [架构与执行契约](docs/architecture.md)。
