#!/usr/bin/env node

import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PROBE_URL = "http://connectivitycheck.gstatic.com/generate_204";
const DEFAULT_FALLBACK_PROBE_IPS = ["142.251.127.94", "142.250.154.94"];
const DEFAULT_AUTH_ORIGIN = "http://192.168.120.254";
const LEGACY_CREDENTIALS_FILE = "/etc/profile.d/huierdun.sh";

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanValue(value, fallback = false) {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function commaSeparatedValues(value, fallback) {
  if (value === undefined) return fallback;
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  return values.length > 0 ? values : fallback;
}

function timestamp() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function defaultLogger(message) {
  console.log(`[${timestamp()}] ${message}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function attribute(tag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(
    `(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ));
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? "") : undefined;
}

function inputValue(html, name) {
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    if (attribute(match[0], "name") === name) {
      return attribute(match[0], "value") ?? "";
    }
  }
  return undefined;
}

export function parseLoginPage(html, pageUrl, expectedAuthOrigin) {
  const scriptEndpoint = html.match(
    /["']([^"']*\/user-login-auth(?:\?[^"']*)?)["']/i,
  )?.[1];
  const formTag = html.match(/<form\b[^>]*>/i)?.[0];
  const formEndpoint = formTag ? attribute(formTag, "action") : undefined;
  const endpointValue = decodeHtml(scriptEndpoint ?? formEndpoint ?? "");
  if (!endpointValue.includes("/user-login-auth")) {
    throw new Error("认证页面中没有找到登录接口");
  }

  const endpoint = new URL(endpointValue, pageUrl);
  if (endpoint.origin !== new URL(expectedAuthOrigin).origin) {
    throw new Error("认证接口不属于预期的认证服务器");
  }

  const uri = inputValue(html, "uri");
  if (uri === undefined) throw new Error("认证页面缺少 uri 字段");

  return { endpoint, uri };
}

export function deriveLoginRequest(portalUrl, expectedAuthOrigin) {
  const portal = new URL(portalUrl);
  const expectedOrigin = new URL(expectedAuthOrigin).origin;
  if (portal.origin !== expectedOrigin) {
    throw new Error("认证页面不属于预期的认证服务器");
  }

  const parameterNames = ["id", "url", "user", "mac"];
  if (!parameterNames.every((name) => portal.searchParams.has(name))) {
    throw new Error("认证地址缺少动态登录参数");
  }

  const parameters = parameterNames.map((name) => [
    name,
    portal.searchParams.get(name) ?? "",
  ]);
  if (parameters.some(([name, value]) => name !== "id" && value === "")) {
    throw new Error("认证地址包含空的动态登录参数");
  }

  const endpoint = new URL("/user-login-auth", expectedOrigin);
  for (const [name, value] of parameters) endpoint.searchParams.set(name, value);
  const uri = parameters.map(([name, value]) => `${name}=${value}`).join("&");
  return { endpoint, uri };
}

function parseCredentialFile(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?(HRD_USERNAME|HRD_PASSWD)\s*=\s*(.*?)\s*$/,
    );
    if (!match) continue;
    let value = match[2];
    if (
      value.length >= 2 &&
      ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"')))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export async function loadCredentials(config, environment = process.env) {
  const username = environment.HRD_USERNAME;
  const password = environment.HRD_PASSWD;
  if (username && password) {
    return { username, password, source: "环境变量" };
  }
  if ((username && !password) || (!username && password)) {
    throw new Error("HRD_USERNAME 与 HRD_PASSWD 必须同时设置");
  }

  const candidates = config.credentialsFile
    ? [config.credentialsFile]
    : [
      path.join(os.homedir(), ".config", "safe-route-keeper", "credentials.env"),
      LEGACY_CREDENTIALS_FILE,
    ];

  for (const candidate of candidates) {
    try {
      const values = parseCredentialFile(await readFile(candidate, "utf8"));
      if (values.HRD_USERNAME && values.HRD_PASSWD) {
        return {
          username: values.HRD_USERNAME,
          password: values.HRD_PASSWD,
          source: candidate,
        };
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error("未找到 HRD_USERNAME 和 HRD_PASSWD");
}

export function createConfig(environment = process.env) {
  const legacyHost = environment.SAFE_ROUTE_AUTH_HOST;
  const stateRoot = environment.XDG_STATE_HOME ??
    path.join(os.homedir(), ".local", "state");
  return {
    probeUrl: environment.SAFE_ROUTE_PROBE_URL ?? DEFAULT_PROBE_URL,
    fallbackProbeIps: commaSeparatedValues(
      environment.SAFE_ROUTE_FALLBACK_PROBE_IPS,
      DEFAULT_FALLBACK_PROBE_IPS,
    ),
    authOrigin: environment.SAFE_ROUTE_AUTH_ORIGIN ??
      (legacyHost ? `http://${legacyHost}` : DEFAULT_AUTH_ORIGIN),
    credentialsFile: environment.SAFE_ROUTE_CREDENTIALS_FILE,
    portalCacheFile: environment.SAFE_ROUTE_PORTAL_CACHE_FILE ??
      path.join(stateRoot, "safe-route-keeper", "portal-url"),
    intervalMs: positiveInteger(environment.SAFE_ROUTE_INTERVAL_MS, 30_000),
    maxBackoffMs: positiveInteger(environment.SAFE_ROUTE_MAX_BACKOFF_MS, 60_000),
    requestTimeoutMs: positiveInteger(environment.SAFE_ROUTE_TIMEOUT_MS, 10_000),
    verifyDelayMs: positiveInteger(environment.SAFE_ROUTE_VERIFY_DELAY_MS, 3_000),
    forceLogin: booleanValue(environment.HRD_FORCE_LOGIN),
  };
}

function isExpectedPortal(url, authOrigin) {
  try {
    return new URL(url).origin === new URL(authOrigin).origin;
  } catch {
    return false;
  }
}

function fetchFailureReason(error) {
  const detail = error.cause?.code ?? error.cause?.message;
  return detail ? `${error.message} (${detail})` : error.message;
}

function probeAttempts(config) {
  const primary = new URL(config.probeUrl);
  const attempts = [{
    url: primary.toString(),
    fallback: false,
    headers: { "User-Agent": "safe-route-keeper/2" },
  }];
  for (const address of config.fallbackProbeIps ?? []) {
    const url = new URL(primary);
    url.protocol = "http:";
    url.hostname = address;
    url.port = "";
    attempts.push({
      url: url.toString(),
      fallback: true,
      headers: {
        Host: primary.host,
        "User-Agent": "safe-route-keeper/2",
      },
    });
  }
  return attempts;
}

function cookiesFrom(response) {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  return setCookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

function safeServerMessage(value, credentials) {
  if (typeof value !== "string") return "";
  let message = value.trim().slice(0, 300);
  for (const [secret, replacement] of [
    [credentials.username, "[账号]"],
    [credentials.password, "[密码]"],
  ]) {
    if (secret) message = message.replaceAll(secret, replacement);
  }
  return message;
}

export class SafeRouteKeeper {
  constructor({
    config = createConfig(),
    environment = process.env,
    fetchImpl = fetch,
    logger = defaultLogger,
    wait = delay,
  } = {}) {
    this.config = config;
    this.environment = environment;
    this.fetchImpl = fetchImpl;
    this.log = logger;
    this.wait = wait;
  }

  async probe() {
    const attempts = probeAttempts(this.config);
    const failures = [];

    for (const attempt of attempts) {
      let response;
      try {
        response = await fetchWithTimeout(
          this.fetchImpl,
          attempt.url,
          {
            redirect: "manual",
            cache: "no-store",
            headers: attempt.headers,
          },
          this.config.requestTimeoutMs,
        );
      } catch (error) {
        failures.push(
          `${attempt.fallback ? "备用" : "主"}探测失败：${fetchFailureReason(error)}`,
        );
        continue;
      }

      if (response.status === 204) {
        if (!attempt.fallback) return { online: true, probe: "HTTP 204" };
        failures.push("DNS 旁路可达，但不能证明域名网络已经认证");
        break;
      }

      const location = response.headers.get("location");
      if (location) {
        const portalUrl = new URL(location, attempt.url).toString();
        if (isExpectedPortal(portalUrl, this.config.authOrigin)) {
          await this.rememberPortalUrl(portalUrl);
          return { online: false, portalUrl };
        }
      }

      if (response.status === 200) {
        const html = await response.text();
        if (html.includes("/user-login-auth")) {
          return {
            online: false,
            portalUrl: `${this.config.authOrigin}/login`,
            portalHtml: html,
          };
        }
      }

      failures.push(
        `${attempt.fallback ? "DNS 旁路" : "主"}探测返回 HTTP ${response.status}`,
      );
    }

    const cachedPortalUrl = await this.cachedPortalUrl();
    if (cachedPortalUrl) {
      return {
        online: false,
        portalUrl: cachedPortalUrl,
        cachedPortal: true,
        reason: failures.join("；"),
      };
    }

    return {
      online: false,
      reason: failures.join("；") || "公网探测失败",
    };
  }

  async cachedPortalUrl() {
    if (!this.config.portalCacheFile) return undefined;
    try {
      const portalUrl = (await readFile(this.config.portalCacheFile, "utf8")).trim();
      deriveLoginRequest(portalUrl, this.config.authOrigin);
      return portalUrl;
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      this.log(`忽略无效的认证参数缓存：${error.message}`);
      return undefined;
    }
  }

  async rememberPortalUrl(portalUrl) {
    if (!this.config.portalCacheFile) return;
    try {
      deriveLoginRequest(portalUrl, this.config.authOrigin);
      await mkdir(path.dirname(this.config.portalCacheFile), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(this.config.portalCacheFile, `${portalUrl}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(this.config.portalCacheFile, 0o600);
    } catch (error) {
      this.log(`保存认证参数失败：${error.message}`);
    }
  }

  async login(portalUrl, suppliedHtml) {
    const credentials = await loadCredentials(this.config, this.environment);
    let pageUrl = portalUrl;
    let html = suppliedHtml;
    let cookie = "";

    if (!html) {
      const response = await fetchWithTimeout(
        this.fetchImpl,
        portalUrl,
        {
          redirect: "follow",
          cache: "no-store",
          headers: { "User-Agent": "Mozilla/5.0 safe-route-keeper/2" },
        },
        this.config.requestTimeoutMs,
      );
      if (!response.ok) throw new Error(`认证页面返回 HTTP ${response.status}`);
      pageUrl = response.url || portalUrl;
      html = await response.text();
      cookie = cookiesFrom(response);
    }

    let request;
    try {
      request = parseLoginPage(html, pageUrl, this.config.authOrigin);
      const uriParameters = new URLSearchParams(request.uri);
      if (!["url", "user", "mac"].every((name) => uriParameters.get(name))) {
        throw new Error("认证页面缺少动态登录参数");
      }
    } catch (pageError) {
      try {
        request = deriveLoginRequest(portalUrl, this.config.authOrigin);
        this.log("认证页面结构异常，已改用网关跳转参数构造登录请求");
      } catch {
        throw pageError;
      }
    }
    const { endpoint, uri } = request;

    const submit = async (force) => {
      const body = new URLSearchParams({
        "param[UserName]": credentials.username,
        "param[UserPswd]": credentials.password,
        uri,
        force: force ? "1" : "0",
      });
      const headers = {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Referer: pageUrl,
        "User-Agent": "Mozilla/5.0 safe-route-keeper/2",
        "X-Requested-With": "XMLHttpRequest",
      };
      if (cookie) headers.Cookie = cookie;

      const response = await fetchWithTimeout(
        this.fetchImpl,
        endpoint,
        { method: "POST", redirect: "manual", headers, body },
        this.config.requestTimeoutMs,
      );
      if (!response.ok) throw new Error(`登录接口返回 HTTP ${response.status}`);
      try {
        return await response.json();
      } catch {
        throw new Error("登录接口没有返回有效 JSON");
      }
    };

    let result = await submit(false);
    if (String(result.status) === "3") {
      if (!this.config.forceLogin) {
        throw new Error("账号已在其他设备登录；未启用 HRD_FORCE_LOGIN，已停止操作");
      }
      result = await submit(true);
    }

    if (!["1", "2"].includes(String(result.status))) {
      const serverMessage = safeServerMessage(result.msg, credentials);
      throw new Error(serverMessage || `认证失败，状态码 ${String(result.status)}`);
    }
    return { credentialSource: credentials.source };
  }

  async checkAndRepair({ quietOnline = true } = {}) {
    const state = await this.probe();
    if (state.online) {
      if (!quietOnline) this.log(`网络在线（${state.probe ?? "探测通过"}）`);
      return "online";
    }
    if (!state.portalUrl) throw new Error(state.reason);

    this.log(state.cachedPortal
      ? "域名探测失败，正在使用已保存的认证参数恢复登录"
      : "检测到认证失效，正在直接调用登录接口");
    await this.login(state.portalUrl, state.portalHtml);
    await this.wait(this.config.verifyDelayMs);

    const verified = await this.probe();
    if (!verified.online) throw new Error("认证接口已返回成功，但公网复检未通过");
    this.log("自动重登成功，公网复检通过");
    return "repaired";
  }

  async doctor() {
    const credentials = await loadCredentials(this.config, this.environment);
    this.log(`凭据可用，来源：${credentials.source}`);
    if (credentials.source.startsWith("/")) {
      const info = await stat(credentials.source);
      if ((info.mode & 0o077) !== 0) {
        this.log("警告：凭据文件可被其他本机用户读取，建议将权限改为 600");
      }
    }

    const response = await fetchWithTimeout(
      this.fetchImpl,
      `${this.config.authOrigin}/login`,
      { redirect: "follow", cache: "no-store" },
      this.config.requestTimeoutMs,
    );
    if (!response.ok) throw new Error(`认证页面返回 HTTP ${response.status}`);
    parseLoginPage(
      await response.text(),
      response.url || `${this.config.authOrigin}/login`,
      this.config.authOrigin,
    );
    this.log("认证页面结构和登录接口检查通过（未提交账号密码）");

    const state = await this.probe();
    if (state.online) this.log("当前公网在线（HTTP 204）");
    else if (state.portalUrl) this.log("当前需要认证，可以执行 once 测试登录");
    else this.log(state.reason);
  }
}

let stopping = false;
let wakeFromDelay;

function interruptibleDelay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeFromDelay = undefined;
      resolve();
    }, ms);
    wakeFromDelay = () => {
      clearTimeout(timer);
      wakeFromDelay = undefined;
      resolve();
    };
  });
}

async function runForever(keeper) {
  keeper.log(`守护程序已启动，每 ${Math.round(keeper.config.intervalMs / 1_000)} 秒检测一次`);
  let failures = 0;
  while (!stopping) {
    try {
      await keeper.checkAndRepair();
      failures = 0;
    } catch (error) {
      failures += 1;
      keeper.log(`自动重登失败：${error.message}`);
    }
    if (stopping) break;
    const backoff = Math.min(
      keeper.config.maxBackoffMs,
      keeper.config.intervalMs * (2 ** Math.min(Math.max(failures - 1, 0), 4)),
    );
    await interruptibleDelay(backoff);
  }
}

async function main() {
  const mode = process.argv[2] ?? "run";
  const keeper = new SafeRouteKeeper();
  const stop = () => {
    stopping = true;
    wakeFromDelay?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  if (mode === "run") await runForever(keeper);
  else if (mode === "once") await keeper.checkAndRepair({ quietOnline: false });
  else if (mode === "doctor") await keeper.doctor();
  else {
    console.error("用法：node keeper.mjs [run|once|doctor]");
    process.exitCode = 2;
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main().catch((error) => {
    defaultLogger(`执行失败：${error.message}`);
    process.exitCode = 1;
  });
}
