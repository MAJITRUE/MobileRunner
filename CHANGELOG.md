# Changelog

## 0.5.1 (2026-03-20)

- README i18n (English / Japanese sections with navigation links)
- Added iOS requirements to README
- Updated screenshots

## 0.5.0 (2026-03-20)

- **Device File Explorer** — Browse, download, upload, and delete files on Android devices from the sidebar
  - Storage / App Data / System category layout
  - `run-as` support for debuggable app private data (pull / push / delete / mkdir)
  - Drag & drop upload from VSCode explorer
  - Click to open files in editor
  - Auto-push back to device on save (works with any editor including custom editors)
  - Cache management — auto-cleanup of files older than configurable days (default 7)
  - File size warning — confirmation dialog for files exceeding configurable limit (default 10MB)
  - Device selection independent from build selector
  - Rename / new file / new folder
- **Feature toggles** — Show/hide individual features in settings (`showDeviceExplorer`, `showDeviceSelector`, `showBuildControls`, `showVariantSelector`)
  - All features OFF stops device polling

## 0.4.3 (2026-03-19)

- Project root detection: walk up from active file (Dart-Code style) for reliable detection in nested projects
- iOS simctl data caching (2s TTL) — device picker opens faster, reduced duplicate commands
- devicectl timeout reduced from 15s to 5s

## 0.4.2 (2026-03-18)

- Fix misleading description that implied Xcode/Android Studio are not required

## 0.4.1 (2026-03-18)

- Auto-fix gradlew permissions (`chmod +x`) before Gradle builds
- Auto-write `sdk.dir` to `local.properties` when Android SDK is detected
- Pass `ANDROID_SDK_ROOT` environment variable to Gradle processes

## 0.4.0 (2026-03-18)

- **iOS support** (macOS only) — Build, install, and run Xcode projects on iOS simulators and physical devices
- iOS simulator detection via `xcrun simctl`, physical device detection via `xcrun devicectl`
- Xcode scheme scanning and selection (variant picker adapts to selected platform)
- Console log streaming from iOS simulators and devices
- Unified device picker — Android and iOS devices shown together with platform labels
- Common `PlatformProvider` interface — architecture refactored for multi-platform extensibility
- New settings: `native-runner.iosScheme`, `native-runner.iosConfiguration`
- Activation on `.xcodeproj` / `.xcworkspace` presence
- Renamed display name to "Android / iOS Build & Run"
- Bundle ID detection: 3-tier fallback (Info.plist → xcodebuild -showBuildSettings → project.pbxproj)
- Smart build output: auto-show after 30s or on error, silent on success
- Fixed: device auto-switching during build (keep selection unless device disappears)
- Fixed: simulator/physical device detection for log streaming

## 0.3.3 (2026-03-18)

- Device picker UI improvements — Flutter-style layout with Current Device / Available Devices / Offline Emulators sections
- F5 guard via `resolveDebugConfiguration` to silently skip when build in progress or device already running

## 0.3.2 (2026-03-18)

- Per-device DAP debug sessions — floating toolbar shows device selector dropdown
- Toolbar stop/restart targets only the corresponding device
- Fixed: Stop on one device no longer affects other running devices
- Fixed: Floating toolbar correctly removed when device is stopped
- Fixed: F5 now works when other devices are running (targets selected device)
- Debug adapter map (`debugAdapters`) replaces singleton for correct session isolation

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
