# Android / iOS Build & Run

<a href="#ja">日本語</a>

Build, install, and run Android & iOS apps directly from VSCode. Includes Device File Explorer.
Inspired by Flutter's developer experience — status bar device selector, one-click run, and floating toolbar.

## Build & Run

Pick a device, select a variant, click Run.

![Status Bar](https://raw.githubusercontent.com/MAJITRUE/MobileRunner/main/images/statusbar.png)

The status bar shows your current device, build variant, and run button. Click any item to change it.

![Device Picker](https://raw.githubusercontent.com/MAJITRUE/MobileRunner/main/images/device-picker.png)

The variant picker shows all projects in the workspace with their variants/schemes.

![Variant Picker](https://raw.githubusercontent.com/MAJITRUE/MobileRunner/main/images/variant.png)

**Multiple Devices**
Run on multiple devices simultaneously. Each gets its own log output.

**Floating Toolbar**
Stop and restart your app from the debug toolbar, just like Flutter.

**F5 Support**
Press F5 to build and run via `launch.json`.

**Cold Boot & Auto-Boot**
Restart an emulator from scratch (cold boot). iOS simulators auto-start if shutdown.

**Auto-Detection**
SDK, JDK, and project root are detected automatically.

## Device File Explorer

Browse, edit, and manage files on connected Android devices from the sidebar.

![Device Explorer](https://raw.githubusercontent.com/MAJITRUE/MobileRunner/main/images/device-explorer.png)

**Open & Auto-Sync**
Click a file to open. Save to sync changes back to device automatically. Files open with the appropriate VSCode editor (text, image preview, SQLite3 Editor, etc.).

**Drag & Drop**
Move files within the device tree, or upload from local by dropping onto a folder.

**Multi-Select**
Shift/Ctrl+Click for batch delete, download, move, copy, and copy path.

**App-Private Data**
Access databases, shared_prefs, and other private data on debuggable apps.

**Keyboard Shortcuts**
| Action | Windows | macOS |
|--------|---------|-------|
| Rename | F2 | Enter |
| Delete | Delete | Cmd+Backspace |
| Reveal in Explorer | Shift+Alt+R | Cmd+Alt+R |
| Copy Path | Shift+Alt+C | Cmd+Alt+C |

## Requirements

**Android** — Android SDK (`adb`, `emulator`), Gradle wrapper, `build.gradle` or `build.gradle.kts`

**iOS (macOS only)** — Xcode with Command Line Tools, `.xcodeproj` or `.xcworkspace`

## Quick Start

1. Open a project folder in VSCode
2. Click the device name in the status bar to select a device
3. Click **▶ Run** to build and run

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `projectSearchDepth` | `2` | Max depth to search for projects in subdirectories |
| `sdkPath` | `""` | Android SDK path (auto-detected) |
| `javaHome` | `""` | JDK path (auto-detected) |
| `buildVariant` | `"debug"` | Default build variant |
| `autoSelectDevice` | `true` | Auto-select device on connect |

All settings are prefixed with `native-runner.`. Additional settings for feature toggles (`showDeviceExplorer`, `showDeviceSelector`, `showBuildControls`, `showVariantSelector`) and file explorer (`explorerFileSizeLimit`, `explorerCacheDays`) are available in VSCode settings.

## F5 / launch.json

```json
{
  "type": "native-runner",
  "request": "launch",
  "name": "Build & Run"
}
```

## License

MIT

[⬆️ Top](#android--ios-build--run) | [日本語](#ja)

---

<h2 id="ja">日本語</h2>

VSCode から Android / iOS ネイティブアプリをビルド・実行できる拡張機能。Device File Explorer 搭載。
Flutter の開発者エクスペリエンス — ステータスバーでのデバイス選択、ワンクリック実行、フローティングツールバーからインスピレーションを受けています。

## ビルド & 実行

デバイスを選んで、バリアントを選んで、実行。

![ステータスバー](https://raw.githubusercontent.com/MAJITRUE/MobileRunner/main/images/statusbar.png)

ステータスバーにデバイス・ビルドバリアント・実行ボタンを表示。クリックで切り替え。

![デバイスピッカー](https://raw.githubusercontent.com/MAJITRUE/MobileRunner/main/images/device-picker.png)

バリアントピッカーはワークスペース内の全プロジェクトをプロジェクト名付きで表示。

![バリアントピッカー](https://raw.githubusercontent.com/MAJITRUE/MobileRunner/main/images/variant.png)

**複数デバイス同時実行**
複数デバイスで同時にアプリを実行。デバイスごとに独立したログ出力。

**フローティングツールバー**
Flutterと同様のデバッグツールバーで停止・再起動。

**F5対応**
`launch.json` でF5キーからビルド＆実行。

**コールドブート & 自動起動**
エミュレーターを初期状態から再起動（コールドブート）。iOSシミュレーターは終了時に自動起動。

**自動検出**
SDK・JDK・プロジェクトルートを自動検出。

## Device File Explorer

サイドバーからAndroidデバイスのファイルを操作。

![デバイスエクスプローラー](https://raw.githubusercontent.com/MAJITRUE/MobileRunner/main/images/device-explorer.png)

**ファイルを開いて自動反映**
ファイルをクリックして開く。保存するとデバイスに自動反映。テキスト、画像プレビュー、SQLite3 Editor等、VSCodeのエディタに対応。

**ドラッグ&ドロップ**
デバイス内でファイルを移動。ローカルからフォルダにドロップしてアップロード。

**複数選択**
Shift/Ctrl+クリックで一括削除・ダウンロード・移動・コピー・パスコピー。

**アプリのプライベートデータ**
デバッグ可能なアプリのdatabases、shared_prefs等にアクセス。

**ショートカット**
| 操作 | Windows | macOS |
|------|---------|-------|
| リネーム | F2 | Enter |
| 削除 | Delete | Cmd+Backspace |
| エクスプローラーで表示 | Shift+Alt+R | Cmd+Alt+R |
| パスコピー | Shift+Alt+C | Cmd+Alt+C |

## 必要条件

**Android** — Android SDK（`adb`、`emulator`）、Gradle wrapper、`build.gradle` または `build.gradle.kts`

**iOS（macOSのみ）** — Xcode（Command Line Tools含む）、`.xcodeproj` または `.xcworkspace`

## クイックスタート

1. VSCodeでプロジェクトフォルダーを開く
2. ステータスバーのデバイス名をクリックしてデバイスを選択
3. **▶ Run** をクリックしてビルド＆実行

## ライセンス

MIT

[⬆️ Top](#android--ios-build--run) | [English](#android--ios-build--run)
