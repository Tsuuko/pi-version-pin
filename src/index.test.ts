import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  SettingsManager,
  type ExecResult,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import {
  checkPackages,
  formatReport,
  isExactVersion,
  latestVersion,
  listPackages,
  mapInBatches,
  parseGitSource,
  parseNpmSource,
  pinInstalledPackages,
  updatePackages,
} from "./index.ts";

const runCommand = promisify(execFile);
const gitAvailable = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

function fakePi(exec: ExtensionAPI["exec"]): ExtensionAPI {
  return { exec } as ExtensionAPI;
}

// Delegates to the real command, so git fixtures run offline against local repositories.
function realPi(): ExtensionAPI {
  return fakePi(async (command, args, options) => {
    try {
      const { stdout, stderr } = await runCommand(command, args, {
        timeout: options?.timeout,
        windowsHide: true,
      });
      return { stdout, stderr, code: 0, killed: false };
    } catch (error) {
      const failure = error as {
        stdout?: string;
        stderr?: string;
        code?: number;
        killed?: boolean;
      };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? String(error),
        code: failure.code ?? 1,
        killed: failure.killed ?? false,
      };
    }
  });
}

async function runGit(args: string[]): Promise<string> {
  const { stdout } = await runCommand("git", args, { windowsHide: true });
  return stdout;
}

function execResult(stdout = "", stderr = "", code = 0): ExecResult {
  return { stdout, stderr, code, killed: false };
}

async function writeManifest(path: string, name: string, version: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), JSON.stringify({ name, version }));
}

// Tests using this fixture must stay sequential because the agent directory is process-global.
async function withTempAgent(
  run: (dirs: { root: string; agentDir: string; cwd: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-version-pin-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await run({ root, agentDir, cwd });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

void test("parses npm package sources", () => {
  assert.deepEqual(parseNpmSource("npm:pi-chrome"), { name: "pi-chrome" });
  assert.deepEqual(parseNpmSource("npm:pi-chrome@1.2.3"), {
    name: "pi-chrome",
    version: "1.2.3",
  });
  assert.deepEqual(parseNpmSource("npm:@scope/package@2.0.0-beta.1"), {
    name: "@scope/package",
    version: "2.0.0-beta.1",
  });
  assert.equal(parseNpmSource("git:github.com/example/package"), undefined);
  assert.equal(parseNpmSource("npm:"), undefined);
  assert.deepEqual(parseNpmSource("npm:package@latest"), {
    name: "package",
    version: "latest",
  });
  assert.deepEqual(parseNpmSource("npm:@scope/package@^1.2.3"), {
    name: "@scope/package",
    version: "^1.2.3",
  });
});

void test("recognizes exact npm versions", () => {
  assert.equal(isExactVersion("1.2.3"), true);
  assert.equal(isExactVersion("1.2.3-beta.1+build.2"), true);
  assert.equal(isExactVersion("^1.2.3"), false);
  assert.equal(isExactVersion("latest"), false);
  assert.equal(isExactVersion("1.2"), false);
  assert.equal(isExactVersion("v1.2.3"), false);
  assert.equal(isExactVersion("01.2.3"), false);
  assert.equal(isExactVersion(undefined), false);
});

void test("parses git package sources", () => {
  assert.deepEqual(parseGitSource("git:github.com/user/repo"), {
    base: "git:github.com/user/repo",
    name: "github.com/user/repo",
  });
  assert.deepEqual(parseGitSource("git:github.com/user/repo@v1.2.0"), {
    base: "git:github.com/user/repo",
    ref: "v1.2.0",
    name: "github.com/user/repo",
  });
  assert.deepEqual(parseGitSource("https://github.com/user/repo@feature/x"), {
    base: "https://github.com/user/repo",
    ref: "feature/x",
    name: "github.com/user/repo",
  });
  assert.deepEqual(parseGitSource("git:git@github.com:user/repo"), {
    base: "git:git@github.com:user/repo",
    name: "github.com/user/repo",
  });
  assert.deepEqual(parseGitSource("git:git@github.com:user/repo@v1"), {
    base: "git:git@github.com:user/repo",
    ref: "v1",
    name: "github.com/user/repo",
  });
  assert.deepEqual(parseGitSource("ssh://git@github.com/user/repo.git@v1"), {
    base: "ssh://git@github.com/user/repo.git",
    ref: "v1",
    name: "github.com/user/repo",
  });
  assert.equal(parseGitSource("npm:foo"), undefined);
  assert.equal(parseGitSource("github.com/user/repo"), undefined);
  assert.equal(parseGitSource("./local-package"), undefined);
});

void test("formats commit hashes short in reports", () => {
  const hash = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(
    formatReport([
      { name: "github.com/u/r", current: hash, latest: hash },
      { name: "npm-pkg", current: "1.0.0" },
    ]),
    ["github.com/u/r  0123456  ✓ latest", "npm-pkg         1.0.0"].join("\n"),
  );
});

void test("maps at most five items concurrently", async () => {
  let active = 0;
  let maxActive = 0;
  const results = await mapInBatches([...Array(12).keys()], async (value) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return value * 2;
  });

  assert.equal(maxActive, 5);
  assert.deepEqual(
    results,
    [...Array(12).keys()].map((value) => value * 2),
  );
});

void test("queries latest through the configured npm command", async () => {
  const settings = SettingsManager.inMemory({
    npmCommand: ["mise", "exec", "node@24", "--", "npm"],
  });
  const calls: Array<{ command: string; args: string[]; timeout?: number }> = [];
  const pi = fakePi(async (command, args, options) => {
    calls.push({ command, args, timeout: options?.timeout });
    return execResult('"1.2.3"\n');
  });

  assert.equal(await latestVersion(pi, settings, "@scope/package"), "1.2.3");
  assert.deepEqual(calls, [
    {
      command: "mise",
      args: ["exec", "node@24", "--", "npm", "view", "@scope/package@latest", "version", "--json"],
      timeout: 15_000,
    },
  ]);
});

void test("rejects failed and invalid npm responses", async () => {
  const settings = SettingsManager.inMemory();

  await assert.rejects(
    latestVersion(
      fakePi(async () => execResult("", "registry unavailable\n", 1)),
      settings,
      "package",
    ),
    /registry unavailable/,
  );
  await assert.rejects(
    latestVersion(
      fakePi(async () => execResult('"latest"')),
      settings,
      "package",
    ),
    /invalid version/,
  );
  await assert.rejects(
    latestVersion(
      fakePi(async () => execResult("not json")),
      settings,
      "package",
    ),
    /Unexpected token|not valid JSON/,
  );
});

void test("pins installed global and project packages", async () => {
  await withTempAgent(async ({ agentDir, cwd }) => {
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        packages: [
          { source: "npm:demo", extensions: ["extensions/main.ts"] },
          "npm:exact@4.5.6",
          "npm:missing",
          "npm:wrong-name",
          "npm:invalid-version",
          "git:github.com/example/package",
          "./local-package",
        ],
      }),
    );
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        packages: [
          "npm:@scope/project@latest",
          { source: "npm:demo", autoload: false, extensions: ["+extensions/main.ts"] },
        ],
      }),
    );
    await writeManifest(join(agentDir, "npm", "node_modules", "demo"), "demo", "1.2.3");
    await writeManifest(join(agentDir, "npm", "node_modules", "exact"), "exact", "4.5.6");
    await writeManifest(
      join(agentDir, "npm", "node_modules", "wrong-name"),
      "different-name",
      "1.0.0",
    );
    await writeManifest(
      join(agentDir, "npm", "node_modules", "invalid-version"),
      "invalid-version",
      "latest",
    );
    await writeManifest(
      join(cwd, ".pi", "npm", "node_modules", "@scope", "project"),
      "@scope/project",
      "2.3.4",
    );

    const result = await pinInstalledPackages(
      fakePi(async () => execResult()),
      cwd,
      true,
    );
    const globalSettings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
    const projectSettings = JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8"));

    assert.deepEqual(result.errors, [
      { name: "missing", scope: "user", current: "?", error: "Package is not installed" },
      {
        name: "wrong-name",
        scope: "user",
        current: "?",
        error: "Installed package name is different-name",
      },
      {
        name: "invalid-version",
        scope: "user",
        current: "?",
        error: "Invalid installed version: latest",
      },
      {
        name: "github.com/example/package",
        scope: "user",
        current: "?",
        error: "Package is not installed",
      },
    ]);
    assert.deepEqual(new Set(result.pinned), new Set(["demo@1.2.3", "@scope/project@2.3.4"]));
    assert.deepEqual(globalSettings.packages, [
      { source: "npm:demo@1.2.3", extensions: ["extensions/main.ts"] },
      "npm:exact@4.5.6",
      "npm:missing",
      "npm:wrong-name",
      "npm:invalid-version",
      "git:github.com/example/package",
      "./local-package",
    ]);
    assert.deepEqual(projectSettings.packages, [
      "npm:@scope/project@2.3.4",
      { source: "npm:demo", autoload: false, extensions: ["+extensions/main.ts"] },
    ]);
  });
});

void test("ignores project packages when the project is untrusted", async () => {
  await withTempAgent(async ({ agentDir, cwd }) => {
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:global-package"] }),
    );
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ packages: ["npm:project-package"] }),
    );
    await writeManifest(
      join(agentDir, "npm", "node_modules", "global-package"),
      "global-package",
      "1.0.0",
    );
    await writeManifest(
      join(cwd, ".pi", "npm", "node_modules", "project-package"),
      "project-package",
      "2.0.0",
    );

    const result = await pinInstalledPackages(
      fakePi(async () => execResult()),
      cwd,
      false,
    );
    const globalSettings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
    const projectSettings = JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8"));

    assert.deepEqual(result, { pinned: ["global-package@1.0.0"], errors: [] });
    assert.deepEqual(globalSettings.packages, ["npm:global-package@1.0.0"]);
    assert.deepEqual(projectSettings.packages, ["npm:project-package"]);
  });
});

void test("lists current packages and checks latest versions", async () => {
  await withTempAgent(async ({ agentDir, cwd }) => {
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:current", "npm:outdated", "npm:unavailable"] }),
    );
    await writeManifest(join(agentDir, "npm", "node_modules", "current"), "current", "1.0.0");
    await writeManifest(join(agentDir, "npm", "node_modules", "outdated"), "outdated", "1.0.0");
    await writeManifest(
      join(agentDir, "npm", "node_modules", "unavailable"),
      "unavailable",
      "1.0.0",
    );

    assert.deepEqual(
      await listPackages(
        fakePi(async () => execResult()),
        cwd,
        false,
      ),
      [
        { name: "current", scope: "user", current: "1.0.0" },
        { name: "outdated", scope: "user", current: "1.0.0" },
        { name: "unavailable", scope: "user", current: "1.0.0" },
      ],
    );

    const pi = fakePi(async (_command, args) => {
      const target = args.at(-3);
      if (target === "unavailable@latest") return execResult("", "registry down", 1);
      return execResult(JSON.stringify(target === "outdated@latest" ? "2.0.0" : "1.0.0"));
    });

    assert.deepEqual(await checkPackages(pi, cwd, false), [
      { name: "current", scope: "user", current: "1.0.0", latest: "1.0.0" },
      { name: "outdated", scope: "user", current: "1.0.0", latest: "2.0.0" },
      {
        name: "unavailable",
        scope: "user",
        current: "1.0.0",
        error: "registry down",
      },
    ]);
  });
});

void test("updates available packages, pins unchanged packages, and continues after lookup errors", async () => {
  await withTempAgent(async ({ root, agentDir, cwd }) => {
    // DefaultPackageManager runs this configured command, keeping the update test offline.
    const installer = join(root, "fake-npm.mjs");
    const installLog = join(root, "installs.log");
    await writeFile(
      installer,
      `import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] !== "install") process.exit(2);
const spec = args[1];
const split = spec.lastIndexOf("@");
const name = spec.slice(0, split);
const version = spec.slice(split + 1);
const prefix = args[args.indexOf("--prefix") + 1];
const target = join(prefix, "node_modules", name);
await mkdir(target, { recursive: true });
await writeFile(join(target, "package.json"), JSON.stringify({ name, version }));
await appendFile(${JSON.stringify(installLog)}, spec + "\\n");
`,
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        npmCommand: [process.execPath, installer],
        packages: ["npm:outdated", "npm:current", "npm:unavailable"],
      }),
    );
    await writeManifest(join(agentDir, "npm", "node_modules", "outdated"), "outdated", "1.0.0");
    await writeManifest(join(agentDir, "npm", "node_modules", "current"), "current", "3.0.0");
    await writeManifest(
      join(agentDir, "npm", "node_modules", "unavailable"),
      "unavailable",
      "1.0.0",
    );

    const pi = fakePi(async (_command, args) => {
      const target = args.at(-3);
      if (target === "unavailable@latest") return execResult("", "registry down", 1);
      return execResult(JSON.stringify(target === "outdated@latest" ? "2.0.0" : "3.0.0"));
    });

    const result = await updatePackages(pi, cwd, false);
    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));

    assert.equal(result.needsReload, true);
    assert.deepEqual(result.rows, [
      { name: "outdated", scope: "user", current: "1.0.0", latest: "2.0.0" },
      { name: "current", scope: "user", current: "3.0.0", latest: "3.0.0" },
      {
        name: "unavailable",
        scope: "user",
        current: "1.0.0",
        error: "registry down",
      },
    ]);
    assert.deepEqual(settings.packages, [
      "npm:outdated@2.0.0",
      "npm:current@3.0.0",
      "npm:unavailable",
    ]);
    assert.equal(await readFile(installLog, "utf8"), "outdated@2.0.0\n");
  });
});

void test("formats aligned package reports", () => {
  assert.equal(formatReport([{ name: "pi-chrome", current: "0.15.38" }]), "pi-chrome  0.15.38");
  assert.equal(
    formatReport([
      { name: "pi-chrome", current: "0.15.38", latest: "0.15.41" },
      { name: "pi-web-access", current: "1.8.2", latest: "1.8.2" },
      { name: "pi-tps-status", current: "0.4.1", error: "network\nfailed" },
    ]),
    [
      "pi-chrome      0.15.38  → 0.15.41",
      "pi-web-access  1.8.2    ✓ latest",
      "pi-tps-status  0.4.1    ! network failed",
    ].join("\n"),
  );
  assert.equal(formatReport([]), "");
  assert.equal(
    formatReport([
      { name: "same", scope: "user", current: "1.0.0", latest: "1.0.0" },
      { name: "same", scope: "project", current: "2.0.0", latest: "2.1.0" },
    ]),
    ["same (user)     1.0.0  ✓ latest", "same (project)  2.0.0  → 2.1.0"].join("\n"),
  );
});

// Builds a bare origin plus a clone at the path pi would install it to (git sources
// resolve to <agentDir>/git/<host>/<path> regardless of ref).
async function makeGitFixture(
  root: string,
  clonePath: string,
): Promise<{ head: string; work: string }> {
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  await runGit(["init", "--bare", "-q", origin]);
  await runGit(["init", "-q", work]);
  await runGit(["-C", work, "config", "user.email", "test@example.com"]);
  await runGit(["-C", work, "config", "user.name", "test"]);
  await runGit(["-C", work, "commit", "--allow-empty", "-q", "-m", "one"]);
  await runGit(["-C", work, "remote", "add", "origin", origin]);
  await runGit(["-C", work, "push", "-q", "-u", "origin", "HEAD"]);
  await runGit(["clone", "-q", origin, clonePath]);
  await runGit(["-C", clonePath, "remote", "set-url", "origin", origin]);
  const head = (await runGit(["-C", clonePath, "rev-parse", "HEAD"])).trim();
  return { head, work };
}

void test("pins git packages to commit hashes", { skip: !gitAvailable }, async () => {
  await withTempAgent(async ({ root, agentDir, cwd }) => {
    const clonePath = join(agentDir, "git", "github.com", "example", "pkg");
    const { head } = await makeGitFixture(root, clonePath);
    const settingsPath = join(agentDir, "settings.json");
    const pi = realPi();

    await writeFile(settingsPath, JSON.stringify({ packages: ["git:github.com/example/pkg"] }));
    let result = await pinInstalledPackages(pi, cwd, true);
    assert.deepEqual(result, {
      pinned: [`github.com/example/pkg@${head.slice(0, 7)}`],
      errors: [],
    });
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")).packages, [
      `git:github.com/example/pkg@${head}`,
    ]);

    await writeFile(
      settingsPath,
      JSON.stringify({ packages: [`git:github.com/example/pkg@${head}`] }),
    );
    result = await pinInstalledPackages(pi, cwd, true);
    assert.deepEqual(result, { pinned: [], errors: [] });

    await writeFile(
      settingsPath,
      JSON.stringify({ packages: ["git:github.com/example/pkg@v1.2.0"] }),
    );
    result = await pinInstalledPackages(pi, cwd, true);
    assert.deepEqual(result.pinned, [`github.com/example/pkg@${head.slice(0, 7)}`]);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")).packages, [
      `git:github.com/example/pkg@${head}`,
    ]);
  });
});

void test(
  "checks and updates git packages against the remote head",
  { skip: !gitAvailable },
  async () => {
    await withTempAgent(async ({ root, agentDir, cwd }) => {
      const clonePath = join(agentDir, "git", "github.com", "example", "pkg");
      const { head, work } = await makeGitFixture(root, clonePath);
      const settingsPath = join(agentDir, "settings.json");
      const pi = realPi();
      await writeFile(
        settingsPath,
        JSON.stringify({ packages: ["git:github.com/example/pkg@v1"] }),
      );

      // current == remote HEAD: no install, settings rewritten to the commit hash
      const update = await updatePackages(pi, cwd, true);
      assert.equal(update.needsReload, false);
      assert.deepEqual(update.rows, [
        { name: "github.com/example/pkg", scope: "user", current: head, latest: head },
      ]);
      assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")).packages, [
        `git:github.com/example/pkg@${head}`,
      ]);

      // remote moves ahead: check reports the new head, update falls back to error only if install fails
      await runGit(["-C", work, "commit", "--allow-empty", "-q", "-m", "two"]);
      await runGit(["-C", work, "push", "-q", "origin", "HEAD"]);
      const newHead = (await runGit(["-C", work, "rev-parse", "HEAD"])).trim();

      const rows = await checkPackages(pi, cwd, true);
      assert.deepEqual(rows, [
        { name: "github.com/example/pkg", scope: "user", current: head, latest: newHead },
      ]);
    });
  },
);
