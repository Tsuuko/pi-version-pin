# @tsuuko/pi-version-pin

[English](https://github.com/Tsuuko/pi-version-pin#readme) | **日本語**

npm経由で導入した[pi](https://github.com/earendil-works/pi)パッケージを正確なバージョンに固定し、更新を明示的に行えるようにする拡張です。

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

インストール済みバージョンとnpmの`latest`タグを比較します。

```text
pi-chrome      0.15.38  → 0.15.41
pi-web-access  1.8.2    ✓ latest
pi-tps-status  0.4.1    → 0.4.3
```

### すべて更新する

```text
/packages update
```

設定済みのnpmパッケージをすべて`latest`へ更新し、インストールされた正確なバージョンで再固定してからpiをリロードします。途中で1件失敗しても残りの更新は続行され、最後に失敗内容が表示されます。

## 動作

- 起動時に未指定、範囲指定、タグ指定のバージョンをインストール済みの正確なバージョンへ固定します。
- グローバル設定と、信頼済みプロジェクトの設定を処理します。
- `settings.json`に設定されたパッケージリソースのフィルターを維持します。
- pnpm、mise、asdfなど、piの`npmCommand`設定を尊重します。
- npmへのバージョン問い合わせは最大5並列で行います。
- Gitパッケージとローカルパスのパッケージは対象外です。
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
