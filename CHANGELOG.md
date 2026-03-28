# Changelog

## 0.5.8 (2026-03-29)

- **README redesigned** — cleaner layout with bold title + description format, variant picker screenshot added
- **Images moved to GitHub raw URL** — package size reduced from 272KB to 73KB
- **Flutter-inspired** tagline added to README
- **Scan status** — shows "Gradle sync..." / "Xcode sync..." instead of generic "Scanning..."
- **Scan failure** — shows error icon + "Scan failed" in status bar; manual rescan shows alert with error details
- **Pre-scan display** — shows "—" instead of stale "debug" before scan completes
- **Product flavor support** — package name and launcher activity read from APK via aapt2 (handles applicationIdSuffix correctly)
- Fixed: floating toolbar not appearing (resolveDebugConfiguration guard was blocking internal session creation)
- Fixed: floating toolbar disappearing after restart (DAPセッション was not re-created)
- Fixed: variant selection not restored for non-first projects

## 0.5.7 (2026-03-29)

- README redesigned: cleaner layout with Build & Run / Device File Explorer sections
- Updated status bar screenshot
- Fixed: variant selection not restored for non-first projects
- Fixed: macOS keyboard shortcuts added to README

## 0.5.6 (2026-03-29)

- README updates: status bar order, variant picker description, `projectSearchDepth` setting

## 0.5.5 (2026-03-29)

- **Multi-project variant picker** — All projects in workspace shown with project name sections; select variant from any project
- **Project search depth setting** — `projectSearchDepth` (default 2) for finding projects in nested directories
- **Variant selection memory** — Remembers last selected variant per project across sessions (workspaceState)
- **Status bar reordered** — Device → Variant → Run (left to right, matching workflow order)
- **Variant scan improvements** — Scan delayed until device detection completes; Run waits for scan to finish
- **iOS scheme filtering** — Query `.xcodeproj` instead of `.xcworkspace` to exclude Pods/Flutter dependency schemes
- **iOS simulator auto-boot** — Automatically boots shutdown simulator before build
- **Platform-filtered device list** — Only show devices for platforms with projects in workspace
- **APK recursive search** — Find APKs in any directory depth (supports multi-dimension flavors)
- **Skip dirs in upward search** — Pods/, node_modules/ etc. excluded from active-file project detection
- Fixed: Disconnected iOS devices (devicectl `tunnelState: unavailable`) no longer shown as available
- Fixed: devicectl JSON output via temp file (fixes `/dev/stdout` parse error on some macOS versions)
- Fixed: Scanning indicator shows "Scanning..." instead of stale variant name
- Fixed: TreeView keybindings work via `onDidChangeSelection` context (Secondary Explorer pattern)

## 0.5.4 (2026-03-28)

- **Device Explorer: Cache Clear** — Toolbar button to clear local cache with size display; skips files open in editor
- **Device Explorer: Reveal in File Explorer** — Right-click to open cached file in OS file manager; auto-downloads if not cached
- **Device Explorer: Multi-select** — Shift/Ctrl+Click for batch delete, download, move, copy, copy path
- **Device Explorer: Keyboard shortcuts** — F2/Enter(mac) rename, Delete/Cmd+Backspace delete, Shift+Alt+R reveal, Shift+Alt+C copy path
- **Smart folder caching** — Folders re-fetch only when collapsed and re-expanded (not on every expand)
- **Move To / Copy To improvements** — Initial value includes filename, auto-creates non-existent destination folders
- **Device disconnect handling** — Tree clears, toolbar hides, watchers stop automatically
- **No-device state** — Run/Stop/Variant hidden when no device connected
- **Context menu reordered** — VSCode-standard layout (Reveal → Transfer → Move/Copy → Copy Path → New → Rename → Delete)
- **ADB path quoting** — All shell commands use POSIX single-quote escaping for spaces, Japanese, special characters
- **Refactored local path resolution** — Centralized `resolveLocalPath`/`getOrCreateLocalPath` to prevent hash mismatch bugs after rename
- Fixed: Rename updates editor tab name
- Fixed: Delete/move closes associated editor tabs (including folder contents)
- Fixed: Binary files (images) open correctly
- Fixed: Drag & drop folder move shows confirmation dialog
- Fixed: run-as file operations (App Data) with correct shell quoting

## 0.5.3 (2026-03-28)

- **Device Explorer: Move & Copy** — Right-click "Move To..." / "Copy To..." for files and folders on device
- **Device Explorer: Drag & Drop move** — Drag files/folders within the tree to move them on the device
- **explorerRefreshOnExpand setting** — Re-fetch folder contents on each expand (default: true). Set to false for cached mode with manual refresh.
- **Flutter project exclusion** — Skip Gradle/Xcode projects that are part of a Flutter project when Dart-Code extension is installed
- Fixed: `runAs` variable initialization order in drag & drop move (was causing "Cannot access before initialization" error)

## 0.5.2 (2026-03-21)

- Fixed: Extension not activating on iOS projects (`.xcodeproj`/`.xcworkspace` are directories, not files — changed activation patterns to match files inside them)

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
