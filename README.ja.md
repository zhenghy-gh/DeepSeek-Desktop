# DeepSeek Desktop

[中文](README.md) · [English](README.en.md) · [日本語](README.ja.md)

DeepSeek チャットと Harness を一体化したデスクトップアプリ。インストール後は**ブラウザもターミナルも不要**です：
起動時に Harness サービスを自動で立ち上げ、2 つのタブからワンクリックでアクセスできます。

| タブ | 内容 | アドレス |
| --- | --- | --- |
| 💬 DeepSeek チャット | DeepSeek 公式ウェブチャット | https://chat.deepseek.com |
| 🛠 Harness | DeepSeek Harness ワークスペース（ローカルサービス） | http://127.0.0.1:3080 |

## 機能

- **Harness 自動起動**：起動時にローカルで Harness が稼働中かどうかをプローブ（`__DSH_BOOT__` マーカーで判定）。なければ `dsh web` で自動起動します（dsh ランタイム同梱のため npm キャッシュに依存しません）。既に起動していればそのまま再利用し、アプリ終了時に外部起動した Harness を誤って停止することはありません
- **2 タブ切替**：`Cmd+1` チャット / `Cmd+2` Harness、`Cmd+R` で現在のページを再読み込み
- **セッション永続化**：タブごとに独立したパーティション（`persist:deepseek` / `persist:harness`）を使用するため、ログイン状態と Harness セッションは再起動後も保持されます
- **自己修復**：Harness が未起動・異常終了した場合、エラーパネルを表示し、ワンクリックで再起動・ログ確認が可能
- **シングルインスタンス**：アプリを再度起動すると既存ウィンドウにフォーカスするだけ
- **外部リンク**：ページ内の `target=_blank` リンクはシステムブラウザで開きます

## インストール

1. [Releases](https://github.com/zhenghy-gh/DeepSeek-Desktop/releases) からお使いのプラットフォームのインストーラをダウンロード（macOS は `-arm64.dmg`、Windows は `.exe`、Linux は `.AppImage` または `.deb`）
2. macOS：dmg を開き **DeepSeek Desktop** を Applications にドラッグ。Windows：インストーラを実行。Linux：`chmod +x` 後に AppImage を実行、または `sudo dpkg -i` で deb をインストール
3. 初回起動時：未署名アプリは Gatekeeper / SmartScreen にブロックされるため、macOS ではアプリアイコンを右クリック →「開く」を選択してください（ローカルビルドは影響ありません）

> インストーラには dsh ランタイムが同梱されています（展開後およそ 300 MB）。初回の Harness 起動には数秒かかります。ツールバーのステータスドットが進行状況を示します。

## 開発

```bash
npm install          # electron / electron-builder をインストール
npm run icon         # アプリアイコンを生成（macOS の sips/iconutil が必要）
npm run prepare:runtime  # ローカルの dsh ランタイムを dsh-runtime/ にコピー
npm start            # 開発モードで実行
npm run dist:mac     # macOS の dmg + zip をビルド（dist/ に出力）
npm run dist:win     # Windows の NSIS インストーラをビルド（Windows または CI 推奨）
npm run dist:linux   # Linux の AppImage + deb をビルド
```

> Electron バイナリのダウンロードが遅いネットワーク環境では、ビルド前にミラーを設定：
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`

## マルチプラットフォーム・インストーラ（GitHub Actions）

`v*` タグをプッシュすると [.github/workflows/build.yml](.github/workflows/build.yml) が自動実行され、
macOS / Windows / Ubuntu の各ネイティブランナーで dmg、zip、NSIS exe、AppImage、deb をビルドし、
対応する Release ページに公開します。Actions タブから手動実行（workflow_dispatch）も可能です。

## 仕組み

- `main.js`：Electron メインプロセス。node と dsh を検出（優先順位：アプリ同梱の `resources/dsh-runtime` → PATH → `~/.npm/_npx/*`）、Harness をプローブ/起動し、準備完了後にレンダラーへ読み込む URL を通知。終了時は自分が起動したプロセスのみを停止します
- `renderer/`：ローカル UI。2 つの `<webview>` でチャットと Harness のページを表示
- `scripts/prepare-runtime.mjs`：dsh ランタイムを `dsh-runtime/` に準備（ローカルに dsh がない場合は npm から自動インストール。ソースマップ・ドキュメント・他プラットフォーム用プリビルドを削除）、`afterPack` フックでアプリに同梱
- ポート戦略：3080 の再利用を優先。占有中や起動失敗時は 3081–3083 を順に試行

## 既知の制限

- コード署名なし：他のマシンでは初回起動時に右クリック →「開く」が必要
- Windows の NSIS インストーラは Windows または CI でのビルドが必要（macOS でのクロスビルドには wine が必要）
- アプリ内 UI の表示言語は現在中国語のみ

## ライセンス

MIT
