import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = join(SERVER_DIR, "src", "server.js");
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";
const DISPLAY = process.env.DISPLAY || ":99";

function isolatedEnvironment(root, extra = {}) {
  return {
    ...process.env,
    CHROME_PATH,
    CHROME_DEFAULT_PROFILE_DIR: join(root, "default"),
    CHROME_PROFILES_DIR: join(root, "profiles"),
    DISPLAY,
    ...extra,
  };
}

async function connectClient(environment) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: SERVER_DIR,
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "chrome-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(
    result.isError,
    undefined,
    `${name} failed: ${result.content?.[0]?.text || "unknown error"}`,
  );
  return result;
}

function textResult(result) {
  return result.content.find((item) => item.type === "text")?.text || "";
}

function parseJsonAfterPrefix(result, prefix) {
  const text = textResult(result);
  assert.ok(text.startsWith(prefix), `Unexpected tool result: ${text}`);
  return JSON.parse(text.slice(prefix.length));
}

async function closeQuietly(client) {
  if (!client) return;
  try {
    await client.close();
  } catch {}
}

test("MCP exposes the complete tool contract without launching Chrome", async () => {
  const root = mkdtempSync(join(tmpdir(), "chrome-mcp-contract-"));
  let client;
  try {
    client = await connectClient(
      isolatedEnvironment(root, { CHROME_DISABLE_SANDBOX: "true" }),
    );
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 20);
    assert.match(client.getInstructions(), /connect if it is running and connectable/);

    const launch = listed.tools.find(
      (tool) => tool.name === "puppeteer_launch_browser",
    );
    assert.deepEqual(launch.inputSchema.required, ["profile", "profileAction"]);
    assert.equal(
      launch.inputSchema.properties.profile.pattern,
      "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
    );

    const invalid = await client.callTool({
      name: "puppeteer_launch_browser",
      arguments: { profile: "bad/name", profileAction: "create" },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await closeQuietly(client);
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsafe profile roots fail before the MCP accepts requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "chrome-mcp-unsafe-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: SERVER_DIR,
    env: isolatedEnvironment(root, {
      CHROME_DEFAULT_PROFILE_DIR: process.env.HOME || "/root",
    }),
    stderr: "pipe",
  });
  const client = new Client({ name: "chrome-mcp-test", version: "1.0.0" });
  try {
    await assert.rejects(client.connect(transport));
  } finally {
    await closeQuietly(client);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the setup script rejects dangerous paths before installation", () => {
  const projectDir = SERVER_DIR;
  const result = spawnSync("bash", [join(projectDir, "setup-chrome-mcp.sh")], {
    cwd: projectDir,
    env: {
      ...process.env,
      CHROME_DEFAULT_PROFILE_DIR: process.env.HOME || "/root",
      CHROME_PROFILES_DIR: join(tmpdir(), "chrome-mcp-safe-root"),
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /broad or dangerous directory/);
  assert.doesNotMatch(result.stdout, /Installing system prerequisites/);
});

test(
  "root launch requires an explicit sandbox exception and creates no profile",
  { skip: typeof process.getuid !== "function" || process.getuid() !== 0 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "chrome-mcp-sandbox-"));
    let client;
    try {
      client = await connectClient(isolatedEnvironment(root));
      const result = await client.callTool({
        name: "puppeteer_launch_browser",
        arguments: { profile: "blocked", profileAction: "create" },
      });
      assert.equal(result.isError, true);
      assert.match(textResult(result), /sandbox when launched as root/);
      assert.equal(existsSync(join(root, "profiles", "blocked")), false);
    } finally {
      await closeQuietly(client);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("a non-debug process using a profile blocks close and deletion", async () => {
  const root = mkdtempSync(join(tmpdir(), "chrome-mcp-occupied-"));
  const profileDir = join(root, "profiles", "external");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, ".chrome-mcp-profile.json"),
    `${JSON.stringify({
      managedBy: "chrome-mcp",
      version: 1,
      profile: "external",
      path: profileDir,
    })}\n`,
  );
  const holder = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 30000)", "--", `--user-data-dir=${profileDir}`],
    { stdio: "ignore" },
  );
  let client;
  try {
    client = await connectClient(
      isolatedEnvironment(root, { CHROME_DISABLE_SANDBOX: "true" }),
    );
    const profiles = parseJsonAfterPrefix(
      await callTool(client, "puppeteer_list_browser_profiles"),
      "Browser profiles:\n",
    );
    const external = profiles.find((profile) => profile.profile === "external");
    assert.equal(external.running, true);
    assert.equal(external.connectable, false);

    const close = await client.callTool({
      name: "puppeteer_close_browser",
      arguments: { profile: "external", deleteProfile: false },
    });
    assert.equal(close.isError, true);
    assert.match(textResult(close), /no usable debugging endpoint/);
    assert.equal(existsSync(profileDir), true);

    const deleteResult = await client.callTool({
      name: "puppeteer_close_browser",
      arguments: { profile: "external", deleteProfile: true },
    });
    assert.equal(deleteResult.isError, true);
    assert.match(textResult(deleteResult), /no usable debugging endpoint/);
    assert.equal(existsSync(profileDir), true);
  } finally {
    holder.kill("SIGTERM");
    await closeQuietly(client);
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile deletion requires a valid matching ownership marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "chrome-mcp-marker-"));
  const profileDir = join(root, "profiles", "marker-test");
  mkdirSync(profileDir, { recursive: true });
  let client;
  try {
    client = await connectClient(
      isolatedEnvironment(root, { CHROME_DISABLE_SANDBOX: "true" }),
    );
    const unmarked = await client.callTool({
      name: "puppeteer_close_browser",
      arguments: { profile: "marker-test", deleteProfile: true },
    });
    assert.equal(unmarked.isError, true);
    assert.match(textResult(unmarked), /has not been adopted/);

    writeFileSync(
      join(profileDir, ".chrome-mcp-profile.json"),
      `${JSON.stringify({
        managedBy: "chrome-mcp",
        version: 1,
        profile: "different-profile",
        path: profileDir,
      })}\n`,
    );
    const mismatched = await client.callTool({
      name: "puppeteer_close_browser",
      arguments: { profile: "marker-test", deleteProfile: true },
    });
    assert.equal(mismatched.isError, true);
    assert.match(textResult(mismatched), /ownership marker mismatch/);
    assert.equal(existsSync(profileDir), true);
  } finally {
    await closeQuietly(client);
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile lifecycle tools reject symbolic-link profiles", async () => {
  const root = mkdtempSync(join(tmpdir(), "chrome-mcp-symlink-"));
  const outsideDir = join(root, "outside");
  const profileLink = join(root, "profiles", "linked");
  mkdirSync(dirname(profileLink), { recursive: true });
  mkdirSync(outsideDir);
  symlinkSync(outsideDir, profileLink, "dir");
  let client;
  try {
    client = await connectClient(
      isolatedEnvironment(root, { CHROME_DISABLE_SANDBOX: "true" }),
    );
    const result = await client.callTool({
      name: "puppeteer_launch_browser",
      arguments: { profile: "linked", profileAction: "reuse" },
    });
    assert.equal(result.isError, true);
    assert.match(textResult(result), /symbolic-link profile/);
    assert.equal(existsSync(outsideDir), true);
  } finally {
    await closeQuietly(client);
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "two MCP clients share one browser and lifecycle cleanup is deterministic",
  {
    skip:
      !existsSync(CHROME_PATH) ||
      !existsSync(`/tmp/.X11-unix/X${DISPLAY.replace(/^:/, "")}`),
    timeout: 60_000,
  },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "chrome-mcp-browser-"));
    const environment = isolatedEnvironment(root, {
      CHROME_DISABLE_SANDBOX:
        typeof process.getuid === "function" && process.getuid() === 0
          ? "true"
          : "false",
    });
    let first;
    let second;
    try {
      [first, second] = await Promise.all([
        connectClient(environment),
        connectClient(environment),
      ]);

      await callTool(first, "puppeteer_launch_browser", {
        profile: "shared",
        profileAction: "create",
      });
      await callTool(first, "puppeteer_navigate", {
        url: "data:text/html,<title>initial-page-fingerprint</title>",
      });
      const initialPageFingerprint = parseJsonAfterPrefix(
        await callTool(first, "puppeteer_evaluate", {
          script: `new Promise((resolve, reject) => {
            const canvas = document.createElement("canvas");
            const gl = canvas.getContext("webgl");
            const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
            const workerSource = [
              "const canvas = new OffscreenCanvas(1, 1);",
              "const gl = canvas.getContext('webgl');",
              "const info = gl.getExtension('WEBGL_debug_renderer_info');",
              "postMessage({",
              "  cores: navigator.hardwareConcurrency,",
              "  platform: navigator.platform,",
              "  vendor: gl.getParameter(info.UNMASKED_VENDOR_WEBGL),",
              "  renderer: gl.getParameter(info.UNMASKED_RENDERER_WEBGL),",
              "});",
            ].join("\\n");
            const workerUrl = URL.createObjectURL(new Blob([workerSource], {
              type: "text/javascript",
            }));
            const worker = new Worker(workerUrl);
            worker.onmessage = ({ data }) => {
              worker.terminate();
              URL.revokeObjectURL(workerUrl);
              resolve({
                webdriver: navigator.webdriver,
                pageVendor: gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL),
                workerVendor: data.vendor,
                pageRenderer: gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL),
                workerRenderer: data.renderer,
                pageCores: navigator.hardwareConcurrency,
                workerCores: data.cores,
                pagePlatform: navigator.platform,
                workerPlatform: data.platform,
              });
            };
            worker.onerror = reject;
          })`,
        }),
        "Execution result:\n",
      );
      assert.equal(initialPageFingerprint.webdriver, false);
      assert.equal(
        initialPageFingerprint.pageVendor,
        initialPageFingerprint.workerVendor,
      );
      assert.equal(
        initialPageFingerprint.pageRenderer,
        initialPageFingerprint.workerRenderer,
      );
      assert.equal(initialPageFingerprint.pageCores, initialPageFingerprint.workerCores);
      assert.equal(
        initialPageFingerprint.pagePlatform,
        initialPageFingerprint.workerPlatform,
      );
      const beforeConnect = parseJsonAfterPrefix(
        await callTool(first, "puppeteer_evaluate", {
          script: "({ width: innerWidth, height: innerHeight })",
        }),
        "Execution result:\n",
      );
      await callTool(second, "puppeteer_connect_browser", { profile: "shared" });
      const afterConnect = parseJsonAfterPrefix(
        await callTool(first, "puppeteer_evaluate", {
          script: "({ width: innerWidth, height: innerHeight })",
        }),
        "Execution result:\n",
      );
      assert.deepEqual(afterConnect, beforeConnect);

      await callTool(first, "puppeteer_new_page", {
        url: "data:text/html,<title>viewport-test</title><main>ready</main>",
      });

      const secondPages = parseJsonAfterPrefix(
        await callTool(second, "puppeteer_list_pages"),
        "Browser profile shared pages:\n",
      );
      const newPage = secondPages.find((page) => page.title === "viewport-test");
      assert.ok(newPage);
      await callTool(second, "puppeteer_switch_page", { index: newPage.index });
      const secondScreenshot = await callTool(second, "puppeteer_screenshot", {
        name: "new-shared-page",
      });
      assert.ok(secondScreenshot.content.some((item) => item.type === "image"));

      const before = parseJsonAfterPrefix(
        await callTool(first, "puppeteer_evaluate", {
          script: "({ width: innerWidth, height: innerHeight })",
        }),
        "Execution result:\n",
      );
      const screenshot = await callTool(first, "puppeteer_screenshot", {
        name: "default-viewport",
      });
      const image = screenshot.content.find((item) => item.type === "image");
      assert.ok(image?.data);
      assert.deepEqual(
        [...Buffer.from(image.data, "base64").subarray(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );
      const after = parseJsonAfterPrefix(
        await callTool(first, "puppeteer_evaluate", {
          script: "({ width: innerWidth, height: innerHeight })",
        }),
        "Execution result:\n",
      );
      assert.deepEqual(after, before);

      await callTool(first, "puppeteer_disconnect_browser", { profile: "shared" });
      const stillRunning = parseJsonAfterPrefix(
        await callTool(second, "puppeteer_list_browser_profiles"),
        "Browser profiles:\n",
      ).find((profile) => profile.profile === "shared");
      assert.equal(stillRunning.running, true);
      assert.equal(stillRunning.connected, true);

      await callTool(second, "puppeteer_close_browser", {
        profile: "shared",
        deleteProfile: true,
      });
      assert.equal(existsSync(join(root, "profiles", "shared")), false);

      const launches = await Promise.all([
        first.callTool({
          name: "puppeteer_launch_browser",
          arguments: { profile: "race", profileAction: "create" },
        }),
        second.callTool({
          name: "puppeteer_launch_browser",
          arguments: { profile: "race", profileAction: "create" },
        }),
      ]);
      assert.equal(launches.filter((result) => result.isError).length, 1);
      const owner = launches[0].isError ? second : first;
      await callTool(owner, "puppeteer_close_browser", {
        profile: "race",
        deleteProfile: true,
      });
    } finally {
      for (const client of [first, second]) {
        if (!client) continue;
        for (const profile of ["shared", "race"]) {
          try {
            await client.callTool({
              name: "puppeteer_close_browser",
              arguments: { profile, deleteProfile: true },
            });
          } catch {}
        }
      }
      await Promise.all([closeQuietly(first), closeQuietly(second)]);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
