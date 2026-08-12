# @tsuuko/pi-version-pin

**English** | [日本語](./README.ja.md)

A [pi](https://github.com/earendil-works/pi) extension that keeps installed npm-based pi packages pinned to exact versions and makes updates explicit.

## Why?

When a pi package has no exact version, pi checks npm on every startup to resolve it. This adds an unnecessary network request and can slow down or disrupt startup when the registry is unavailable.

For example, this unpinned entry:

```json
"npm:pi-chrome"
```

is replaced on startup with the version that is already installed:

```json
"npm:pi-chrome@0.15.38"
```

No network request is made during startup pinning.

## Installation

```sh
pi install npm:@tsuuko/pi-version-pin
```

Restart pi after installation. No configuration is required.

## Commands

### Check for updates

```text
/packages-check
```

Compares installed versions with npm's `latest` tag:

```text
pi-chrome         0.15.38  → 0.15.41
pi-web-access      1.8.2   ✓ latest
pi-tps-status      0.4.1   → 0.4.3
```

### Update all packages

```text
/packages-check update
```

Updates every configured npm-based pi package to `latest`, pins each installed version, and reloads pi. If one package fails, the remaining packages are still processed and the failures are shown in the result.

## Behavior

- Pins unpinned versions, ranges, and tags to the exact installed version on startup.
- Handles packages from global settings and trusted project settings.
- Preserves package resource filters in `settings.json`.
- Uses pi's configured `npmCommand`, including wrappers such as pnpm, mise, or asdf.
- Checks npm versions with at most five concurrent requests.
- Ignores Git and local-path packages.
- Never updates packages automatically on startup.

## Uninstall

```sh
pi remove npm:@tsuuko/pi-version-pin
```

Removing the extension does not unpin package versions already written to your pi settings.

## Requirements

- pi 0.84.1 or later
- Node.js 22.19 or later

## License

[MIT](./LICENSE)
