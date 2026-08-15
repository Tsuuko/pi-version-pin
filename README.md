# @tsuuko/pi-version-pin

**English** | [日本語](https://github.com/Tsuuko/pi-version-pin/blob/main/README.ja.md)

A [pi](https://github.com/earendil-works/pi) extension that keeps installed npm-based pi packages pinned to exact versions, and Git-based packages pinned to commit hashes, making updates explicit.

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

Git packages are pinned the same way. These unpinned or tag-pinned entries:

```json
"git:github.com/user/repo"
"git:github.com/user/repo@v1.2.0"
```

are replaced with the commit hash that is already checked out:

```json
"git:github.com/user/repo@9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
```

No network request is made during startup pinning.

## Installation

```sh
pi install npm:@tsuuko/pi-version-pin
```

Restart pi after installation. No configuration is required.

## Commands

### List installed versions

```text
/packages
```

Shows the currently installed versions without accessing npm:

```text
pi-chrome      0.15.38
pi-web-access  1.8.2
pi-tps-status  0.4.1
```

### Check for updates

```text
/packages check
```

Compares installed versions with npm's `latest` tag, and Git package HEADs with the remote default branch head:

```text
pi-chrome          0.15.38  → 0.15.41
pi-web-access      1.8.2    ✓ latest
github.com/u/repo  9f86d08  → 03150ab
```

### Update all packages

```text
/packages update
```

Updates every configured package: npm packages to `latest`, Git packages to the remote default branch head. Each install is pinned to its exact version or commit hash, then pi reloads. If one package fails, the remaining packages are still processed and the failures are shown in the result.

## Behavior

- Pins unpinned versions, ranges, and tags to the exact installed version on startup.
- Pins unpinned and tag-pinned Git packages to the checked-out commit hash on startup.
- Handles packages from global settings and trusted project settings.
- Preserves package resource filters in `settings.json`.
- Uses pi's configured `npmCommand`, including wrappers such as pnpm, mise, or asdf.
- Checks npm versions with at most five concurrent requests.
- Ignores local-path packages.
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
