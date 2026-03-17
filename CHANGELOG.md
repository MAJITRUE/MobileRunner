# Changelog

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
