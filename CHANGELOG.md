# Changelog

## 0.3.1 (2026-03-17)

- Fixed status bar order in README to match actual display

## 0.3.0 (2026-03-17)

- **Multi-device support** — Run the app on multiple devices simultaneously
- Per-device logcat Output Channels (`Logcat: Pixel 7`, `Logcat: emulator-5554`)
- Stop button targets the currently selected device only
- Status bar shows Run/Stop based on selected device's session state
- DAP Debug Console shows logs from the most recently launched device
- Build cancel no longer affects other running device sessions

## 0.2.0 (2026-03-17)

- Build variant auto-scan via `gradlew tasks`
- Status bar variant selector with QuickPick UI
- Emulator cold boot support (device picker bottom section)
- Background variant scan on startup with spinner indicator
- Renamed internal IDs from `mobile-runner` to `native-runner`

## 0.1.1 (2026-03-17)

- Renamed package to `native-runner` for Marketplace publishing

## 0.1.0 (2026-03-15)

- Initial release
- Device detection via ADB with automatic polling
- Status bar device selector with Flutter-like UX
- AVD emulator listing and one-click launch
- Gradle build integration (assembleDebug / assembleRelease)
- APK install and app launch
- Logcat output in Debug Console with PID filtering
- Floating debug toolbar (stop / restart)
- F5 support via launch.json
- Auto-detect Android SDK and JDK paths
- Configurable build variant, SDK path, JDK path, app module
- i18n support (English / Japanese)
