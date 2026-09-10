#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mode = process.argv[2] ?? "run";
const chromePath = process.env.SAFE_ROUTE_CHROME ?? "/usr/bin/google-chrome";
const probeUrl = process.env.SAFE_ROUTE_PROBE_URL ??
  "http://connectivitycheck.gstatic.com/generate_204";
const authHost = process.env.SAFE_ROUTE_AUTH_HOST ?? "192.168.120.254";
const intervalMs = positiveInteger(process.env.SAFE_ROUTE_INTERVAL_MS, 60_000);
const cdpPort = positiveInteger(process.env.SAFE_ROUTE_CDP_PORT, 9_223);
const stateRoot = process.env.XDG_STATE_HOME ??
  path.join(os.homedir(), ".local", "state");
const profileDir = process.env.SAFE_ROUTE_PROFILE_DIR ??
  path.join(stateRoot, "safe-route-keeper", "chrome-profile");
const setupUrl = process.env.SAFE_ROUTE_SETUP_URL ?? process.argv[3];

let chromeProcess;
let stopping = false;
let checking = false;
let cdp;

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function timestamp() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function log(message) {
  console.log(`[${timestamp()}] ${message}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function isOnline() {
  try {
    const response = await fetchWithTimeout(
      probeUrl,
      { redirect: "manual", cache: "no-store" },
      10_000,
    );
    return response.status === 204;
  } catch {
    return false;
  }
}

async function notify(message) {
  const child = spawn("notify-send", ["SafeRoute 网络认证", message], {
    stdio: "ignore",
  });
  child.once("error", () => {
    // Desktop notifications are optional.
  });
  child.unref();
}

async function chromeReady() {
  try {
    const response = await fetchWithTimeout(
      `http://127.0.0.1:${cdpPort}/json/version`,
      {},
      1_000,
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function startChrome({ minimized }) {
  await mkdir(profileDir, { recursive: true, mode: 0o700 });

  if (await chromeReady()) return;

  const args = [
    `--remote-debugging-port=${cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];
  if (minimized) args.push("--start-minimized");
  args.push(probeUrl);

  chromeProcess = spawn(chromePath, args, {
    stdio: "ignore",
    env: process.env,
  });
  chromeProcess.once("exit", () => {
    chromeProcess = undefined;
    cdp?.close();
    cdp = undefined;
  });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await chromeReady()) return;
    await delay(250);
  }
  throw new Error("Chrome 启动失败或调试端口不可用");
}

class CdpClient {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.sequence = 0;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // The browser may already be closed.
    }
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Chrome connection closed"));
    }
    this.pending.clear();
  }
}

async function pageTarget() {
  const response = await fetchWithTimeout(
    `http://127.0.0.1:${cdpPort}/json/list`,
    {},
    2_000,
  );
  const targets = await response.json();
  return targets.find((target) =>
    target.type === "page" && target.webSocketDebuggerUrl
  );
}

async function connectPage() {
  if (cdp) return cdp;
  const target = await pageTarget();
  if (!target) throw new Error("未找到可控制的 Chrome 页面");
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  return cdp;
}

async function evaluate(expression) {
  const client = await connectPage();
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error("页面脚本执行失败");
  return result.result?.value;
}

async function navigateToLogin(sourceUrl = probeUrl) {
  const client = await connectPage();
  await client.send("Page.navigate", { url: sourceUrl });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await evaluate(`(() => ({
      href: location.href,
      ready: document.readyState,
      hasLogin: Boolean(document.querySelector('#btn_login'))
    }))()`);
    if (state?.hasLogin) return state;
    if (state?.ready === "complete" && state?.href?.includes(authHost)) return state;
    await delay(250);
  }
  return undefined;
}

async function loginWithBrowserAutofill() {
  const pageState = await navigateToLogin();
  if (!pageState?.href?.includes(authHost)) {
    throw new Error("没有进入预期的认证地址");
  }

  // Wait briefly for Chrome Password Manager to populate the dedicated profile.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await evaluate(`(() => {
      const password = document.querySelector('input[type="password"]') ||
        [...document.querySelectorAll('input')].find((input) =>
          input.closest('tr')?.innerText?.includes('密码')
        );
      const enabledTextInputs = [...document.querySelectorAll('input')]
        .filter((input) => !input.disabled && input !== password);
      const username = enabledTextInputs.find((input) => input.value) ||
        enabledTextInputs[0];
      const button = document.querySelector('#btn_login');
      password?.focus();
      return {
        ready: Boolean(username?.value && password?.value && button),
        hasForm: Boolean(password && button)
      };
    })()`);

    if (!state?.hasForm) throw new Error("认证页结构与预期不一致");
    if (state.ready) {
      const clicked = await evaluate(`(() => {
        const button = document.querySelector('#btn_login');
        if (!button) return false;
        button.click();
        return true;
      })()`);
      if (!clicked) throw new Error("未找到登录按钮");
      return;
    }
    await delay(500);
  }

  await notify("需要在专用 Chrome 窗口中完成一次登录并保存密码");
  throw new Error("浏览器尚未自动填充账号密码，请先运行 setup");
}

async function checkAndRepair() {
  if (checking || stopping) return;
  checking = true;
  try {
    if (await isOnline()) return;

    log("检测到网络认证失效，准备自动重登");
    await startChrome({ minimized: mode === "run" });
    await loginWithBrowserAutofill();
    await delay(3_000);

    if (await isOnline()) {
      log("自动重登成功");
      await notify("自动重登成功");
    } else {
      log("已点击登录，但网络仍未恢复；请查看专用 Chrome 窗口");
      await notify("自动登录后仍未联网，请检查认证窗口");
    }
  } catch (error) {
    log(`自动重登失败：${error.message}`);
  } finally {
    checking = false;
  }
}

async function setup() {
  log("正在打开专用 Chrome 配置");
  await startChrome({ minimized: false });
  const pageState = await navigateToLogin(setupUrl ?? probeUrl);
  if (!pageState?.hasLogin && await isOnline()) {
    const client = await connectPage();
    await client.send("Page.navigate", { url: `http://${authHost}/login` });
    log("当前网络已经在线，无法从探测地址获得带参数的认证链接");
    log("请把日常 Chrome 中当前认证页的完整地址复制到专用窗口地址栏");
  }
  log("请在窗口中手动登录，并选择让 Chrome 保存密码");
  log("确认可以上网后，在此终端按 Ctrl+C 结束 setup");
  // Keep Node's event loop alive while the user completes the one-time setup.
  // A never-settling top-level Promise alone does not keep Node alive and causes
  // an "unsettled top-level await" warning when Chrome's launcher exits.
  setInterval(() => {}, 60 * 60 * 1_000);
}

async function run() {
  log(`守护程序已启动，每 ${Math.round(intervalMs / 1_000)} 秒检测一次`);
  await checkAndRepair();
  setInterval(checkAndRepair, intervalMs);
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  cdp?.close();
  if (chromeProcess && !chromeProcess.killed) chromeProcess.kill("SIGTERM");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (error) => {
  log(`未处理错误：${error.message}`);
});

if (mode === "setup") await setup();
else if (mode === "run") await run();
else {
  console.error("用法：node keeper.mjs [setup|run]");
  process.exit(2);
}
