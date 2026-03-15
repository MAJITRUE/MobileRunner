# Android Build & Run

Build, install, and run Android native projects directly from VSCode with a Flutter-like device selection experience.

## Features

- **Device Selector** — Status bar shows the current device. Click to pick from connected devices or launch an offline emulator.
- **One-Click Run** — Click `▶ Run` in the status bar to build, install, and launch your app.
- **Logcat in Debug Console** — App logs are streamed to the Debug Console, filtered by your app's PID.
- **Floating Toolbar** — Stop and restart your app from the debug toolbar, just like Flutter.
- **Auto-detect SDK** — Finds your Android SDK from `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or common install locations.

## Requirements

- **Android SDK** with `adb` and `emulator` available
- **Gradle wrapper** (`gradlew` / `gradlew.bat`) in your project root
- An Android project with `build.gradle` or `build.gradle.kts`

## Quick Start

1. Open an Android project folder in VSCode
2. The status bar shows your connected device (or "No Device")
3. Click the device name to select a device or launch an emulator
4. Click **▶ Run** to build and run

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `android-runner.sdkPath` | `""` | Path to Android SDK. Auto-detected if empty. |
| `android-runner.buildVariant` | `"debug"` | Build variant (`debug`, `release`, etc.) |
| `android-runner.autoSelectDevice` | `true` | Auto-select a device when one connects |

## Commands

| Command | Description |
|---------|-------------|
| `Android Runner: Select Device` | Open the device picker |
| `Android Runner: Run App` | Build, install, and run |
| `Android Runner: Stop App` | Stop the running app |
| `Android Runner: Filter Log` | Filter logcat output by text |

## How It Works

1. Detects your Android project (`build.gradle.kts`)
2. Runs `gradlew assembleDebug` (or your configured variant)
3. Installs the APK via `adb install`
4. Launches the app via `adb shell am start`
5. Streams `adb logcat` filtered by your app's PID

## License

MIT