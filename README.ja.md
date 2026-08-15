# @tsuuko/pi-version-pin

[English](https://github.com/Tsuuko/pi-version-pin#readme) | **日本語**

npm経由で導入した[pi](https://github.com/earendil-works/pi)パッケージを正確なバージョンに、Git経由のパッケージをコミットハッシュに固定し、更新を明示的に行えるようにする拡張です。

## なぜ使うのか

piパッケージのバージョンが正確に固定されていない場合、piは起動するたびにnpmへ問い合わせてバージョンを解決します。不要なネットワーク通信が発生し、レジストリが利用できないと起動が遅延・失敗する可能性があります。

例えば、次の固定されていない設定を、

```json
"npm:pi-chrome"
```

この拡張がpiの起動時に、現在インストールされているバージョンへ書き換えます。

```json
"npm:pi-chrome@0.15.38"
```

Gitパッケージも同様に固定します。次の未固定・タグ固定の設定を、

```json
"git:github.com/user/repo"
"git:github.com/user/repo@v1.2.0"
```

チェックアウト済みのコミットハッシュへ書き換えます。

```json
"git:github.com/user/repo@9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
```

起動時の固定処理ではネットワーク通信を行いません。

## インストール

```sh
pi install npm:@tsuuko/pi-version-pin
```

インストール後にpiを再起動してください。追加設定は不要です。

## コマンド

### 現在のバージョンを表示する

```text
/packages
```

npmへアクセスせず、現在インストールされているバージョンを表示します。

```text
pi-chrome      0.15.38
pi-web-access  1.8.2
pi-tps-status  0.4.1
```

### 更新を確認する

```text
/packages check
```

インストール済みバージョンとnpmの`latest`タグを、GitパッケージはHEADとリモートのデフォルトブランチのHEADを比較します。

```text
pi-chrome          0.15.38  → 0.15.41
pi-web-access      1.8.2    ✓ latest
github.com/u/repo  9f86d08  → 03150ab
```

### すべて更新する

```text
/packages update
```

設定済みのパッケージをすべて更新します。npmパッケージは`latest`へ、GitパッケージはリモートのデフォルトブランチのHEADへ更新し、インストールされた正確なバージョンまたはコミットハッシュで再固定してからpiをリロードします。途中で1件失敗しても残りの更新は続行され、最後に失敗内容が表示されます。

## 動作

- 起動時に未指定、範囲指定、タグ指定のバージョンをインストール済みの正確なバージョンへ固定します。
- 起動時に未指定・タグ指定のGitパッケージをチェックアウト済みのコミットハッシュへ固定します。
- グローバル設定と、信頼済みプロジェクトの設定を処理します。
- `settings.json`に設定されたパッケージリソースのフィルターを維持します。
- pnpm、mise、asdfなど、piの`npmCommand`設定を尊重します。
- npmへのバージョン問い合わせは最大5並列で行います。
- ローカルパスのパッケージは対象外です。
- 起動時にパッケージを自動更新することはありません。

## アンインストール

```sh
pi remove npm:@tsuuko/pi-version-pin
```

拡張を削除しても、すでにpiの設定へ書き込まれたバージョン固定は解除されません。

## 必要環境

- pi 0.84.1以上
- Node.js 22.19以上

## ライセンス

[MIT](./LICENSE)
