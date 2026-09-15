import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveLoginRequest,
  SafeRouteKeeper,
  parseLoginPage,
} from "./keeper.mjs";

const authOrigin = "http://192.168.120.254";
const portalUrl = `${authOrigin}/login?id=39&url=http%3A%2F%2Fprobe&user=10.0.0.8&mac=00:11:22:33:44:55`;
const portalHtml = `
  <form>
    <input name="param[UserName]" value="">
    <input name="param[UserPswd]" value="">
    <input value="id=39&amp;url=http://probe&amp;user=10.0.0.8&amp;mac=00:11:22:33:44:55" name="uri">
    <input value="0" name="force">
  </form>
  <script>var url ="http://192.168.120.254/user-login-auth?id=39&url=http%3A%2F%2Fprobe&user=10.0.0.8&mac=00:11:22:33:44:55";</script>
`;

function config(overrides = {}) {
  return {
    probeUrl: "http://probe.test/generate_204",
    fallbackProbeUrl: "http://223.5.5.5/",
    authOrigin,
    intervalMs: 60_000,
    maxBackoffMs: 60_000,
    requestTimeoutMs: 1_000,
    verifyDelayMs: 1,
    forceLogin: false,
    ...overrides,
  };
}

test("parses the SafeRoute endpoint and hidden uri", () => {
  const parsed = parseLoginPage(portalHtml, portalUrl, authOrigin);
  assert.equal(parsed.endpoint.pathname, "/user-login-auth");
  assert.match(parsed.uri, /^id=39&url=/);
});

test("derives the login request from captive-portal redirect parameters", () => {
  const parsed = parseLoginPage(portalHtml, portalUrl, authOrigin);
  const derived = deriveLoginRequest(portalUrl, authOrigin);
  assert.equal(derived.endpoint.origin, parsed.endpoint.origin);
  assert.equal(derived.endpoint.pathname, parsed.endpoint.pathname);
  for (const name of ["id", "url", "user", "mac"]) {
    assert.equal(
      derived.endpoint.searchParams.get(name),
      parsed.endpoint.searchParams.get(name),
    );
  }
  assert.equal(derived.uri, parsed.uri);
});

test("does nothing while the probe returns 204", async () => {
  let calls = 0;
  const keeper = new SafeRouteKeeper({
    config: config(),
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    },
    logger: () => {},
  });
  assert.equal(await keeper.checkAndRepair(), "online");
  assert.equal(calls, 1);
});

test("uses a DNS-independent probe when the primary probe cannot connect", async () => {
  const requested = [];
  const keeper = new SafeRouteKeeper({
    config: config(),
    fetchImpl: async (url) => {
      requested.push(String(url));
      if (String(url) === config().probeUrl) {
        const error = new TypeError("fetch failed");
        error.cause = { code: "EAI_AGAIN" };
        throw error;
      }
      return new Response(null, { status: 404 });
    },
    logger: () => {},
  });
  const result = await keeper.probe();
  assert.equal(result.online, true);
  assert.match(result.probe, /备用 IP/);
  assert.deepEqual(requested, [config().probeUrl, config().fallbackProbeUrl]);
});

test("detects the captive portal through the DNS-independent probe", async () => {
  const keeper = new SafeRouteKeeper({
    config: config(),
    fetchImpl: async (url) => {
      if (String(url) === config().probeUrl) throw new TypeError("fetch failed");
      return new Response(null, {
        status: 302,
        headers: { Location: portalUrl },
      });
    },
    logger: () => {},
  });
  const result = await keeper.probe();
  assert.equal(result.online, false);
  assert.equal(result.portalUrl, portalUrl);
});

test("reports causes from both probes when neither can connect", async () => {
  const keeper = new SafeRouteKeeper({
    config: config(),
    fetchImpl: async (url) => {
      const error = new TypeError("fetch failed");
      error.cause = { code: String(url) === config().probeUrl ? "EAI_AGAIN" : "EHOSTUNREACH" };
      throw error;
    },
    logger: () => {},
  });
  const result = await keeper.probe();
  assert.equal(result.online, false);
  assert.match(result.reason, /主探测失败.*EAI_AGAIN/);
  assert.match(result.reason, /备用探测失败.*EHOSTUNREACH/);
});

test("posts credentials and verifies connectivity after a portal redirect", async () => {
  const requests = [];
  let probeCount = 0;
  const keeper = new SafeRouteKeeper({
    config: config(),
    environment: { HRD_USERNAME: "demo-user", HRD_PASSWD: "demo-pass" },
    wait: async () => {},
    logger: () => {},
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url) === config().probeUrl) {
        probeCount += 1;
        return probeCount === 1
          ? new Response(null, { status: 302, headers: { Location: portalUrl } })
          : new Response(null, { status: 204 });
      }
      if (String(url) === portalUrl) {
        return new Response(portalHtml, { status: 200 });
      }
      return Response.json({ status: "1", redirect: "http://example.test" });
    },
  });

  assert.equal(await keeper.checkAndRepair(), "repaired");
  const post = requests.find((request) => request.options.method === "POST");
  assert.ok(post);
  assert.equal(post.options.body.get("param[UserName]"), "demo-user");
  assert.equal(post.options.body.get("param[UserPswd]"), "demo-pass");
  assert.equal(post.options.body.get("force"), "0");
  assert.match(post.options.body.get("uri"), /^id=39&url=/);
});

test("falls back to redirect parameters when the fetched page has no login script", async () => {
  let submittedBody;
  const messages = [];
  const keeper = new SafeRouteKeeper({
    config: config(),
    environment: { HRD_USERNAME: "demo-user", HRD_PASSWD: "demo-pass" },
    logger: (message) => messages.push(message),
    fetchImpl: async (url, options = {}) => {
      if (String(url) === portalUrl) {
        return new Response("<html>temporary gateway page</html>", { status: 200 });
      }
      submittedBody = options.body;
      return Response.json({ status: "1" });
    },
  });

  await keeper.login(portalUrl);
  assert.equal(submittedBody.get("param[UserName]"), "demo-user");
  assert.equal(submittedBody.get("force"), "0");
  assert.match(messages.join("\n"), /网关跳转参数/);
});

test("does not force another session offline by default", async () => {
  const keeper = new SafeRouteKeeper({
    config: config(),
    environment: { HRD_USERNAME: "demo-user", HRD_PASSWD: "demo-pass" },
    logger: () => {},
    fetchImpl: async (url) => String(url) === portalUrl
      ? new Response(portalHtml, { status: 200 })
      : Response.json({ status: "3", user: "demo-user" }),
  });
  await assert.rejects(
    keeper.login(portalUrl),
    /未启用 HRD_FORCE_LOGIN/,
  );
});

test("retries with force=1 only when explicitly enabled", async () => {
  const forceValues = [];
  const keeper = new SafeRouteKeeper({
    config: config({ forceLogin: true }),
    environment: { HRD_USERNAME: "demo-user", HRD_PASSWD: "demo-pass" },
    logger: () => {},
    fetchImpl: async (url, options = {}) => {
      if (String(url) === portalUrl) return new Response(portalHtml, { status: 200 });
      forceValues.push(options.body.get("force"));
      return Response.json({ status: forceValues.length === 1 ? "3" : "1" });
    },
  });
  await keeper.login(portalUrl);
  assert.deepEqual(forceValues, ["0", "1"]);
});

test("redacts credentials from an authentication error", async () => {
  const keeper = new SafeRouteKeeper({
    config: config(),
    environment: { HRD_USERNAME: "secret-user", HRD_PASSWD: "secret-pass" },
    logger: () => {},
    fetchImpl: async (url) => String(url) === portalUrl
      ? new Response(portalHtml, { status: 200 })
      : Response.json({ status: "0", msg: "secret-user secret-pass 登录失败" }),
  });
  await assert.rejects(
    keeper.login(portalUrl),
    (error) => {
      assert.doesNotMatch(error.message, /secret-user|secret-pass/);
      assert.match(error.message, /\[账号\] \[密码\]/);
      return true;
    },
  );
});

test("refuses a login endpoint on another origin", () => {
  assert.throws(
    () => parseLoginPage(
      '<input name="uri" value="x"><script>var url="http://evil.test/user-login-auth"</script>',
      portalUrl,
      authOrigin,
    ),
    /不属于预期/,
  );
});
