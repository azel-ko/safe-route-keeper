# SafeRoute Keeper：浏览器自动重登守护程序

SafeRoute Keeper 是一个面向 Linux 桌面的轻量级网络认证守护程序。它定期检测公网连通性；当网络被强制门户（Captive Portal）拦截时，会启动独立的 Chrome 配置，等待浏览器密码管理器自动填充账号密码，然后点击认证页面的“登录”按钮。

项目最初用于惠尔顿 SafeRoute 上网认证系统，也适用于页面结构相近、登录按钮 ID 为 `btn_login` 的认证门户。

## 有什么作用

- 减少企业、园区或宿舍网络认证过期造成的开发任务中断。
- 在认证失效后自动恢复外网连接。
- 不在脚本、环境变量或日志中保存账号密码。
- 可通过 systemd 用户服务在桌面登录后持续运行。
- 不复制或修改日常使用的 Chrome 配置。

## 工作原理

1. 每隔 60 秒请求一次 `connectivitycheck.gstatic.com/generate_204`。
2. 收到 HTTP 204 时判定网络正常，不启动浏览器。
3. 未收到 HTTP 204 时，使用独立 Chrome 配置访问检测地址。
4. 强制门户将页面重定向至认证页面。
5. Chrome 密码管理器自动填充凭据后，脚本只判断字段是否非空并点击登录。
6. 登录后再次检测公网连接，并通过桌面通知报告结果。

## 安全设计

- 脚本不接收、不记录或持久化明文密码。
- 密码由 Chrome 独立配置和操作系统密钥环管理。
- Chrome DevTools 调试端口仅监听 `127.0.0.1`。
- 自动化逻辑只返回“是否已经填充”，不会返回字段内容。
- 遇到验证码、多因素认证或页面结构变化时不会绕过安全验证。

> 请只用于本人获准使用的网络账号。不要把认证窗口、调试端口或账号共享给其他人。

## 系统要求

- Linux 图形桌面
- Node.js 22 或更高版本
- Google Chrome，默认路径为 `/usr/bin/google-chrome`
- 可选：`notify-send`，用于显示桌面通知
- 可选：systemd 用户服务

确认环境：

```bash
node --version
google-chrome --version
```

## 安装

```bash
git clone https://github.com/azel-ko/safe-route-keeper.git
cd safe-route-keeper
npm run check
```

项目没有第三方运行时依赖，不需要执行 `npm install`。

## 首次设置

```bash
node keeper.mjs setup
```

脚本会打开一个使用独立配置目录的 Chrome 窗口。在该窗口中：

1. 手动填写账号和密码并登录。
2. 接受 Chrome 的“保存密码”提示。
3. 确认能够访问公网。
4. 返回终端按 `Ctrl+C` 结束设置。

如果当前网络已经在线，检测地址不会跳转到带完整参数的认证页面。此时从日常 Chrome 中复制当前认证页的**完整地址**，粘贴到专用 Chrome 地址栏后再登录。

也可以把认证地址作为仅本次生效的参数：

```bash
node keeper.mjs setup '当前认证页的完整地址'
```

该参数不会被写入配置文件，但可能进入 Shell 历史；在意这一点时，请使用浏览器地址栏手动粘贴。

独立 Chrome 配置默认保存在：

```text
~/.local/state/safe-route-keeper/chrome-profile
```

## 前台运行与验证

```bash
node keeper.mjs run
```

正常情况下只会显示启动消息。可以在获得网络管理员许可的前提下临时注销认证，验证脚本能否自动恢复网络。按 `Ctrl+C` 停止。

## 安装为后台服务

请先完成首次设置和前台验证，然后执行：

```bash
./install-service.sh
```

安装脚本会自动探测当前 Node.js 路径和项目绝对路径，生成并启用 systemd 用户服务。

查看状态和日志：

```bash
systemctl --user status safe-route-keeper.service
journalctl --user -u safe-route-keeper.service -f
```

重启服务：

```bash
systemctl --user restart safe-route-keeper.service
```

卸载后台服务：

```bash
./uninstall-service.sh
```

## 配置项

运行时可以通过环境变量覆盖默认配置：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SAFE_ROUTE_INTERVAL_MS` | `60000` | 网络检测间隔，单位为毫秒 |
| `SAFE_ROUTE_PROBE_URL` | Google 204 检测地址 | 公网连通性检测地址 |
| `SAFE_ROUTE_AUTH_HOST` | `192.168.120.254` | 预期的认证服务器主机名或 IP |
| `SAFE_ROUTE_CDP_PORT` | `9223` | 独立 Chrome 的本地调试端口 |
| `SAFE_ROUTE_CHROME` | `/usr/bin/google-chrome` | Chrome 可执行文件路径 |
| `SAFE_ROUTE_PROFILE_DIR` | `~/.local/state/...` | 独立 Chrome 配置目录 |
| `SAFE_ROUTE_SETUP_URL` | 空 | 首次设置时使用的完整认证地址 |

示例：改为每 30 秒检测一次：

```bash
SAFE_ROUTE_INTERVAL_MS=30000 node keeper.mjs run
```

后台服务的环境变量可以通过以下命令编辑：

```bash
systemctl --user edit safe-route-keeper.service
```

```ini
[Service]
Environment=SAFE_ROUTE_INTERVAL_MS=30000
Environment=SAFE_ROUTE_AUTH_HOST=192.168.120.254
```

编辑后执行：

```bash
systemctl --user daemon-reload
systemctl --user restart safe-route-keeper.service
```

## 常见问题

### Chrome 没有自动填充账号密码

重新运行 `node keeper.mjs setup`，确认是在脚本打开的专用 Chrome 中登录并保存密码。日常 Chrome 中保存的密码不会自动复制到专用配置。

### 当前网络在线，看不到完整认证页面

从日常 Chrome 复制已经打开的完整认证地址到专用窗口，或者等待下一次认证失效后再执行首次设置。

### 后台服务找不到 Node.js

不要手工复制仓库里的模板服务文件。运行 `./install-service.sh`，安装脚本会写入当前 `node` 的绝对路径，因此兼容 NVM。

### 自动点击登录后仍然无法联网

检查专用 Chrome 窗口。常见原因包括密码已修改、页面增加验证码、账号被限制、认证服务器不可用，或者认证页面结构发生变化。

### 电脑睡眠后仍然掉线

本项目无法在系统睡眠期间维持网络。需要在桌面电源设置中关闭自动挂起；显示器仍然可以单独关闭。

## 使用限制

- 当前登录按钮选择器为 `#btn_login`，其他认证系统可能需要调整代码。
- 认证页面必须允许 Chrome 密码管理器自动填充。
- 项目不能绕过验证码、多因素认证、账号并发限制或网络管理员策略。
- 如果登录状态依赖持续的 WebSocket 连接，专用 Chrome 进程必须保持运行。
- 不建议把 DevTools 调试端口暴露到局域网或公网。

## 开源许可

本项目采用 [MIT License](LICENSE)。
