import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
  parseNpmSource,
  pinInstalledPackages,
  updatePackages,
} from "./index.ts";

function fakePi(exec: ExtensionAPI["exec"]): ExtensionAPI {
  return { exec } as ExtensionAPI;
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

    const result = await pinInstalledPackages(cwd, true);
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

    const result = await pinInstalledPackages(cwd, false);
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

    assert.deepEqual(await listPackages(cwd, false), [
      { name: "current", scope: "user", current: "1.0.0" },
      { name: "outdated", scope: "user", current: "1.0.0" },
      { name: "unavailable", scope: "user", current: "1.0.0" },
    ]);

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
