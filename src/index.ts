import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type Scope = "user" | "project";

type PackageKind = "npm" | "git";

type ConfiguredPackage = {
  source: string;
  scope: Scope;
  installedPath?: string;
};

type PackageInfo = ConfiguredPackage & {
  kind: PackageKind;
  name: string;
  current: string;
  // Source rewritten to the installed version; matches pi's ref-ignoring package identity.
  pinnedSource: string;
  pinned: boolean;
};

type ReportRow = {
  name: string;
  scope?: Scope;
  current: string;
  latest?: string;
  error?: string;
};

type ChatEntry = {
  text: string;
};

const CHECK_CONCURRENCY = 5;

// Ranges and tags intentionally fail this check so startup replaces them with the installed version.
const EXACT_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const COMMIT_HASH = /^[0-9a-f]{40}$/i;

export function parseNpmSource(source: string): { name: string; version?: string } | undefined {
  if (!source.startsWith("npm:")) return undefined;

  const spec = source.slice(4).trim();
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  if (!match?.[1]) return undefined;

  return { name: match[1], ...(match[2] ? { version: match[2] } : {}) };
}

export function isExactVersion(version: string | undefined): boolean {
  return version !== undefined && EXACT_VERSION.test(version);
}

export function isCommitHash(ref: string | undefined): boolean {
  return ref !== undefined && COMMIT_HASH.test(ref);
}
// Mirrors pi's splitRef: the first "@" inside the repo path separates the ref;
// a leading "git@host:" is the scp-like user, not a ref separator.
// cutAt splits [repo][at][ref]; returns undefined when either side is empty.
function cutAt(value: string, at: number): { repo: string; ref: string } | undefined {
  const repo = value.slice(0, at);
  const ref = value.slice(at + 1);
  return repo && ref ? { repo, ref } : undefined;
}

function splitGitRef(spec: string): { repo: string; ref?: string } {
  const scp = spec.match(/^git@([^:]+):(.+)$/);
  if (scp) {
    const [, host = "", path = ""] = scp;
    const split = path.indexOf("@") >= 0 ? cutAt(path, path.indexOf("@")) : undefined;
    return split ? { repo: `git@${host}:${split.repo}`, ref: split.ref } : { repo: spec };
  }
  if (/^[a-z]+:\/\//i.test(spec)) {
    let url: URL;
    try {
      url = new URL(spec);
    } catch {
      return { repo: spec };
    }
    const path = url.pathname.replace(/^\/+/, "");
    const at = path.indexOf("@");
    const split = at >= 0 ? cutAt(path, at) : undefined;
    if (!split) return { repo: spec };
    url.pathname = `/${split.repo}`;
    return { repo: url.toString().replace(/\/$/, ""), ref: split.ref };
  }
  const slash = spec.indexOf("/");
  if (slash < 0) return { repo: spec };
  const at = spec.indexOf("@", slash);
  const split = at >= 0 ? cutAt(spec, at) : undefined;
  return split ?? { repo: spec };
}

export function parseGitSource(
  source: string,
): { base: string; ref?: string; name: string } | undefined {
  const prefixed = source.startsWith("git:");
  const spec = prefixed ? source.slice(4).trim() : source;
  if (!prefixed && !/^(?:https?|ssh|git):\/\//i.test(spec)) return undefined;

  const { repo, ref } = splitGitRef(spec);
  const name = repo
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^git@/, "")
    .replace(/\.git$/, "");
  if (!name.includes("/")) return undefined;
  return { base: prefixed ? `git:${repo}` : repo, ...(ref ? { ref } : {}), name };
}

function sourceId(source: string): string | undefined {
  return parseNpmSource(source)?.name ?? parseGitSource(source)?.name;
}

function shortHash(value: string): string {
  return COMMIT_HASH.test(value) ? value.slice(0, 7) : value;
}

export function formatReport(rows: ReportRow[]): string {
  if (rows.length === 0) return "";

  const duplicateNames = new Set(
    rows
      .filter((row, index) => rows.findIndex((candidate) => candidate.name === row.name) !== index)
      .map((row) => row.name),
  );
  const displayName = (row: ReportRow) =>
    duplicateNames.has(row.name) && row.scope ? `${row.name} (${row.scope})` : row.name;
  const nameWidth = Math.max(...rows.map((row) => displayName(row).length));
  const versionWidth = Math.max(...rows.map((row) => shortHash(row.current).length));

  return rows
    .map((row) => {
      const prefix = `${displayName(row).padEnd(nameWidth)}  ${shortHash(row.current).padEnd(versionWidth)}`;
      if (row.error) return `${prefix}  ! ${row.error.replace(/\s+/g, " ").trim()}`;
      if (!row.latest) return prefix.trimEnd();
      return row.latest === row.current
        ? `${prefix}  ✓ latest`
        : `${prefix}  → ${shortHash(row.latest)}`;
    })
    .join("\n");
}

function createManagers(cwd: string, projectTrusted: boolean) {
  const agentDir = getAgentDir();
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  // SettingsManager records load failures instead of throwing them.
  const errors: ReportRow[] = settings.drainErrors().map(({ scope, error }) => ({
    name: "settings",
    scope: scope === "global" ? "user" : "project",
    current: "?",
    error: error.message,
  }));
  return { settings, packages, errors };
}

async function gitHead(pi: ExtensionAPI, installedPath: string): Promise<string> {
  const result = await pi.exec("git", ["-C", installedPath, "rev-parse", "HEAD"], {
    timeout: 15_000,
  });
  const hash = result.code === 0 ? result.stdout.trim() : "";
  if (!COMMIT_HASH.test(hash)) {
    throw new Error(
      result.code === 0
        ? `Invalid HEAD: ${result.stdout.trim()}`
        : result.stderr.trim() || `git exited with ${result.code}`,
    );
  }
  return hash;
}

async function readPackageInfo(pi: ExtensionAPI, pkg: ConfiguredPackage): Promise<PackageInfo> {
  if (!pkg.installedPath) throw new Error("Package is not installed");

  const npm = parseNpmSource(pkg.source);
  if (npm) {
    const manifest = JSON.parse(
      await readFile(join(pkg.installedPath, "package.json"), "utf8"),
    ) as {
      name?: unknown;
      version?: unknown;
    };
    if (manifest.name !== npm.name) {
      throw new Error(`Installed package name is ${String(manifest.name)}`);
    }
    if (typeof manifest.version !== "string" || !isExactVersion(manifest.version)) {
      throw new Error(`Invalid installed version: ${String(manifest.version)}`);
    }

    return {
      ...pkg,
      kind: "npm",
      name: npm.name,
      current: manifest.version,
      pinnedSource: `npm:${npm.name}@${manifest.version}`,
      pinned: isExactVersion(npm.version),
    };
  }

  const git = parseGitSource(pkg.source);
  if (!git) throw new Error(`Unsupported package source: ${pkg.source}`);
  const current = await gitHead(pi, pkg.installedPath);
  return {
    ...pkg,
    kind: "git",
    name: git.name,
    current,
    pinnedSource: `${git.base}@${current}`,
    pinned: isCommitHash(git.ref),
  };
}

async function getPackages(
  settings: SettingsManager,
  packages: DefaultPackageManager,
  pi: ExtensionAPI,
): Promise<{ valid: PackageInfo[]; errors: ReportRow[] }> {
  const valid: PackageInfo[] = [];
  const errors: ReportRow[] = [];
  // autoload:false project entries only filter a global package; they do not own a project install.
  const projectDeltas = new Set(
    (settings.getProjectSettings().packages ?? [])
      .filter((pkg) => typeof pkg === "object" && pkg.autoload === false)
      .map((pkg) => sourceId(typeof pkg === "string" ? pkg : pkg.source))
      .filter((name) => name !== undefined),
  );

  for (const pkg of packages.listConfiguredPackages()) {
    const name = sourceId(pkg.source);
    if (!name) continue;
    if (pkg.scope === "project" && projectDeltas.has(name)) continue;

    try {
      valid.push(await readPackageInfo(pi, pkg));
    } catch (error) {
      errors.push({
        name,
        scope: pkg.scope,
        current: "?",
        error: errorMessage(error),
      });
    }
  }

  return { valid, errors };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function flushSettings(settings: SettingsManager): Promise<void> {
  // Writes are queued, and storage failures are exposed only after the queue is flushed.
  await settings.flush();
  const errors = settings.drainErrors();
  if (errors.length > 0) throw errors[0]!.error;
}

export async function latestVersion(
  pi: ExtensionAPI,
  settings: SettingsManager,
  name: string,
): Promise<string> {
  const [command = "npm", ...prefix] = settings.getNpmCommand() ?? [];
  if (!command) throw new Error("npmCommand is empty");

  const result = await pi.exec(
    command,
    [...prefix, "view", `${name}@latest`, "version", "--json"],
    {
      timeout: 15_000,
    },
  );
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `${command} exited with ${result.code}`);

  const version = JSON.parse(result.stdout.trim()) as unknown;
  if (typeof version !== "string" || !isExactVersion(version)) {
    throw new Error(`npm returned an invalid version: ${result.stdout.trim()}`);
  }
  return version;
}

async function latestGitHead(pi: ExtensionAPI, installedPath: string): Promise<string> {
  const result = await pi.exec("git", ["-C", installedPath, "ls-remote", "origin", "HEAD"], {
    timeout: 30_000,
  });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git exited with ${result.code}`);

  const match = result.stdout.match(/^([0-9a-f]{40})\s+HEAD$/m);
  if (!match?.[1]) throw new Error(`git ls-remote returned no HEAD: ${result.stdout.trim()}`);
  return match[1];
}

export async function pinInstalledPackages(pi: ExtensionAPI, cwd: string, projectTrusted: boolean) {
  const { settings, packages, errors: settingsErrors } = createManagers(cwd, projectTrusted);
  const { valid, errors } = await getPackages(settings, packages, pi);
  errors.unshift(...settingsErrors);
  const pinned: string[] = [];

  for (const pkg of valid) {
    if (pkg.pinned) continue;

    if (packages.addSourceToSettings(pkg.pinnedSource, { local: pkg.scope === "project" })) {
      pinned.push(`${pkg.name}@${shortHash(pkg.current)}`);
    }
  }

  await flushSettings(settings);
  return { pinned, errors };
}

export async function mapInBatches<T, R>(items: T[], map: (item: T) => Promise<R>): Promise<R[]> {
  // Process in waves to cap registry traffic while preserving settings order in the report.
  const results: R[] = [];
  for (let index = 0; index < items.length; index += CHECK_CONCURRENCY) {
    results.push(...(await Promise.all(items.slice(index, index + CHECK_CONCURRENCY).map(map))));
  }
  return results;
}

async function lookupLatestVersions(
  pi: ExtensionAPI,
  settings: SettingsManager,
  packages: PackageInfo[],
) {
  return mapInBatches(packages, async (pkg) => {
    try {
      const latest =
        pkg.kind === "git" && pkg.installedPath
          ? await latestGitHead(pi, pkg.installedPath)
          : await latestVersion(pi, settings, pkg.name);
      return { pkg, latest };
    } catch (error) {
      return { pkg, error: errorMessage(error) };
    }
  });
}

export async function listPackages(pi: ExtensionAPI, cwd: string, projectTrusted: boolean) {
  const { settings, packages, errors: settingsErrors } = createManagers(cwd, projectTrusted);
  const { valid, errors } = await getPackages(settings, packages, pi);
  return [
    ...settingsErrors,
    ...errors,
    ...valid.map((pkg) => ({ name: pkg.name, scope: pkg.scope, current: pkg.current })),
  ];
}

export async function checkPackages(pi: ExtensionAPI, cwd: string, projectTrusted: boolean) {
  const { settings, packages, errors: settingsErrors } = createManagers(cwd, projectTrusted);
  const { valid, errors } = await getPackages(settings, packages, pi);
  const checks = await lookupLatestVersions(pi, settings, valid);

  return [
    ...settingsErrors,
    ...errors,
    ...checks.map((check) => ({
      name: check.pkg.name,
      scope: check.pkg.scope,
      current: check.pkg.current,
      ...(check.error ? { error: check.error } : { latest: check.latest }),
    })),
  ];
}

export async function updatePackages(pi: ExtensionAPI, cwd: string, projectTrusted: boolean) {
  const { settings, packages, errors: settingsErrors } = createManagers(cwd, projectTrusted);
  const { valid, errors } = await getPackages(settings, packages, pi);
  const checks = await lookupLatestVersions(pi, settings, valid);
  const rows = [...settingsErrors, ...errors];
  let needsReload = false;

  // ponytail: keep installs sequential because every package shares one install root.
  for (const check of checks) {
    const { pkg } = check;
    if (check.error) {
      rows.push({
        name: pkg.name,
        scope: pkg.scope,
        current: pkg.current,
        error: check.error,
      });
      continue;
    }

    try {
      const { latest } = check;
      if (pkg.current !== latest) {
        // pinnedSource already carries the right identity; swap its tail for the new version.
        const at = pkg.pinnedSource.lastIndexOf("@");
        const source = `${pkg.pinnedSource.slice(0, at)}@${latest}`;
        // An installer can mutate the shared install root before failing, so reload after any attempt.
        needsReload = true;
        await packages.install(source, { local: pkg.scope === "project" });
        const installed = await readPackageInfo(pi, {
          ...pkg,
          source,
          installedPath: packages.getInstalledPath(source, pkg.scope),
        });
        if (installed.current !== latest) {
          throw new Error(`Installed ${installed.current}, expected ${latest}`);
        }
        packages.addSourceToSettings(source, { local: pkg.scope === "project" });
      } else {
        packages.addSourceToSettings(pkg.pinnedSource, { local: pkg.scope === "project" });
      }
      await flushSettings(settings);
      rows.push({ name: pkg.name, scope: pkg.scope, current: pkg.current, latest });
    } catch (error) {
      rows.push({
        name: pkg.name,
        scope: pkg.scope,
        current: pkg.current,
        error: errorMessage(error),
      });
    }
  }

  return { rows, needsReload };
}

export default function versionPinExtension(pi: ExtensionAPI) {
  // Custom entries render in the transcript without adding operational output to LLM context.
  const showInChat = (text: string) => pi.appendEntry<ChatEntry>("packages-check", { text });

  pi.registerEntryRenderer<ChatEntry>("packages-check", (entry, _options, theme) =>
    entry.data ? new Text(theme.fg("text", entry.data.text), 1, 0) : undefined,
  );

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;

    // Startup pinning reads installed manifests and HEADs only; network checks stay behind /packages check.
    try {
      const { pinned, errors } = await pinInstalledPackages(pi, ctx.cwd, ctx.isProjectTrusted());
      if (pinned.length > 0) ctx.ui.notify(`Pinned pi packages: ${pinned.join(", ")}`, "info");
      if (errors.length > 0) ctx.ui.notify(formatReport(errors), "warning");
    } catch (error) {
      ctx.ui.notify(`Package pinning failed: ${errorMessage(error)}`, "error");
    }
  });

  pi.registerCommand("packages", {
    description: "List, check, or update configured npm and git packages",
    getArgumentCompletions: (prefix) => {
      const actions = ["check", "update"];
      const matches = actions.filter((action) => action.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action && action !== "check" && action !== "update") {
        ctx.ui.notify("Usage: /packages [check|update]", "error");
        return;
      }

      if (action) showInChat(action === "update" ? "Updating packages…" : "Checking packages…");
      try {
        if (action === "update") {
          const result = await updatePackages(pi, ctx.cwd, ctx.isProjectTrusted());
          showInChat(result.rows.length > 0 ? formatReport(result.rows) : "No configured packages");
          if (result.needsReload) await ctx.reload();
        } else {
          const rows = action
            ? await checkPackages(pi, ctx.cwd, ctx.isProjectTrusted())
            : await listPackages(pi, ctx.cwd, ctx.isProjectTrusted());
          showInChat(rows.length > 0 ? formatReport(rows) : "No configured packages");
        }
      } catch (error) {
        showInChat(`Package operation failed: ${errorMessage(error)}`);
      }
    },
  });
}
