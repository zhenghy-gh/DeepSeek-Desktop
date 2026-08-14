# DeepSeek Desktop

DeepSeek 对话 + Harness 一体桌面应用。安装后**无需打开浏览器、无需敲命令**：
应用启动时自动拉起 Harness 服务，窗口内提供两个标签页，一键直达：

| 标签页 | 内容 | 地址 |
| --- | --- | --- |
| 💬 DeepSeek 对话 | DeepSeek 官方网页对话 | https://chat.deepseek.com |
| 🛠 Harness | DeepSeek Harness 工作台（本地服务） | http://127.0.0.1:3080 |

## 功能

- **自动启动 Harness**：启动时探测本地是否已有 Harness 在运行（`__DSH_BOOT__` 标记），没有则自动以 `dsh web` 拉起（内置 dsh 运行时，不依赖你的 npm 缓存）；已有则直接复用，退出应用不会误杀外部启动的 Harness
- **双标签页**：`Cmd+1` 对话 / `Cmd+2` Harness，`Cmd+R` 刷新当前页
- **会话持久化**：两个标签页各自独立分区（`persist:deepseek` / `persist:harness`），登录状态与 Harness 会话在重启后保留
- **失败自愈**：Harness 未就绪或意外退出时显示错误面板，可一键重启并查看日志
- **单实例**：重复打开应用只会聚焦已有窗口
- **外部链接**：网页中的 `target=_blank` 链接交给系统浏览器打开

## 安装

1. 在 [Releases](https://github.com/zhenghy-gh/DeepSeek-Desktop/releases) 下载 `DeepSeek-Desktop-<version>-arm64.dmg`
2. 打开 dmg，把 **DeepSeek Desktop** 拖入 Applications
3. 首次打开：未签名应用会被 Gatekeeper 拦截，右键应用图标 →「打开」即可（本机构建不受影响）

> 安装包内置 dsh 运行时（约 300 MB 解压后），首次启动 Harness 需要数秒，工具栏状态点会显示进度。

## 开发

```bash
npm install          # 安装 electron / electron-builder
npm run icon         # 生成应用图标（需要 macOS 自带 sips/iconutil）
npm run prepare:runtime  # 将本机 dsh 运行时复制进 dsh-runtime/
npm start            # 开发模式运行
npm run dist         # 构建 dmg + zip 安装包（输出到 dist/）
```

## 工作原理

- `main.js`：Electron 主进程。定位 node 与 dsh（优先级：应用内置 `resources/dsh-runtime` → PATH → `~/.npm/_npx/*`），探测/启动 Harness，等待就绪后通知渲染层加载对应地址；退出时仅终止自己拉起的进程
- `renderer/`：本地界面，两个 `<webview>` 承载对话页与 Harness 页
- `scripts/prepare-runtime.mjs`：把本机 dsh 安装复制到 `dsh-runtime/`（裁剪 sourcemap、文档、非 arm64 预编译产物），随应用打包
- 端口策略：优先复用 3080；若被占用/启动失败，依次尝试 3081–3083

## 已知限制

- 目前仅构建 macOS arm64（Apple Silicon）
- 未做代码签名，分发到其他 Mac 时首次打开需右键 → 打开
- Windows / Linux 版本可通过 electron-builder 目标扩展（需对应平台的 dsh 运行时）

## 许可证

MIT
