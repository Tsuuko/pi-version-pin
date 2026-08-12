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

type ConfiguredPackage = {
  source: string;
  scope: Scope;
  installedPath?: string;
};

type PackageInfo = ConfiguredPackage & {
  name: string;
  current: string;
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
  const versionWidth = Math.max(...rows.map((row) => row.current.length));

  return rows
    .map((row) => {
      const prefix = `${displayName(row).padEnd(nameWidth)}  ${row.current.padEnd(versionWidth)}`;
      if (row.error) return `${prefix}  ! ${row.error.replace(/\s+/g, " ").trim()}`;
      return row.latest === row.current ? `${prefix}  ✓ latest` : `${prefix}  → ${row.latest}`;
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

async function readPackageInfo(pkg: ConfiguredPackage): Promise<PackageInfo> {
  const source = parseNpmSource(pkg.source);
  if (!source) throw new Error(`Unsupported package source: ${pkg.source}`);
  if (!pkg.installedPath) throw new Error("Package is not installed");

  const manifest = JSON.parse(await readFile(join(pkg.installedPath, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (manifest.name !== source.name) {
    throw new Error(`Installed package name is ${String(manifest.name)}`);
  }
  if (typeof manifest.version !== "string" || !isExactVersion(manifest.version)) {
    throw new Error(`Invalid installed version: ${String(manifest.version)}`);
  }

  return { ...pkg, name: source.name, current: manifest.version };
}

async function getNpmPackages(
  settings: SettingsManager,
  packages: DefaultPackageManager,
): Promise<{ valid: PackageInfo[]; errors: ReportRow[] }> {
  const valid: PackageInfo[] = [];
  const errors: ReportRow[] = [];
  // autoload:false project entries only filter a global package; they do not own a project install.
  const projectDeltas = new Set(
    (settings.getProjectSettings().packages ?? [])
      .filter((pkg) => typeof pkg === "object" && pkg.autoload === false)
      .map((pkg) => parseNpmSource(typeof pkg === "string" ? pkg : pkg.source)?.name)
      .filter((name) => name !== undefined),
  );

  for (const pkg of packages.listConfiguredPackages()) {
    const source = parseNpmSource(pkg.source);
    if (!source) continue;
    if (pkg.scope === "project" && projectDeltas.has(source.name)) continue;

    try {
      valid.push(await readPackageInfo(pkg));
    } catch (error) {
      errors.push({
        name: source.name,
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

export async function pinInstalledPackages(cwd: string, projectTrusted: boolean) {
  const { settings, packages, errors: settingsErrors } = createManagers(cwd, projectTrusted);
  const { valid, errors } = await getNpmPackages(settings, packages);
  errors.unshift(...settingsErrors);
  const pinned: string[] = [];

  for (const pkg of valid) {
    const parsed = parseNpmSource(pkg.source)!;
    if (isExactVersion(parsed.version)) continue;

    const source = `npm:${pkg.name}@${pkg.current}`;
    if (packages.addSourceToSettings(source, { local: pkg.scope === "project" })) {
      pinned.push(`${pkg.name}@${pkg.current}`);
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
      return { pkg, latest: await latestVersion(pi, settings, pkg.name) };
    } catch (error) {
      return { pkg, error: errorMessage(error) };
    }
  });
}

export async function checkPackages(pi: ExtensionAPI, cwd: string, projectTrusted: boolean) {
  const { settings, packages, errors: settingsErrors } = createManagers(cwd, projectTrusted);
  const { valid, errors } = await getNpmPackages(settings, packages);
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
  const { valid, errors } = await getNpmPackages(settings, packages);
  const checks = await lookupLatestVersions(pi, settings, valid);
  const rows = [...settingsErrors, ...errors];
  let needsReload = false;

  // ponytail: keep installs sequential because every package shares one npm install root.
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
        const source = `npm:${pkg.name}@${latest}`;
        // An installer can mutate the shared npm root before failing, so reload after any attempt.
        needsReload = true;
        await packages.install(source, { local: pkg.scope === "project" });
        const installed = await readPackageInfo({
          ...pkg,
          source,
          installedPath: packages.getInstalledPath(source, pkg.scope),
        });
        if (installed.current !== latest) {
          throw new Error(`Installed ${installed.current}, expected ${latest}`);
        }
      }

      packages.addSourceToSettings(`npm:${pkg.name}@${latest}`, {
        local: pkg.scope === "project",
      });
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

    // Startup pinning reads installed manifests only; network checks stay behind /packages-check.
    try {
      const { pinned, errors } = await pinInstalledPackages(ctx.cwd, ctx.isProjectTrusted());
      if (pinned.length > 0) ctx.ui.notify(`Pinned pi packages: ${pinned.join(", ")}`, "info");
      if (errors.length > 0) ctx.ui.notify(formatReport(errors), "warning");
    } catch (error) {
      ctx.ui.notify(`Package pinning failed: ${errorMessage(error)}`, "error");
    }
  });

  pi.registerCommand("packages-check", {
    description: "Check or update configured npm packages",
    getArgumentCompletions: (prefix) =>
      "update".startsWith(prefix) ? [{ value: "update", label: "update" }] : null,
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action && action !== "update") {
        ctx.ui.notify("Usage: /packages-check [update]", "error");
        return;
      }

      showInChat(action === "update" ? "Updating packages…" : "Checking packages…");
      let reload = false;
      try {
        if (!action) {
          const rows = await checkPackages(pi, ctx.cwd, ctx.isProjectTrusted());
          showInChat(rows.length > 0 ? formatReport(rows) : "No configured npm packages");
        } else {
          const result = await updatePackages(pi, ctx.cwd, ctx.isProjectTrusted());
          showInChat(
            result.rows.length > 0 ? formatReport(result.rows) : "No configured npm packages",
          );
          reload = result.needsReload;
        }
      } catch (error) {
        showInChat(`Package operation failed: ${errorMessage(error)}`);
      }

      if (reload) {
        await ctx.reload();
        return;
      }
    },
  });
}
