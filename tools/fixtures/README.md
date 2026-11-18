# 测试目标

这里提供受控的桌面窗口和浏览器表单，用于验证真实客户端、系统权限及输入效果。测试仅使用这些自有目标，不包含个人账号或项目部署记录。协议与替身测试仍由 `npm run check` 执行。

## 分发检查器

`package-server.js` 由 `tools/tests/package-consumer.test.ts` 自动启动，模拟正常 HTTP、资源缺失、提前异常退出及关闭失败，验证检查器的失败处理和进程清理。它读取测试临时目录中的 `fixture.json`，无需手动运行；真实候选包的安装与依赖验收由 `package:check` 完成。

## 桌面窗口

在 macOS 上编译并启动：

```sh
fixture_dir="$(mktemp -d)"
swiftc -target arm64-apple-macosx14.0 -parse-as-library -O tools/fixtures/desktop.swift \
  -o "$fixture_dir/DesktopFixture" -framework AppKit
"$fixture_dir/DesktopFixture" "$fixture_dir/desktop.json"
```

启动后读取测试状态中的 PID，通过 `computer_windows` 取得当前窗口 ID，再对该窗口定向观察。随机验证码必须来自实际窗口观察，不能提前写入模型提示。通过当前观察引用填写中文并点击一次，核对窗口显示与状态文件中的 `text`、`click_count`，然后关闭 aBridge 会话。

状态文件中的 PID、时间和计数应属于本次进程；不要复用上次运行的窗口 ID。截图明确指定 PID 与窗口 ID，避免采集整个桌面。桌面引用最长有效 120 秒，动作后使用返回的新观察；暂停或用户接管时停止。

点击路由验收使用两个重叠的 fixture 实例和各自的状态文件。保持一个实例在前台，观察另一个实例并点击其按钮，先用元素引用再用截图坐标。核对前台实例的 `click_count` 保持为零，目标实例的计数各增加一次。需要自动识别前台应用时，把两个程序放入各自的 `.app`，使用不同的 bundle ID。

前台点击验收先观察已聚焦的 fixture。给该实例的状态路径追加 `.command` 并写入 `sibling`、`move` 或 `cover`，再向该 fixture 的 PID 发送 `SIGUSR1`。等待状态文件的 `updated_at` 更新，再用旧截图坐标显式请求 `delivery_mode=foreground`。分别核对 `focus_changed`、`window_frame_changed` 或 `window_point_occluded`，以及两个点击计数。每个用例用 `clear` 关闭竞争窗口、聚焦主窗口，然后获取新观察。

## 浏览器表单

启动本机 HTTP 表单：

```sh
browser_fixture_dir="$(mktemp -d)"
node --import tsx tools/fixtures/browser_fixture.ts \
  --state "$browser_fixture_dir/browser.json" --port 0
```

程序打印实际监听 URL。先由操作者在已绑定的浏览器 Profile 中访问该源的 `/seed`，建立专用 HttpOnly 测试 Cookie；这模拟已有网站登录，不是设备授权，也不导出 Cookie。

随后通过该浏览器设备的 aBridge 会话打开表单根地址。扩展创建自有任务标签页，复用同一 Profile 的测试登录态。观察随机码，填入中文并提交一次；核对页面和状态文件中的 `cookie_verified`、`text`、`submit_count`，再关闭会话。原先的种子页应保留，任务标签页应被清理。

浏览器引用最长有效 60 秒，动作或导航后失效；导航与动作返回的新观察可直接继续使用。测试不需要在 App 选择 Chrome 窗口，不请求 Shell 或文件能力来读取页面。

## 结果核对与清理

执行回执不等于业务效果。分别核对实际图像或 DOM、工具结果、测试程序的持久状态和会话清理。断连或结果未知的输入不能盲目重放；资源清理失败应单独记录。

结束后退出测试程序，并删除本次临时目录。截图、日志和真实操作结果保留在本机私有位置，不提交到仓库。记录失败所需的最小复现条件，不包含凭据或个人页面内容。
