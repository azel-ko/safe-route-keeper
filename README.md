# SafeRoute Keeper：网络认证自动重登守护程序

SafeRoute Keeper 是一个面向 Linux 的轻量级网络认证守护程序。它定期检测公网连通性；检测到惠尔顿 SafeRoute 强制门户后，直接调用登录接口恢复网络，不依赖 Chrome、图形桌面或浏览器密码自动填充。

## 有什么作用

- 减少企业、园区或宿舍网络认证过期造成的后台开发任务中断。
- 认证失效后自动获取本机当前的动态认证参数并重新登录。
- 登录成功后再次检查公网，避免把接口返回成功误判为真正联网。
- 网络或认证服务器暂时不可用时自动退避，避免高频重试。
- 通过 systemd 用户服务在后台持续运行。
- 不在日志中输出用户名、密码、MAC 地址或完整认证链接。

## 工作原理

1. 默认每 30 秒请求一次 Google HTTP 204 探测地址。
2. 域名探测连接失败时，立即请求不依赖 DNS 的备用公网 IP。
3. 任一探测被强制门户重定向时，只接受来自指定认证服务器的地址。
4. 读取认证页面中的动态 `uri` 和 `/user-login-auth` 接口。
5. 使用 `HRD_USERNAME`、`HRD_PASSWD` 提交表单。
6. 接口成功后等待 3 秒，再次确认公网可访问。

程序不会绕过验证码、多因素认证或管理员限制。账号已在其他设备登录时，默认不会把另一台设备强制下线；只有设置 `HRD_FORCE_LOGIN=1` 才会强制登录。

## 系统要求

- Linux
- Node.js 22 或更高版本
- 可选：systemd 用户服务

项目没有第三方运行时依赖，不需要执行 `npm install`。

## 安装

```bash
git clone https://github.com/azel-ko/safe-route-keeper.git
cd safe-route-keeper
npm test
```

## 凭据配置

推荐创建仅当前用户可读的文件：

```bash
install -d -m 700 ~/.config/safe-route-keeper
install -m 600 /dev/null ~/.config/safe-route-keeper/credentials.env
nano ~/.config/safe-route-keeper/credentials.env
```

文件内容如下，不要写 `export`：

```ini
HRD_USERNAME=你的账号
HRD_PASSWD=你的密码
```

也可以直接使用进程环境变量：

```bash
export HRD_USERNAME='你的账号'
export HRD_PASSWD='你的密码'
```

为了兼容已有配置，程序也能读取 `/etc/profile.d/huierdun.sh` 中带 `export` 的这两个变量。但凭据文件不应是 `644`；这会让其他本机用户读到密码。迁移到上述用户配置后，建议删除旧文件并修改一次密码。

## 测试

先运行完全离线的自动化测试。测试使用模拟认证服务器，不会提交真实账号密码：

```bash
npm test
```

检查真实认证页面、凭据来源和当前网络，但不提交登录：

```bash
node keeper.mjs doctor
```

执行一次检测；当前已联网时只会输出在线状态，当前未认证时会尝试登录：

```bash
node keeper.mjs once
```

要进行可控的真实掉线测试，可以先暂停后台服务，在认证页面正常注销，然后手动执行一次：

```bash
systemctl --user stop safe-route-keeper.service
node keeper.mjs once
systemctl --user start safe-route-keeper.service
```

请勿通过断开网线或关闭 Wi-Fi 测试；这种情况下程序无法获得认证门户地址，也就不会发送登录请求。

前台持续运行：

```bash
node keeper.mjs run
```

## 安装为后台服务

```bash
./install-service.sh
```

安装脚本优先使用 `~/.config/safe-route-keeper/credentials.env`。不存在时，为兼容旧版本会使用 `/etc/profile.d/huierdun.sh`。

查看状态和日志：

```bash
systemctl --user status safe-route-keeper.service
journalctl --user -u safe-route-keeper.service -f
```

卸载后台服务：

```bash
./uninstall-service.sh
```

## 配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HRD_USERNAME` | 无 | 登录账号 |
| `HRD_PASSWD` | 无 | 登录密码 |
| `HRD_FORCE_LOGIN` | `0` | 是否允许强制顶掉其他在线设备 |
| `SAFE_ROUTE_CREDENTIALS_FILE` | 自动选择 | 凭据文件路径 |
| `SAFE_ROUTE_INTERVAL_MS` | `30000` | 正常检测间隔，毫秒 |
| `SAFE_ROUTE_MAX_BACKOFF_MS` | `60000` | 故障退避上限，毫秒 |
| `SAFE_ROUTE_TIMEOUT_MS` | `10000` | 单次 HTTP 请求超时，毫秒 |
| `SAFE_ROUTE_VERIFY_DELAY_MS` | `3000` | 登录后的复检等待时间，毫秒 |
| `SAFE_ROUTE_PROBE_URL` | Google 204 地址 | 公网连通性检测地址 |
| `SAFE_ROUTE_FALLBACK_PROBE_URL` | `http://223.5.5.5/` | 不依赖 DNS 的备用探测地址 |
| `SAFE_ROUTE_AUTH_ORIGIN` | `http://192.168.120.254` | 认证服务器来源 |

修改 systemd 配置后执行：

```bash
systemctl --user daemon-reload
systemctl --user restart safe-route-keeper.service
```

## 故障排查

### 日志提示“没有认证门户地址”

通常表示 Wi-Fi、有线网络、DNS 或网关本身不可用，而不是登录过期。程序不会在无法确认认证目标时盲目发送账号密码。

### 日志提示账号已在其他设备登录

默认会停止本次操作，保护另一台设备。确认允许顶下线后再设置 `HRD_FORCE_LOGIN=1`。

### 电脑睡眠后仍然掉线

系统睡眠期间程序无法运行。可以关闭自动挂起，只关闭显示器；机器唤醒后程序会在下一轮检测时尝试恢复认证。

## 安全说明

- 只向配置的认证服务器来源发送凭据。
- 不记录凭据、完整认证 URL、IP 或 MAC。
- 不执行认证页返回的 JavaScript。
- 请只用于本人获准使用的网络账号。

## 开源许可

本项目采用 [MIT License](LICENSE)。
