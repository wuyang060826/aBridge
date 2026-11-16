<img src="docs/assets/overview.png" width="100%" alt="aBridge connects agents to macOS and browsers through MCP; Windows and Android are planned." />

通过 MCP，让 Agent 使用你授权的电脑和浏览器。

| 客户端                  | 能力                       | 运行环境                   |
| ----------------------- | -------------------------- | -------------------------- |
| **aBridge App**         | 屏幕、键鼠、Shell、文件    | Apple Silicon，macOS 14+   |
| **aBridge for Browser** | 网页观察、导航、点击和填充 | Chromium 扩展，Chrome 116+ |

两种客户端独立注册为设备并连接 Server。浏览器扩展复用当前 Profile 的网站登录态，不依赖 App。Server、桌面运行时、扩展和管理台统一使用 TypeScript，macOS 界面由 Swift 提供。

浏览器扩展已在 [Chrome 应用商店](https://chromewebstore.google.com/detail/abridge-for-browser/jbkhngckehhhhkbgpjlifbbchhbeodjc) 发布，可直接安装。[GitHub Releases](https://github.com/xerrors/aBridge/releases) 提供 Server tarball、浏览器 ZIP 和 macOS 包；macOS 包使用 ad hoc 签名且未公证，Server 可使用 Docker 镜像或通过 npx 运行 Release 包。

## 部署 Server

### Docker（推荐）

无需安装 Node.js 或下载源码。镜像支持 Linux amd64 / arm64，包含 Server 和管理台，不含桌面驱动。

```sh
docker run -d \
  --name abridge \
  --restart unless-stopped \
  -p 8765:8765 \
  -v abridge-data:/data \
  ghcr.io/xerrors/abridge:0.4.9
```

本机访问 [http://127.0.0.1:8765](http://127.0.0.1:8765)。数据和管理员凭据保存在 `abridge-data` 命名卷中，重建容器时复用该卷。

在服务器部署时，可将端口映射改为 `-p 11111:8765`，并增加 `-e ABRIDGE_PUBLIC_ORIGIN=https://bridge.example.com`，填入用户实际访问的协议、域名和必要端口，不带路径或结尾 `/`。该配置用于生成授权地址和校验浏览器来源；HTTPS 需另行配置反向代理，远程浏览器扩展连接需要 HTTPS/WSS。

首次进入实例管理，先读取管理员 Token：

```sh
docker exec abridge node -e '
const fs = require("node:fs");
console.log(process.env.ABRIDGE_ADMIN_TOKEN || fs.readFileSync("/data/server.db.admin-token", "utf8").trim());
'
```

将 Token 填入管理链接 `http://127.0.0.1:8765/#admin_token=<TOKEN>` 后打开；远程部署替换为实际访问地址。链接包含管理员凭据，请勿分享。管理员在「实例管理」中创建普通用户；用户登录后绑定设备、管理 Agent 连接。浏览器会保存独立的管理员会话。

运行状态与资源占用：

```sh
docker logs --tail 30 abridge
docker stats --no-stream abridge
```

镜像同时提供 `latest` 标签，部署建议固定版本。更新镜像时保留数据卷，详细步骤见 [Docker 部署](docs/deployment.md#docker-镜像)。

### npx

需要 Node.js 22.13.0+ 与 npm，无需 Docker。公共 npm 包尚未发布，目前直接使用 GitHub Release tarball：

```sh
npx --yes \
  --package=https://github.com/xerrors/aBridge/releases/download/v0.4.9/xerrors-abridge-0.4.9.tgz \
  abridge --web
```

默认监听 `127.0.0.1:8765`；`--web` 在本机浏览器打开管理员链接。命令在前台运行，服务器长期运行可交给 systemd 等进程管理工具。数据默认保存在系统用户数据目录，不依赖 npx 缓存；可用 `--data-dir /absolute/path/to/data` 指定持久目录。

状态目录、端口、管理员 API、HTTPS 反向代理和无图形环境配置见 [安装与维护](docs/deployment.md)。

## 安装客户端

### 浏览器扩展

推荐从 [Chrome 应用商店安装 aBridge for Browser](https://chromewebstore.google.com/detail/abridge-for-browser/jbkhngckehhhhkbgpjlifbbchhbeodjc)。安装扩展后仍需连接自己的 aBridge Server。

如需从源码加载，先执行 `npm run build`，在 `chrome://extensions` 开启开发者模式，加载输出的 `dist/browser/`。源目录中的 TypeScript 需要构建后使用。

点击扩展图标，在弹窗中填写 Server 地址和浏览器名称，点击“在浏览器授权”，在打开的页面登录并确认绑定。每个 Profile 中的扩展安装实例是独立设备；在管理台把它加入 Agent 连接并选择 `browser` 能力。

工具栏面板提供状态、暂停/恢复、停止和设置。浏览器退出时设备离线，重新打开后自动重连；扩展不能自行启动已退出的浏览器。设备授权持久保存，网站登录仍受站点会话规则限制。详见 [浏览器客户端](docs/browser-profile-design.md)。

### macOS App

构建安装需要受支持的 Node.js、npm 和 Xcode Command Line Tools：

```sh
npm run build
npm run desktop:install
open "$HOME/Applications/aBridge.app"
```

安装器把 Node、已构建 CLI 和桌面依赖复制到当前用户的独立运行目录。Swift App 启动该 Node CLI；Cua 官方 Node SDK 仅在桌面进程中按需加载，Server 不需要原生驱动。运行时不依赖源码目录。

在 App 填写 Server 地址，点击“在浏览器授权”，在管理台登录并确认绑定，再启用所需本机能力。屏幕与键鼠操作还需为实际安装的 App 授予 macOS 屏幕录制和辅助功能权限。系统权限、截图和输入效果须在该 App 环境中验证，不能用构建或替身测试代替。详见 [安装与维护](docs/deployment.md)。

## MCP 接入

在管理台创建 Agent 连接，选择“指定设备”或“全部设备（含以后新增设备）”，按设备配置能力。默认持续有效，也可设置到期日期。保存生成的 Agent Key，将以下信息填入支持 Streamable HTTP 的 MCP 客户端：

```json
{
  "url": "http://127.0.0.1:8765/mcp",
  "headers": { "Authorization": "Bearer <AGENT_KEY>" }
}
```

按 `devices_list` → `session_open` → 工具操作 → `session_close` 使用。Device Key 用于设备连接，Agent Key 用于 MCP 调用，两者不可互换。连接的设备范围、能力和期限可编辑，无需替换 MCP 中的 Key；密钥轮换单独进行。管理台可预览该连接能看到的设备。设备类型、授权、本机开关、系统权限和连接状态共同决定有效能力。

| 范围       | 工具                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| 设备与会话 | `devices_list`、`device_get`、`session_open`、`session_close`                                    |
| 桌面       | `computer_open`、`computer_apps`、`computer_windows`、`computer_observe`、`computer_act`         |
| 浏览器     | `browser_open`、`browser_observe`、`browser_act`、`browser_read`、`browser_wait`、`browser_exec` |
| Shell      | `command_execute`、`command_status`、`command_cancel`                                            |
| 文件       | `files_list`、`file_read`、`file_write`                                                          |

导航和动作返回下一步可使用的观察；短命令直接返回输出，长命令才需继续等待。接口时效、分页和失败语义见 [架构与执行契约](docs/architecture.md)。

## 开发

从源码构建并启动 Server：

```sh
npm ci
npm run build
npm start -- --web
```

完整检查：

```sh
npm run check
```

开发、提交和验证要求见 [贡献指南](.github/CONTRIBUTING.md)。

- [架构与执行契约](docs/architecture.md)
- [安装与维护](docs/deployment.md)
- [设计与资产](docs/design.md)
- [安全边界](.github/SECURITY.md)
- [变更记录](docs/changelog.md) · [第三方许可](docs/third-party-notices.md)

项目使用 [Apache-2.0](LICENSE)。tag 发布、npm Trusted Publisher 和 macOS 构建见[发布说明](docs/releasing.md)。
