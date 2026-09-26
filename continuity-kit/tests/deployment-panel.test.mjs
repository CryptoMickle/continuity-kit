import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  deploymentPanelOptions,
  ORIGIN,
} from "../scripts/deployment-panel.mjs";

function guard() {
  const options = deploymentPanelOptions("/synthetic/project");
  let handle;
  options.plugins[0].configureServer({
    middlewares: {
      use(fn) {
        handle = fn;
      },
    },
  });
  return (overrides = {}) => {
    let next = false;
    const headers = {};
    const response = {
      statusCode: 200,
      setHeader(k, v) {
        headers[k] = v;
      },
      end(body) {
        this.body = body;
      },
    };
    handle(
      {
        url: "/__deployment_attempt",
        method: "POST",
        headers: { host: "primary.localhost:4176", origin: ORIGIN },
        ...overrides,
      },
      response,
      () => {
        next = true;
      },
    );
    return { ...response, headers, next };
  };
}

test("default and unrelated switches exit dormant without starting a service", () => {
  const script = fileURLToPath(
    new URL("../scripts/deployment-panel.mjs", import.meta.url),
  );
  for (const args of [[], ["--approved"], ["--physical"]]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No service started/);
  }
});

test("configuration is loopback only, strict port, no inherited config or browser opening", () => {
  const options = deploymentPanelOptions("/synthetic/project");
  assert.equal(options.configFile, false);
  assert.equal(options.server.host, "127.0.0.1");
  assert.equal(options.server.port, 4176);
  assert.equal(options.server.strictPort, true);
  assert.equal(options.server.open, false);
  assert.equal(options.server.hmr, false);
  assert.equal(options.server.cors, false);
  assert.deepEqual(options.server.allowedHosts, ["primary.localhost"]);
});

test("one server permits just one explicit same-origin POST across page reloads", () => {
  const request = guard();
  assert.equal(request({ method: "GET" }).statusCode, 403);
  assert.equal(
    request({
      headers: {
        host: "primary.localhost:4176",
        origin: "http://recovery.localhost:4174",
      },
    }).statusCode,
    403,
  );
  assert.equal(
    request({ headers: { host: "127.0.0.1:4176", origin: ORIGIN } }).statusCode,
    403,
  );
  assert.equal(
    request({ headers: { host: "primary.localhost:4176" } }).statusCode,
    403,
  );
  assert.equal(request().statusCode, 204);
  assert.equal(request().statusCode, 409);
  assert.equal(request().statusCode, 409);
});

test("ordinary page/module reads do not reserve the deployment attempt", () => {
  const request = guard();
  const page = request({ url: "/testnet-deploy.html", method: "GET" });
  assert.equal(page.next, true);
  assert.equal(page.headers["Cache-Control"], "no-store");
  assert.equal(page.headers["X-Frame-Options"], "DENY");
  assert.equal(
    request({ url: "/src/deployment-panel.ts", method: "GET" }).next,
    true,
  );
  assert.equal(request().statusCode, 204);
});
