# Chrome MCP

[English](README.md)

Chrome MCP 是一个本地 Model Context Protocol 服务，用于管理可持久化、多配置目录的 Chrome，并通过 Puppeteer 提供页面导航、标签页管理、元素交互、JavaScript 执行和截图等能力。MCP 启动时不会自动启动 Chrome；浏览器由生命周期工具按需启动或连接，多个 MCP 客户端可以共享同一个 Chrome 进程和登录状态。

## 环境要求

- amd64 架构的 Debian 或 Ubuntu
- systemd
- 具有 `sudo` 权限的非 root 用户

安装脚本会安装 Google Chrome、必要时安装 Node.js 22、Xvfb、字体，并严格按照 `package-lock.json` 安装 npm 依赖。

## 安装运行环境

```bash
git clone https://github.com/YOUR_ACCOUNT/chrome-mcp.git
cd chrome-mcp
./setup-chrome-mcp.sh
```

请用之后运行 Codex 或 Claude Code 的同一个非 root 用户执行脚本。脚本只在安装系统包和服务时调用 `sudo`，不会修改任何 MCP 客户端配置。

## 安装到 Codex

在仓库根目录执行：

```bash
CHROME_MCP_DIR="$(pwd)"
codex mcp add chrome \
  --env CHROME_PATH=/usr/bin/google-chrome-stable \
  --env CHROME_DEFAULT_PROFILE_DIR="$HOME/.chrome-profile" \
  --env CHROME_PROFILES_DIR="$HOME/.chrome-profiles" \
  --env DISPLAY=:99 \
  -- node "$CHROME_MCP_DIR/src/server.js"

codex mcp list
```

添加后重启 Codex。在 Codex 终端界面输入 `/mcp` 可以查看连接状态和工具。Codex 默认把用户级配置写入 `~/.codex/config.toml`。配置语法参考 [Codex 官方 MCP 文档](https://developers.openai.com/codex/mcp/)。

## 安装到 Claude Code

在仓库根目录执行：

```bash
CHROME_MCP_DIR="$(pwd)"
claude mcp add \
  --env CHROME_PATH=/usr/bin/google-chrome-stable \
  --env CHROME_DEFAULT_PROFILE_DIR="$HOME/.chrome-profile" \
  --env CHROME_PROFILES_DIR="$HOME/.chrome-profiles" \
  --env DISPLAY=:99 \
  --transport stdio \
  --scope user \
  chrome -- node "$CHROME_MCP_DIR/src/server.js"

claude mcp list
claude mcp get chrome
```

在 Claude Code 中输入 `/mcp` 可以查看服务状态。如只希望在当前项目启用，将 `--scope user` 改为 `--scope local`。配置语法参考 [Claude Code 官方 MCP 文档](https://code.claude.com/docs/en/mcp)。

如需项目级 JSON 配置，可将 [.mcp.json.example](.mcp.json.example) 复制为 `.mcp.json`，把占位路径替换为绝对路径，并在 Claude Code 首次加载时确认授权。本地 `.mcp.json` 含机器相关绝对路径，因此已加入 `.gitignore`。

## 让 AI 使用 Chrome

在 `/mcp` 中确认服务已经连接后，直接用自然语言向 Codex 或 Claude Code 描述浏览器任务即可。如果同时安装了其他浏览器工具，可以在要求中明确写出“使用 chrome MCP”。AI 会读取 Chrome MCP 内置的生命周期指令，自行判断应该创建、连接还是复用浏览器配置，然后完成页面操作。

例如：

```text
请使用 chrome MCP 的 default 浏览器配置打开 example.com，阅读页面并总结
主要内容。完成后保持浏览器运行。
```

```text
请使用 chrome MCP 创建或复用名为 research 的独立浏览器配置，搜索这个
API 的官方文档，并把当前可用选项整理成表格。
```

```text
请重新连接 chrome MCP 的 default 配置，继续处理当前已经打开的标签页。
任务完成后不要关闭浏览器。
```

浏览器配置会持久保存 Cookie 和登录状态。网站需要登录时，可以先让 AI 用指定配置打开登录页，通过可选的 noVNC 界面完成人工登录，再让 AI 继续任务。需要关闭 Chrome 时应在要求中明确说明；没有明确要求关闭时，可以保留现有浏览器会话供后续任务继续使用。

删除浏览器配置会永久移除其中的所有浏览器数据，只有确实需要删除时才应明确要求 AI 执行。

## 配置项

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `CHROME_PATH` | Chrome 可执行文件 | `/usr/bin/google-chrome-stable` |
| `CHROME_DEFAULT_PROFILE_DIR` | 名为 `default` 的配置目录 | `$HOME/.chrome-profile` |
| `CHROME_PROFILES_DIR` | 其他命名配置目录的父目录 | `$HOME/.chrome-profiles` |
| `DISPLAY` | Chrome 使用的 X display | `:99` |
| `CHROME_DISABLE_SANDBOX` | 显式关闭 Chrome 沙箱 | `false` |

配置目录必须是绝对路径，不能相互重叠，不能位于本仓库内，也不能指向 `/`、用户主目录等范围过大的目录。

仅在经过隔离且明确接受风险的容器或 root-only 环境中使用 `CHROME_DISABLE_SANDBOX=true`。它会削弱 Chrome 的安全边界。

## 可选 noVNC

```bash
VNC_PASSWORD='设置一个强密码' ./setup-novnc.sh
```

x11vnc 只监听 `127.0.0.1:5900`，noVNC 只监听 `127.0.0.1:6080`。需要远程访问时，应放在带身份验证的 HTTPS 反向代理之后。

## 开发与验证

```bash
npm ci
npm run check
```

`npm run check` 会检查 JavaScript 和 Shell 语法、执行 MCP 契约与安全测试；当本机存在 Chrome 和 display `:99` 时，还会运行完整浏览器集成测试。

```text
src/server.js          MCP 服务、浏览器生命周期和页面工具
test/mcp.test.js       契约、安全、并发和浏览器测试
systemd/               Xvfb 与可选 noVNC 服务
setup-chrome-mcp.sh    可复现的运行环境安装脚本
setup-novnc.sh         可选的本地 VNC 安装脚本
```

## 安全说明

Chrome 配置目录包含 Cookie、登录会话、浏览历史和其他隐私数据，必须放在仓库之外且绝不能提交。对敏感账号使用本项目时请审核 MCP 工具调用；网页内容也可能包含提示注入。

## 许可证

[MIT](LICENSE)
