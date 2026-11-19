# Windows PC 客户端

独立 TypeScript 运行时与 Rust + WinUI 3 托盘界面，提供截图、前台键鼠输入、Shell 和文件能力，直接连接现有 Server。

**[下载、安装、连接、更新与源码构建指南](../../docs/windows-client.md)**

- `src/`：设备连接、授权、私有状态、操作调度与 Win32/UIA 执行。
- `windows-native-shell/`：Rust + WinUI 3 界面与私有 stdio 桥接。
- `tests/`：协议、授权、取消、Windows 执行与壳回归测试。
- `../../tools/package-windows.ts`：生成包含运行时的未签名 x64 便携包。
- `../../tools/check-windows-package.ts`：校验 ZIP、校验和、文件边界和仓库外独立启动。
