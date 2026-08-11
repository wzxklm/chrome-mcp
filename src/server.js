import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync, spawn } from "child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { fileURLToPath } from "url";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin({ enabledEvasions: new Set(["sourceurl"]) }));

const browserSessions = new Map();
let activeProfileName = null;

const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";
const DISPLAY = process.env.DISPLAY || ":99";
const DEFAULT_PROFILE_INPUT =
  process.env.CHROME_DEFAULT_PROFILE_DIR ||
  process.env.CHROME_USER_DATA_DIR ||
  `${process.env.HOME || "/tmp"}/.chrome-profile`;
const PROFILES_INPUT =
  process.env.CHROME_PROFILES_DIR ||
  `${process.env.HOME || "/tmp"}/.chrome-profiles`;
if (!isAbsolute(DEFAULT_PROFILE_INPUT) || !isAbsolute(PROFILES_INPUT)) {
  throw new Error("Chrome profile directories must use absolute paths.");
}
const DEFAULT_PROFILE_DIR = resolve(
  DEFAULT_PROFILE_INPUT,
);
const PROFILES_DIR = resolve(PROFILES_INPUT);
const LOCKS_DIR = join(PROFILES_DIR, ".locks");
const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_MARKER = ".chrome-mcp-profile.json";
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function parseBooleanEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be either "true" or "false".`);
}

const CHROME_DISABLE_SANDBOX = parseBooleanEnvironment(
  "CHROME_DISABLE_SANDBOX",
);

function pathContains(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith(`..${sep}`) &&
      pathFromParent !== ".." &&
      !isAbsolute(pathFromParent))
  );
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertNoSymlinkComponents(path, label) {
  let current = path;
  while (true) {
    if (lstatIfPresent(current)?.isSymbolicLink()) {
      throw new Error(`${label} must not contain symbolic links: ${current}`);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function validateManagedProfileRoots() {
  const homeDir = resolve(process.env.HOME || "/tmp");
  const roots = [
    ["CHROME_DEFAULT_PROFILE_DIR", DEFAULT_PROFILE_DIR],
    ["CHROME_PROFILES_DIR", PROFILES_DIR],
  ];
  for (const [name, path] of roots) {
    if (
      path === resolve("/") ||
      dirname(path) === resolve("/") ||
      path === homeDir
    ) {
      throw new Error(`${name} points to a broad or dangerous directory: ${path}`);
    }
    if (pathContains(path, PROJECT_DIR) || pathContains(PROJECT_DIR, path)) {
      throw new Error(`${name} must not overlap the project directory: ${path}`);
    }
    const stats = lstatIfPresent(path);
    if (stats && !stats.isDirectory()) {
      throw new Error(`${name} must point to a directory: ${path}`);
    }
    assertNoSymlinkComponents(path, name);
  }
  if (
    pathContains(DEFAULT_PROFILE_DIR, PROFILES_DIR) ||
    pathContains(PROFILES_DIR, DEFAULT_PROFILE_DIR)
  ) {
    throw new Error(
      "CHROME_DEFAULT_PROFILE_DIR and CHROME_PROFILES_DIR must not overlap.",
    );
  }
}

validateManagedProfileRoots();

function profileNameSchema(description) {
  return z
    .string()
    .regex(PROFILE_NAME_PATTERN)
    .describe(
      `${description}. Use "default" for the default profile; other names must be 1-64 characters containing only letters, numbers, dots, underscores, or hyphens`,
    );
}

// Detect GPU: NVIDIA via nvidia-smi, Intel/AMD via DRI render node
function hasGpu() {
  try {
    execSync("nvidia-smi", { stdio: "ignore" });
    return true;
  } catch {}
  return existsSync("/dev/dri/renderD128");
}
const GPU_AVAILABLE = hasGpu();

// ── Browser profiles ──

function validateProfileName(profile) {
  if (!PROFILE_NAME_PATTERN.test(profile)) {
    throw new Error(
      "Profile names must be 1-64 characters and contain only letters, numbers, dots, underscores, or hyphens.",
    );
  }
}

function profileDirFor(profile) {
  validateProfileName(profile);
  if (profile === "default") return DEFAULT_PROFILE_DIR;
  const profileDir = resolve(PROFILES_DIR, profile);
  if (dirname(profileDir) !== PROFILES_DIR) {
    throw new Error(`Invalid profile path for ${profile}.`);
  }
  return profileDir;
}

function assertProfileIsNotSymlink(profile) {
  validateManagedProfileRoots();
  const profileDir = profileDirFor(profile);
  const stats = lstatIfPresent(profileDir);
  if (stats?.isSymbolicLink()) {
    throw new Error(`Refusing to use symbolic-link profile ${profile}.`);
  }
  if (stats && !stats.isDirectory()) {
    throw new Error(`Profile ${profile} is not a directory.`);
  }
  return profileDir;
}

function markerPathFor(profile) {
  return join(profileDirFor(profile), PROFILE_MARKER);
}

function expectedProfileMarker(profile) {
  return {
    managedBy: "chrome-mcp",
    version: 1,
    profile,
    path: profileDirFor(profile),
  };
}

function readAndValidateProfileMarker(profile) {
  const markerPath = markerPathFor(profile);
  const markerStats = lstatIfPresent(markerPath);
  if (!markerStats) return null;
  if (markerStats.isSymbolicLink() || !markerStats.isFile()) {
    throw new Error(`Profile ${profile} has an unsafe ownership marker.`);
  }
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    throw new Error(`Profile ${profile} has an invalid ownership marker.`);
  }
  const expected = expectedProfileMarker(profile);
  if (
    marker?.managedBy !== expected.managedBy ||
    marker?.version !== expected.version ||
    marker?.profile !== expected.profile ||
    marker?.path !== expected.path
  ) {
    throw new Error(`Profile ${profile} has an ownership marker mismatch.`);
  }
  return marker;
}

function adoptProfile(profile) {
  const existingMarker = readAndValidateProfileMarker(profile);
  if (existingMarker) return;
  try {
    writeFileSync(
      markerPathFor(profile),
      `${JSON.stringify(expectedProfileMarker(profile), null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      readAndValidateProfileMarker(profile);
      return;
    }
    throw error;
  }
}

function assertProfileOwned(profile) {
  if (!readAndValidateProfileMarker(profile)) {
    throw new Error(
      `Refusing to delete profile ${profile}: it has not been adopted by Chrome MCP. Launch it once with profileAction=reuse first.`,
    );
  }
}

function activePortFileFor(profile) {
  return join(assertProfileIsNotSymlink(profile), "DevToolsActivePort");
}

function readProfileEndpoint(profile) {
  const activePortFile = activePortFileFor(profile);
  if (!existsSync(activePortFile)) return null;
  const [port, webSocketPath] = readFileSync(activePortFile, "utf8")
    .trim()
    .split(/\r?\n/);
  if (!/^\d+$/.test(port) || !webSocketPath?.startsWith("/devtools/browser/")) {
    return null;
  }
  return { port: Number(port), webSocketPath };
}

async function readConnectableProfileEndpoint(profile) {
  const endpoint = readProfileEndpoint(profile);
  if (!endpoint) return null;
  try {
    const response = await fetch(
      `http://127.0.0.1:${endpoint.port}/json/version`,
      { signal: AbortSignal.timeout(750) },
    );
    if (!response.ok) return null;
    const version = await response.json();
    return typeof version.webSocketDebuggerUrl === "string" &&
      new URL(version.webSocketDebuggerUrl).pathname === endpoint.webSocketPath
      ? endpoint
      : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processUsesProfile(pid, profileDir) {
  let args;
  try {
    args = readFileSync(`/proc/${pid}/cmdline`)
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    return false;
  }
  for (let index = 0; index < args.length; index += 1) {
    let userDataDir = null;
    if (args[index].startsWith("--user-data-dir=")) {
      userDataDir = args[index].slice("--user-data-dir=".length);
    } else if (args[index] === "--user-data-dir") {
      userDataDir = args[index + 1];
    }
    if (userDataDir && resolve(userDataDir) === profileDir) return true;
  }
  return false;
}

function singletonLockPid(profileDir) {
  const singletonLock = join(profileDir, "SingletonLock");
  const stats = lstatIfPresent(singletonLock);
  if (!stats) return null;
  let lockTarget;
  try {
    lockTarget = stats.isSymbolicLink()
      ? readlinkSync(singletonLock)
      : readFileSync(singletonLock, "utf8").trim();
  } catch {
    return null;
  }
  const match = lockTarget.match(/-(\d+)$/);
  return match ? Number(match[1]) : null;
}

function findProcessUsingProfile(profileDir) {
  const lockPid = singletonLockPid(profileDir);
  // A live singleton owner is sufficient evidence even if /proc is restricted.
  if (processIsAlive(lockPid)) return lockPid;
  let entries;
  try {
    entries = readdirSync("/proc", { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (processUsesProfile(pid, profileDir)) return pid;
  }
  return null;
}

async function profileOccupancy(profile) {
  const profileDir = assertProfileIsNotSymlink(profile);
  if (await readConnectableProfileEndpoint(profile)) {
    return {
      occupied: true,
      debuggable: true,
      pid: findProcessUsingProfile(profileDir),
    };
  }
  const pid = findProcessUsingProfile(profileDir);
  return { occupied: pid !== null, debuggable: false, pid };
}

async function acquireLifecycleLock(profile) {
  validateProfileName(profile);
  validateManagedProfileRoots();
  mkdirSync(LOCKS_DIR, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(LOCKS_DIR, "Lifecycle lock directory");
  const lockFile = join(LOCKS_DIR, `${profile}.lifecycle.lock`);
  if (lstatIfPresent(lockFile)?.isSymbolicLink()) {
    throw new Error(`Refusing symbolic-link lifecycle lock for ${profile}.`);
  }
  writeFileSync(lockFile, "", { flag: "a", mode: 0o600 });

  return await new Promise((resolveLock, rejectLock) => {
    let acquired = false;
    let stderr = "";
    let stdout = "";
    let exited = false;
    let resolveExit;
    const exitPromise = new Promise((resolveChildExit) => {
      resolveExit = resolveChildExit;
    });
    const lockProcess = spawn(
      "flock",
      [
        "--exclusive",
        "--nonblock",
        lockFile,
        "sh",
        "-c",
        'printf "LOCKED\\n"; cat >/dev/null',
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    lockProcess.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    lockProcess.once("error", (error) => {
      rejectLock(
        new Error(
          `Unable to acquire lifecycle lock for ${profile}: ${error.message}`,
        ),
      );
    });
    lockProcess.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (acquired || !stdout.includes("LOCKED\n")) return;
      acquired = true;
      resolveLock(async () => {
        if (!exited) lockProcess.stdin.end();
        await exitPromise;
      });
    });
    lockProcess.once("exit", (code) => {
      exited = true;
      resolveExit();
      if (!acquired) {
        rejectLock(
          new Error(
            code === 1
              ? `Another lifecycle operation is already in progress for profile ${profile}.`
              : `Lifecycle lock failed for profile ${profile}${stderr.trim() ? `: ${stderr.trim()}` : "."}`,
          ),
        );
      }
    });
  });
}

function assertChromeSandboxConfiguration() {
  if (
    typeof process.getuid === "function" &&
    process.getuid() === 0 &&
    !CHROME_DISABLE_SANDBOX
  ) {
    throw new Error(
      "Chrome cannot use its normal sandbox when launched as root. Run Chrome MCP as a non-root user, or explicitly set CHROME_DISABLE_SANDBOX=true after accepting the security risk.",
    );
  }
}

function chromeArguments(profileDir) {
  const glArgs = GPU_AVAILABLE
    ? ["--use-gl=egl"]
    : [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ];
  return [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    ...(CHROME_DISABLE_SANDBOX
      ? ["--no-sandbox", "--disable-setuid-sandbox"]
      : []),
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--window-size=1920,1080",
    "--start-maximized",
    "--lang=en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
    ...glArgs,
    "--ignore-gpu-blocklist",
    "--disable-dev-shm-usage",
    "--disable-crash-reporter",
    "--disable-breakpad",
    "--no-first-run",
    "--no-default-browser-check",
    "--noerrdialogs",
  ];
}

async function prepareExistingPages(browser) {
  const pages = await browser.pages();
  await Promise.all(
    pages.map(async (page) => {
      try {
        await puppeteer.callPlugins("onPageCreated", page);
      } catch (error) {
        if (!page.isClosed()) throw error;
      }
    }),
  );
  return pages;
}

async function connectProfile(profile) {
  assertProfileIsNotSymlink(profile);
  const existing = browserSessions.get(profile);
  if (existing?.browser?.connected) {
    activeProfileName = profile;
    return existing;
  }

  const endpoint = await readConnectableProfileEndpoint(profile);
  if (!endpoint) {
    throw new Error(`Profile ${profile} does not have a running browser.`);
  }
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${endpoint.port}`,
    defaultViewport: null,
  });
  if (new URL(browser.wsEndpoint()).pathname !== endpoint.webSocketPath) {
    browser.disconnect();
    throw new Error(`Debug endpoint mismatch for profile ${profile}.`);
  }
  const pages = await prepareExistingPages(browser);
  const page = pages[0] || (await browser.newPage());
  const session = { browser, page };
  browserSessions.set(profile, session);
  activeProfileName = profile;
  browser.once("disconnected", () => {
    if (browserSessions.get(profile)?.browser !== browser) return;
    browserSessions.delete(profile);
    if (activeProfileName === profile) chooseNextActiveProfile();
  });
  return session;
}

async function waitForProfile(profile, child) {
  let lastError = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await connectProfile(profile);
    } catch (error) {
      lastError = error;
    }
    if (child.launchError) {
      throw new Error(
        `Failed to launch Chrome for profile ${profile}: ${child.launchError.message}`,
      );
    }
    if (child.exitCode !== null) {
      throw new Error(
        `Chrome exited while starting profile ${profile} (exit ${child.exitCode}).`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  throw new Error(
    `Timed out starting profile ${profile}: ${lastError?.message || "unknown error"}`,
  );
}

async function launchProfile(profile, profileAction) {
  assertChromeSandboxConfiguration();
  const releaseLock = await acquireLifecycleLock(profile);
  try {
    const profileDir = assertProfileIsNotSymlink(profile);
    const profileExists = Boolean(lstatIfPresent(profileDir));
    if (profileAction === "create" && profileExists) {
      throw new Error(`Profile ${profile} already exists; use profileAction=reuse.`);
    }
    if (profileAction === "reuse" && !profileExists) {
      throw new Error(`Profile ${profile} does not exist; use profileAction=create.`);
    }
    const occupancy = await profileOccupancy(profile);
    if (occupancy.occupied) {
      throw new Error(
        occupancy.debuggable
          ? `Profile ${profile} already has a running browser; use puppeteer_connect_browser.`
          : `Profile ${profile} is in use by Chrome${occupancy.pid ? ` (PID ${occupancy.pid})` : ""}, but it has no usable debugging endpoint. Close that browser before launching it through this MCP.`,
      );
    }

    if (!profileExists) {
      mkdirSync(dirname(profileDir), { recursive: true, mode: 0o700 });
      mkdirSync(profileDir, { mode: 0o700 });
    }
    adoptProfile(profile);
    const activePortFile = activePortFileFor(profile);
    if (existsSync(activePortFile)) unlinkSync(activePortFile);
    browserSessions.delete(profile);

    const child = spawn(CHROME_PATH, chromeArguments(profileDir), {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, DISPLAY },
    });
    child.launchError = null;
    child.once("error", (error) => {
      child.launchError = error;
    });
    child.unref();
    return await waitForProfile(profile, child);
  } finally {
    await releaseLock();
  }
}

async function ensureBrowser() {
  if (!activeProfileName) {
    throw new Error(
      "No active browser. Launch, connect, or switch to a browser profile first.",
    );
  }
  const session = browserSessions.get(activeProfileName);
  if (!session?.browser?.connected) {
    return (await connectProfile(activeProfileName)).page;
  }
  if (session.page && !session.page.isClosed()) return session.page;
  const pages = await session.browser.pages();
  session.page = pages[0] || (await session.browser.newPage());
  return session.page;
}

function managedProfileNames() {
  const names = new Set();
  if (existsSync(DEFAULT_PROFILE_DIR)) names.add("default");
  if (existsSync(PROFILES_DIR)) {
    for (const entry of readdirSync(PROFILES_DIR, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        entry.name !== ".locks" &&
        PROFILE_NAME_PATTERN.test(entry.name)
      ) {
        names.add(entry.name);
      }
    }
  }
  return [...names].sort((a, b) =>
    a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b),
  );
}

async function profileDetails(profile) {
  const session = browserSessions.get(profile);
  const occupancy = await profileOccupancy(profile);
  return {
    profile,
    path: profileDirFor(profile),
    running: occupancy.occupied,
    connectable: occupancy.debuggable,
    managedByMcp: Boolean(readAndValidateProfileMarker(profile)),
    connected: Boolean(session?.browser?.connected),
    active: profile === activeProfileName,
  };
}

function chooseNextActiveProfile() {
  activeProfileName =
    [...browserSessions.entries()].find(([, session]) =>
      Boolean(session.browser?.connected),
    )?.[0] || null;
}

function disconnectProfile(profile) {
  const session = browserSessions.get(profile);
  if (session?.browser?.connected) session.browser.disconnect();
  browserSessions.delete(profile);
  if (activeProfileName === profile) chooseNextActiveProfile();
}

async function waitForProfileToStop(profile) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!(await profileOccupancy(profile)).occupied) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Browser for profile ${profile} did not stop within 5 seconds.`);
}

async function closeProfile(profile, deleteProfile) {
  const releaseLock = await acquireLifecycleLock(profile);
  try {
    assertProfileIsNotSymlink(profile);
    if (deleteProfile) assertProfileOwned(profile);
    const occupancy = await profileOccupancy(profile);
    if (occupancy.debuggable) {
      let session = browserSessions.get(profile);
      if (!session?.browser?.connected) session = await connectProfile(profile);
      await session.browser.close();
      browserSessions.delete(profile);
      if (activeProfileName === profile) chooseNextActiveProfile();
      await waitForProfileToStop(profile);
    } else if (occupancy.occupied) {
      throw new Error(
        `Profile ${profile} is in use by Chrome${occupancy.pid ? ` (PID ${occupancy.pid})` : ""}, but it has no usable debugging endpoint. Close it from its owning process before using this tool.`,
      );
    } else {
      disconnectProfile(profile);
    }

    if (deleteProfile) {
      const profileDir = profileDirFor(profile);
      if ((await profileOccupancy(profile)).occupied) {
        throw new Error(`Refusing to delete running profile ${profile}.`);
      }
      rmSync(profileDir, { recursive: true, force: true });
    }
  } finally {
    await releaseLock();
  }
}

// ── Helpers ──

async function pageViewportSize(page) {
  const viewport = page.viewport();
  if (viewport) return { width: viewport.width, height: viewport.height };
  return await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
}

async function randomMouseMove(p) {
  const vp = await pageViewportSize(p);
  await p.mouse.move(Math.random() * vp.width, Math.random() * vp.height);
}

function findFrame(p, frameUrlPattern) {
  const frames = p.frames();
  const matches = frames.filter((frame) => frame.url().includes(frameUrlPattern));
  if (matches.length === 0) {
    const available = frames.map((f) => f.url().substring(0, 60)).join(", ");
    throw new Error(
      `No frame found matching "${frameUrlPattern}". Available: ${available}`,
    );
  }
  if (matches.length > 1) {
    const matchedUrls = matches.map((frame) => frame.url()).join(", ");
    throw new Error(
      `Frame URL pattern "${frameUrlPattern}" is ambiguous. Matches: ${matchedUrls}`,
    );
  }
  return matches[0];
}

// ── MCP Server ──

const server = new McpServer(
  { name: "chrome-mcp", version: "1.0.0" },
  {
    instructions:
      "Manage persistent Chrome processes and automate their pages with Puppeteer. " +
      "Start by listing browser profiles. For the chosen profile: connect if it is running " +
      "and connectable, ask the user to close it externally if it is running but not connectable, " +
      "launch with profileAction=reuse if it exists but is stopped, or launch with " +
      "profileAction=create if it does not exist. Page tools always target the active page " +
      "of the active browser profile; use the switch tools before acting elsewhere. " +
      "One Chrome process may own a profile at a time, but multiple MCP clients may connect " +
      "to that process. Disconnect only detaches this MCP. Close stops the shared process; " +
      "deleteProfile=true also permanently deletes its browsing data.",
  },
);

server.tool(
  "puppeteer_list_browser_profiles",
  "List all Chrome profile directories under the configured roots. For each profile, returns its path; whether any Chrome process is using it; whether that process is connectable; whether it has been adopted by this MCP; and whether it is connected and active here. Use this first to decide whether to launch, connect, or switch.",
  {},
  async () => {
    const profiles = await Promise.all(
      managedProfileNames().map((profile) => profileDetails(profile)),
    );
    return {
      content: [
        {
          type: "text",
          text: `Browser profiles:\n${JSON.stringify(profiles, null, 2)}`,
        },
      ],
    };
  },
);

server.tool(
  "puppeteer_launch_browser",
  "Launch a persistent Chrome process for one profile, connect this MCP to it, and make it active. Use create only when the profile does not exist; use reuse only when it exists and is stopped. Reuse also safely adopts an existing unmarked profile so it can later be deleted explicitly. If it is already running and connectable, use puppeteer_connect_browser. The process remains running until explicitly closed.",
  {
    profile: profileNameSchema("Profile to launch"),
    profileAction: z
      .enum(["create", "reuse"])
      .describe(
        'Use "create" for a profile that does not exist, or "reuse" for an existing stopped profile',
      ),
  },
  async ({ profile, profileAction }) => {
    const session = await launchProfile(profile, profileAction);
    const pages = await session.browser.pages();
    return {
      content: [
        {
          type: "text",
          text: `Launched browser profile ${profile} with ${pages.length} open page(s).`,
        },
      ],
    };
  },
);

server.tool(
  "puppeteer_connect_browser",
  "Connect this MCP to an already running Chrome process and make that profile active. This does not start another process or resize existing pages; it shares the existing tabs, cookies, and login state.",
  {
    profile: profileNameSchema("Running profile to connect to"),
  },
  async ({ profile }) => {
    if (!existsSync(profileDirFor(profile))) {
      throw new Error(`Profile ${profile} does not exist.`);
    }
    const session = await connectProfile(profile);
    const pages = await session.browser.pages();
    return {
      content: [
        {
          type: "text",
          text: `Connected to browser profile ${profile} with ${pages.length} open page(s).`,
        },
      ],
    };
  },
);

server.tool(
  "puppeteer_switch_browser",
  "Make a browser profile already connected by this MCP active, so subsequent page tools target it. This does not launch or connect to a process.",
  {
    profile: profileNameSchema("Connected profile to make active"),
  },
  async ({ profile }) => {
    const session = browserSessions.get(profile);
    if (!session?.browser?.connected) {
      throw new Error(
        `Profile ${profile} is not connected in this MCP; launch or connect first.`,
      );
    }
    activeProfileName = profile;
    const pages = await session.browser.pages();
    return {
      content: [
        {
          type: "text",
          text: `Switched to browser profile ${profile} with ${pages.length} open page(s).`,
        },
      ],
    };
  },
);

server.tool(
  "puppeteer_disconnect_browser",
  "Detach only this MCP from a connected browser profile. The Chrome process, tabs, profile data, and other MCP client connections remain intact.",
  {
    profile: profileNameSchema("Connected profile to detach from"),
  },
  async ({ profile }) => {
    if (!browserSessions.has(profile)) {
      throw new Error(`Profile ${profile} is not connected in this MCP.`);
    }
    disconnectProfile(profile);
    return {
      content: [
        {
          type: "text",
          text: `Disconnected from browser profile ${profile}; Chrome remains running.`,
        },
      ],
    };
  },
);

server.tool(
  "puppeteer_close_browser",
  "Stop the Chrome process that owns a profile, even if this MCP is not currently connected. This disconnects every client sharing that process. Normally preserve the profile with deleteProfile=false; true permanently deletes all browsing data only when the profile has previously been created or adopted by this MCP.",
  {
    profile: profileNameSchema("Profile whose Chrome process should stop"),
    deleteProfile: z
      .boolean()
      .describe(
        "False preserves cookies and browsing data for later reuse; true permanently deletes the entire profile",
      ),
  },
  async ({ profile, deleteProfile }) => {
    if (!existsSync(profileDirFor(profile))) {
      throw new Error(`Profile ${profile} does not exist.`);
    }
    await closeProfile(profile, deleteProfile);
    return {
      content: [
        {
          type: "text",
          text: deleteProfile
            ? `Closed browser and deleted profile ${profile}.`
            : `Closed browser and preserved profile ${profile}.`,
        },
      ],
    };
  },
);

server.tool(
  "puppeteer_navigate",
  "Navigate the active page of the active browser profile to a URL and wait for DOMContentLoaded (30-second timeout).",
  {
    url: z
      .string()
      .min(1)
      .describe('Destination URL, normally including a scheme such as "https://"'),
  },
  async ({ url }) => {
    const p = await ensureBrowser();
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    return { content: [{ type: "text", text: `Navigated to ${url}` }] };
  },
);

server.tool(
  "puppeteer_list_pages",
  "List all open pages in the active browser profile, returning each page's current index, title, URL, and whether it is the active page. Use the returned index with page switch or close tools.",
  {},
  async () => {
    await ensureBrowser();
    const session = browserSessions.get(activeProfileName);
    const pages = await session.browser.pages();
    const result = await Promise.all(
      pages.map(async (candidate, index) => ({
        index,
        active: candidate === session.page,
        title: await candidate.title(),
        url: candidate.url(),
      })),
    );
    return {
      content: [
        {
          type: "text",
          text: `Browser profile ${activeProfileName} pages:\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  },
);

server.tool(
  "puppeteer_new_page",
  "Open a new page in the active browser profile, optionally navigate it to a URL, and make it the active page.",
  {
    url: z
      .string()
      .min(1)
      .optional()
      .describe("URL to open; omit to open about:blank"),
  },
  async ({ url }) => {
    await ensureBrowser();
    const session = browserSessions.get(activeProfileName);
    session.page = await session.browser.newPage();
    if (url) {
      await session.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    }
    await session.page.bringToFront();
    const pages = await session.browser.pages();
    return {
      content: [
        {
          type: "text",
          text: `Opened page ${pages.indexOf(session.page)}: ${session.page.url()}`,
        },
      ],
    };
  },
);

server.tool(
  "puppeteer_switch_page",
  "Make a page in the active browser profile active using its index from the latest puppeteer_list_pages result.",
  {
    index: z.number().int().nonnegative().describe("Page index to activate"),
  },
  async ({ index }) => {
    await ensureBrowser();
    const session = browserSessions.get(activeProfileName);
    const pages = await session.browser.pages();
    if (index >= pages.length) {
      throw new Error(
        `Invalid page index ${index}. Available indexes: 0-${pages.length - 1}`,
      );
    }
    session.page = pages[index];
    await session.page.bringToFront();
    return {
      content: [
        {
          type: "text",
          text: `Switched to page ${index}: ${await session.page.title()} (${session.page.url()})`,
        },
      ],
    };
  },
);

server.tool(
  "puppeteer_close_page",
  "Close a page in the active browser profile using its index from the latest puppeteer_list_pages result. If it is the last page, a new blank page is created.",
  {
    index: z.number().int().nonnegative().describe("Page index to close"),
  },
  async ({ index }) => {
    await ensureBrowser();
    const session = browserSessions.get(activeProfileName);
    const pages = await session.browser.pages();
    if (index >= pages.length) {
      throw new Error(
        `Invalid page index ${index}. Available indexes: 0-${pages.length - 1}`,
      );
    }

    const target = pages[index];
    if (target === session.page) {
      session.page = pages.find((candidate) => candidate !== target);
      if (!session.page) {
        session.page = await session.browser.newPage();
      }
    }
    await target.close();
    await session.page.bringToFront();
    return {
      content: [
        {
          type: "text",
          text: `Closed page ${index}. Active page: ${session.page.url()}`,
        },
      ],
    };
  },
);

server.tool(
  "puppeteer_screenshot",
  "Return an inline PNG screenshot of the active page or one element. Omit width and height to preserve the current viewport; explicitly passing either changes the active page viewport and keeps that change. Use this for visual verification and puppeteer_evaluate for structured data. The screenshot is not saved to disk.",
  {
    name: z
      .string()
      .min(1)
      .describe("Descriptive label returned with the image; this is not a filename"),
    selector: z
      .string()
      .min(1)
      .optional()
      .describe("CSS selector for one element; omit to capture the viewport"),
    width: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Optional viewport width in pixels; omit to keep the current width"),
    height: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Optional viewport height in pixels; omit to keep the current height"),
  },
  async ({ name, selector, width, height }) => {
    const p = await ensureBrowser();
    if (width || height) {
      const vp = await pageViewportSize(p);
      const nextViewport = {
        width: width || vp.width,
        height: height || vp.height,
      };
      if (vp.width !== nextViewport.width || vp.height !== nextViewport.height) {
        await p.setViewport(nextViewport);
      }
    }

    const buf = selector
      ? await (async () => {
          const el = await p.$(selector);
          return el?.screenshot();
        })()
      : await p.screenshot();

    if (!buf) throw new Error(`Element not found: ${selector}`);

    const vp = await pageViewportSize(p);
    const base64 = Buffer.from(buf).toString("base64");
    return {
      content: [
        {
          type: "text",
          text: `Screenshot '${name}' taken at ${vp.width}x${vp.height}`,
        },
        { type: "image", data: base64, mimeType: "image/png" },
      ],
    };
  },
);

server.tool(
  "puppeteer_click",
  "Click an element in the active page's main frame using a CSS selector. For an iframe, use puppeteer_frame_click.",
  {
    selector: z.string().min(1).describe("CSS selector of the element to click"),
  },
  async ({ selector }) => {
    const p = await ensureBrowser();
    await randomMouseMove(p);
    await p.click(selector);
    return { content: [{ type: "text", text: `Clicked: ${selector}` }] };
  },
);

server.tool(
  "puppeteer_click_xy",
  "Click exact viewport coordinates in the active page. Use only when selector-based clicking is unsuitable, such as canvas content. Do not estimate coordinates from a rendered screenshot; obtain them with puppeteer_evaluate and getBoundingClientRect().",
  {
    x: z
      .number()
      .describe("X coordinate in pixels from the left edge of the viewport"),
    y: z
      .number()
      .describe("Y coordinate in pixels from the top edge of the viewport"),
  },
  async ({ x, y }) => {
    const p = await ensureBrowser();
    await randomMouseMove(p);
    await p.mouse.click(x, y);
    return {
      content: [{ type: "text", text: `Clicked at coordinates (${x}, ${y})` }],
    };
  },
);

server.tool(
  "puppeteer_fill",
  "Replace the current value of an input or textarea in the active page's main frame, typing the new value with human-like delays.",
  {
    selector: z.string().min(1).describe("CSS selector for the input or textarea"),
    value: z.string().describe("Value to fill"),
  },
  async ({ selector, value }) => {
    const p = await ensureBrowser();
    await p.click(selector, { clickCount: 3 });
    await p.type(selector, value, { delay: 50 + Math.random() * 80 });
    return {
      content: [{ type: "text", text: `Filled ${selector}.` }],
    };
  },
);

server.tool(
  "puppeteer_select",
  "Select an option in a native HTML <select> element in the active page's main frame, using the option value rather than its visible label.",
  {
    selector: z.string().min(1).describe("CSS selector for the <select> element"),
    value: z.string().describe("Exact value attribute of the option to select"),
  },
  async ({ selector, value }) => {
    const p = await ensureBrowser();
    await p.select(selector, value);
    return {
      content: [{ type: "text", text: `Selected ${value} in ${selector}` }],
    };
  },
);

server.tool(
  "puppeteer_hover",
  "Move the mouse over an element in the active page's main frame using a CSS selector.",
  { selector: z.string().min(1).describe("CSS selector of the element to hover") },
  async ({ selector }) => {
    const p = await ensureBrowser();
    await p.hover(selector);
    return { content: [{ type: "text", text: `Hovered: ${selector}` }] };
  },
);

server.tool(
  "puppeteer_evaluate",
  "Execute JavaScript in the active page's main-frame context and return its JSON-serializable result. Prefer this over screenshots for extracting text, links, lists, tables, or page state. For iframe content, use puppeteer_frame_evaluate.",
  {
    script: z
      .string()
      .min(1)
      .describe("JavaScript expression or code to execute in the page context"),
  },
  async ({ script }) => {
    const p = await ensureBrowser();
    const result = await p.evaluate(script);
    return {
      content: [
        {
          type: "text",
          text: `Execution result:\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  },
);

server.tool(
  "puppeteer_frame_click",
  "Click an element inside an iframe of the active page. The iframe is selected by a unique substring of its URL. Use puppeteer_frame_evaluate for DOM extraction or custom frame logic.",
  {
    frameUrlPattern: z
      .string()
      .min(1)
      .describe(
        "Substring to match against frame URL (e.g. 'bframe', 'recaptcha')",
      ),
    selector: z.string().min(1).describe("CSS selector inside the matched iframe"),
  },
  async ({ frameUrlPattern, selector }) => {
    const p = await ensureBrowser();
    const frame = findFrame(p, frameUrlPattern);
    await frame.click(selector);
    return {
      content: [
        {
          type: "text",
          text: `Clicked "${selector}" in frame matching "${frameUrlPattern}"`,
        },
      ],
    };
  },
);

server.tool(
  "puppeteer_frame_evaluate",
  "Execute JavaScript inside an iframe of the active page and return its JSON-serializable result. The iframe is selected by a unique substring of its URL.",
  {
    frameUrlPattern: z
      .string()
      .min(1)
      .describe("Substring to match against frame URL"),
    script: z
      .string()
      .min(1)
      .describe("JavaScript expression or code to execute in the matched iframe"),
  },
  async ({ frameUrlPattern, script }) => {
    const p = await ensureBrowser();
    const frame = findFrame(p, frameUrlPattern);
    const result = await frame.evaluate(script);
    return {
      content: [
        {
          type: "text",
          text: `Frame result:\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  },
);

// ── Start ──

const transport = new StdioServerTransport();
await server.connect(transport);
process.stdin.resume();
