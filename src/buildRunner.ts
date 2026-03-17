import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import { DeviceProvider } from "./deviceProvider";
import { DeviceManager } from "./deviceManager";
import { VariantManager } from "./variantManager";
import { getDebugAdapter } from "./extension";

interface DeviceSession {
  deviceId: string;
  deviceName: string;
  packageName: string;
  logcatProcess: cp.ChildProcess;
  outputChannel: vscode.OutputChannel;
}

export class BuildRunner implements vscode.Disposable {
  public readonly outputChannel: vscode.LogOutputChannel;
  private buildProcess: cp.ChildProcess | undefined;
  private sessions = new Map<string, DeviceSession>();
  private runStatusBarItem: vscode.StatusBarItem;
  private buildingStatusBarItem: vscode.StatusBarItem;
  private stopStatusBarItem: vscode.StatusBarItem;
  private isBuildInProgress = false;
  private lastLaunchedDeviceId: string | undefined;
  private logFilter: string | undefined;
  private debugSession: vscode.DebugSession | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private deviceProvider: DeviceProvider,
    private deviceManager: DeviceManager,
    private variantManager: VariantManager
  ) {
    this.outputChannel = vscode.window.createOutputChannel("Android Runner", { log: true });
    this.disposables.push(this.outputChannel);

    // Run button (visible when idle)
    this.runStatusBarItem = vscode.window.createStatusBarItem(
      "androidRunnerRun",
      vscode.StatusBarAlignment.Right,
      99
    );
    this.runStatusBarItem.name = "Android Run";
    this.runStatusBarItem.text = `$(play) ${vscode.l10n.t("Run")}`;
    this.runStatusBarItem.tooltip = vscode.l10n.t("Build and run Android app");
    this.runStatusBarItem.command = "native-runner.installAndRun";
    this.runStatusBarItem.show();
    this.disposables.push(this.runStatusBarItem);

    // Building indicator (visible only during build, not clickable)
    this.buildingStatusBarItem = vscode.window.createStatusBarItem(
      "androidRunnerBuilding",
      vscode.StatusBarAlignment.Right,
      99
    );
    this.buildingStatusBarItem.name = "Android Building";
    this.buildingStatusBarItem.text = `$(loading~spin) ${vscode.l10n.t("Building...")}`;
    this.disposables.push(this.buildingStatusBarItem);

    // Stop button (visible during build and while app is running)
    this.stopStatusBarItem = vscode.window.createStatusBarItem(
      "androidRunnerStop",
      vscode.StatusBarAlignment.Right,
      98
    );
    this.stopStatusBarItem.name = "Android Stop";
    this.stopStatusBarItem.text = `$(debug-stop) ${vscode.l10n.t("Stop")}`;
    this.stopStatusBarItem.tooltip = vscode.l10n.t("Stop running app");
    this.stopStatusBarItem.command = "native-runner.stop";
    this.disposables.push(this.stopStatusBarItem);

    // Update status bar when device selection changes
    this.disposables.push(
      this.deviceManager.onDeviceChanged(() => this.updateStatusBar())
    );
  }

  /**
   * Find the project root (directory containing build.gradle or build.gradle.kts)
   */
  private findProjectRoot(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return undefined;
    }

    for (const folder of workspaceFolders) {
      const root = folder.uri.fsPath;
      if (
        fs.existsSync(path.join(root, "build.gradle")) ||
        fs.existsSync(path.join(root, "build.gradle.kts"))
      ) {
        return root;
      }
      // Check subdirectories (e.g., android/ inside a multi-project)
      const androidDir = path.join(root, "android");
      if (
        fs.existsSync(path.join(androidDir, "build.gradle")) ||
        fs.existsSync(path.join(androidDir, "build.gradle.kts"))
      ) {
        return androidDir;
      }
    }

    return undefined;
  }

  /**
   * Find the APK after a successful build
   */
  private getAppModule(): string {
    const config = vscode.workspace.getConfiguration("native-runner");
    return config.get<string>("appModule", "app");
  }

  private findApk(projectRoot: string, variant: string): string | undefined {
    const appModule = this.getAppModule();
    const parentDir = path.dirname(projectRoot);
    const searchDirs = [
      path.join(projectRoot, appModule, "build", "outputs", "apk", variant),
      path.join(projectRoot, appModule, "build", "outputs", "flutter-apk"),
      // Flutter projects: APK may be in parent's build directory
      path.join(parentDir, "build", appModule, "outputs", "apk", variant),
      path.join(parentDir, "build", appModule, "outputs", "flutter-apk"),
    ];

    for (const apkDir of searchDirs) {
      if (!fs.existsSync(apkDir)) {
        continue;
      }
      const files = fs.readdirSync(apkDir).filter((f) => f.endsWith(".apk") && !f.endsWith("-androidTest.apk"));
      if (files.length > 0) {
        return path.join(apkDir, files[0]);
      }
    }

    return undefined;
  }

  /**
   * Extract package name from build.gradle(.kts) or AndroidManifest.xml,
   * and launcher activity from AndroidManifest.xml
   */
  private findPackageInfo(projectRoot: string): { packageName: string; launcherActivity?: string } | undefined {
    let packageName: string | undefined;

    // Try build.gradle.kts first (modern Android projects use namespace/applicationId)
    const appModule = this.getAppModule();
    for (const gradleFile of [`${appModule}/build.gradle.kts`, `${appModule}/build.gradle`]) {
      const gradlePath = path.join(projectRoot, gradleFile);
      if (fs.existsSync(gradlePath)) {
        const gradleContent = fs.readFileSync(gradlePath, "utf-8");
        // applicationId = "com.example.app" or applicationId "com.example.app"
        const appIdMatch = gradleContent.match(/applicationId\s*[=( ]\s*"([^"]+)"/);
        if (appIdMatch) {
          packageName = appIdMatch[1];
          break;
        }
        // namespace = "com.example.app"
        const nsMatch = gradleContent.match(/namespace\s*[=( ]\s*"([^"]+)"/);
        if (nsMatch) {
          packageName = nsMatch[1];
          break;
        }
      }
    }

    // Fallback: try package attribute in AndroidManifest.xml
    const manifestPath = path.join(
      projectRoot, appModule, "src", "main", "AndroidManifest.xml"
    );
    if (!packageName && fs.existsSync(manifestPath)) {
      const content = fs.readFileSync(manifestPath, "utf-8");
      const pkgMatch = content.match(/package\s*=\s*"([^"]+)"/);
      if (pkgMatch) {
        packageName = pkgMatch[1];
      }
    }

    if (!packageName) {
      return undefined;
    }

    // Extract launcher activity from AndroidManifest.xml
    let launcherActivity: string | undefined;
    if (fs.existsSync(manifestPath)) {
      const content = fs.readFileSync(manifestPath, "utf-8");
      const activityPattern = /<activity[^>]*android:name\s*=\s*"([^"]+)"[^>]*>[\s\S]*?<category\s+android:name\s*=\s*"android\.intent\.category\.LAUNCHER"/g;
      const actMatch = activityPattern.exec(content);
      if (actMatch) {
        launcherActivity = actMatch[1];
        if (launcherActivity.startsWith(".")) {
          launcherActivity = packageName + launcherActivity;
        }
      }
    }

    return { packageName, launcherActivity };
  }

  /**
   * Build, install, and run the app
   * @param skipDebugSession - skip starting a new debug session (used on restart)
   */
  public async installAndRun(skipDebugSession = false): Promise<void> {
    if (this.isBuildInProgress) {
      vscode.window.showWarningMessage(vscode.l10n.t("Build is already in progress."));
      return;
    }

    // Prevent double-launch from DAP launch handler
    const currentDev = this.deviceManager.getCurrentDevice();
    if (skipDebugSession && currentDev && this.sessions.has(currentDev.id)) {
      return;
    }

    const device = this.deviceManager.getCurrentDevice();
    if (!device || !device.isOnline) {
      const selected = await this.deviceManager.showDevicePicker();
      if (!selected) {
        return;
      }
    }

    const currentDevice = this.deviceManager.getCurrentDevice();
    if (!currentDevice || !currentDevice.isOnline) {
      vscode.window.showErrorMessage(vscode.l10n.t("No online device selected."));
      return;
    }

    const projectRoot = this.findProjectRoot();
    if (!projectRoot) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("No Android project found. Open a folder containing build.gradle or build.gradle.kts.")
      );
      return;
    }

    // If this device already has a running session, tear it down first
    await this.stopDevice(currentDevice.id);

    const variant = this.variantManager.getSelectedVariant();
    const capitalizedVariant = variant.charAt(0).toUpperCase() + variant.slice(1);

    this.outputChannel.clear();
    this.outputChannel.show(true);
    this.buildCancelled = false;
    this.isBuildInProgress = true;
    this.updateStatusBar();

    try {
      // Step 1: Build
      this.outputChannel.info(vscode.l10n.t("▶ Building {0}...", variant));
      this.outputChannel.info(vscode.l10n.t("  Project: {0}", projectRoot));
      this.outputChannel.info(vscode.l10n.t("  Device: {0} ({1})", currentDevice.name, currentDevice.id));

      await this.runGradle(projectRoot, `assemble${capitalizedVariant}`);

      // Step 2: Find APK
      const apkPath = this.findApk(projectRoot, variant);
      if (!apkPath) {
        throw new Error(vscode.l10n.t("APK not found for variant {0}", variant));
      }
      this.outputChannel.info(vscode.l10n.t("✓ APK: {0}", apkPath));

      // Step 3: Install
      this.outputChannel.info(vscode.l10n.t("▶ Installing on {0}...", currentDevice.name));
      await this.deviceProvider.installApk(currentDevice.id, apkPath);
      this.outputChannel.info(vscode.l10n.t("✓ Installed"));

      // Step 4: Launch
      const pkgInfo = this.findPackageInfo(projectRoot);
      if (!pkgInfo) {
        throw new Error(vscode.l10n.t("Could not determine package name from AndroidManifest.xml"));
      }

      this.outputChannel.info(vscode.l10n.t("▶ Launching {0}...", pkgInfo.packageName));
      await this.deviceProvider.launchActivity(
        currentDevice.id,
        pkgInfo.packageName,
        pkgInfo.launcherActivity
      );
      this.outputChannel.info(vscode.l10n.t("✓ Launched"));

      // Step 5: Start logcat in per-device Output Channel
      const deviceOutputChannel = vscode.window.createOutputChannel(
        `Logcat: ${currentDevice.name}`
      );
      deviceOutputChannel.show(true);

      // Wait for app process to start, retry up to 3 times
      let pid: string | undefined;
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        pid = await this.deviceProvider.getAppPid(currentDevice.id, pkgInfo.packageName);
        if (pid) { break; }
      }
      if (pid) {
        deviceOutputChannel.appendLine(vscode.l10n.t("(filtered by PID {0})", pid));
      } else {
        deviceOutputChannel.appendLine(vscode.l10n.t("Could not get app PID, showing all logs"));
      }

      const targetDeviceId = currentDevice.id;
      const logcatProcess = this.deviceProvider.startLogcat(
        currentDevice.id,
        pid,
        (text, category) => {
          deviceOutputChannel.appendLine(text);
          // Only send to DAP debug console for the most recently launched device
          if (this.lastLaunchedDeviceId === targetDeviceId) {
            const adapter = getDebugAdapter();
            if (adapter) {
              adapter.writeToConsole(text, category);
            }
          }
        }
      );

      this.lastLaunchedDeviceId = currentDevice.id;

      // Register device session
      this.sessions.set(currentDevice.id, {
        deviceId: currentDevice.id,
        deviceName: currentDevice.name,
        packageName: pkgInfo.packageName,
        logcatProcess,
        outputChannel: deviceOutputChannel,
      });

      // Build done — update status bar (show Run + Stop)
      this.isBuildInProgress = false;
      this.updateStatusBar();

      // Start debug session for floating toolbar (skip on restart and if already active)
      if (!skipDebugSession && !this.debugSession) {
        await this.startDebugSession(currentDevice.name);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === "cancelled" || this.buildCancelled) {
        this.buildCancelled = false;
        this.outputChannel.info(vscode.l10n.t("■ Build cancelled"));
        this.isBuildInProgress = false;
        this.updateStatusBar();
        return;
      }
      this.outputChannel.error(`✗ ${msg}`);
      vscode.window.showErrorMessage(`Android Runner: ${msg}`);
      this.isBuildInProgress = false;
      this.updateStatusBar();
    }
  }

  /**
   * Set or clear the logcat text filter
   */
  public async setLogFilter(): Promise<void> {
    const current = this.logFilter || "";
    const input = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("Filter logcat output (leave empty to clear filter)"),
      value: current,
      placeHolder: vscode.l10n.t("e.g. MainActivity, Error, warning"),
    });
    if (input === undefined) {
      return; // cancelled
    }
    this.logFilter = input || undefined;
    if (this.logFilter) {
      this.outputChannel.appendLine(`\n--- ${vscode.l10n.t('Filter set: "{0}"', this.logFilter)} ---`);
    } else {
      this.outputChannel.appendLine(`\n--- ${vscode.l10n.t("Filter cleared")} ---`);
    }
  }

  /**
   * Called when a native-runner debug session starts (captured via onDidStartDebugSession)
   */
  public getIsRunning(): boolean {
    return this.isBuildInProgress || this.sessions.size > 0;
  }

  public onDebugSessionStarted(session: vscode.DebugSession): void {
    this.debugSession = session;
  }

  /**
   * Start a debug session to show the floating toolbar
   */
  private async startDebugSession(deviceName: string): Promise<void> {
    await this.endDebugSession();

    await vscode.debug.startDebugging(undefined, {
      type: "native-runner",
      name: `Android: ${deviceName}`,
      request: "launch",
    });
    // debugSession is set by onDebugSessionStarted callback
  }

  /**
   * Restart: stop app on current device, rebuild and relaunch, keeping the same debug session
   */
  public async restart(): Promise<void> {
    const device = this.deviceManager.getCurrentDevice();
    if (device) {
      await this.stopDevice(device.id);
    }
    this.killBuild();
    await this.installAndRun(true);
  }

  /**
   * Called when the debug session ends (floating toolbar stop button pressed)
   */
  public onDebugSessionEnded(session: vscode.DebugSession): void {
    if (this.debugSession !== session) {
      return;
    }
    this.debugSession = undefined;
    this.stopAll();
  }

  /**
   * Stop running app(s) — single session stops directly, multiple shows picker
   */
  public async stop(): Promise<void> {
    // If build is in progress, cancel it (don't touch other sessions)
    if (this.isBuildInProgress) {
      this.killBuild();
      return;
    }

    if (this.sessions.size === 0) {
      return;
    }

    // Stop the currently selected device
    const currentDevice = this.deviceManager.getCurrentDevice();
    if (currentDevice && this.sessions.has(currentDevice.id)) {
      await this.stopDevice(currentDevice.id);
    }

    if (this.sessions.size === 0) {
      await this.endDebugSession();
    }
  }

  /**
   * Stop a single device session
   */
  private async stopDevice(deviceId: string): Promise<void> {
    const session = this.sessions.get(deviceId);
    if (!session) { return; }

    try {
      await this.deviceProvider.stopApp(deviceId, session.packageName);
    } catch {
      // ignore
    }

    session.logcatProcess.kill();
    session.outputChannel.appendLine(vscode.l10n.t("■ App stopped"));
    session.outputChannel.dispose();
    this.sessions.delete(deviceId);

    this.outputChannel.info(
      vscode.l10n.t("■ Stopped on {0}", session.deviceName)
    );

    this.updateStatusBar();
  }

  /**
   * Stop all device sessions and cancel any running build
   */
  private async stopAll(): Promise<void> {
    // Show "Stopping..." indicator
    this.stopStatusBarItem.hide();
    this.buildingStatusBarItem.text = `$(loading~spin) ${vscode.l10n.t("Stopping...")}`;
    this.buildingStatusBarItem.command = undefined;
    this.buildingStatusBarItem.show();

    const deviceIds = [...this.sessions.keys()];
    for (const deviceId of deviceIds) {
      await this.stopDevice(deviceId);
    }
    this.killBuild();

    // Reset building text for next build
    this.buildingStatusBarItem.text = `$(loading~spin) ${vscode.l10n.t("Building...")}`;
    this.isBuildInProgress = false;
    this.updateStatusBar();
  }

  private async endDebugSession(): Promise<void> {
    this.debugSession = undefined;

    // 1. Send DAP terminated event
    const adapter = getDebugAdapter();
    if (adapter) {
      adapter.sendTerminated();
    }

    // 2. Also force-stop via API (belt and suspenders)
    try {
      const active = vscode.debug.activeDebugSession;
      if (active?.type === "native-runner") {
        await vscode.debug.stopDebugging(active);
      }
    } catch {
      // ignore
    }
  }

  /**
   * Auto-detect JAVA_HOME from common locations
   */
  private detectJavaHome(): string | undefined {
    // 1. Plugin setting (highest priority)
    const config = vscode.workspace.getConfiguration("native-runner");
    const configJavaHome = config.get<string>("javaHome");
    if (configJavaHome && fs.existsSync(configJavaHome)) {
      return configJavaHome;
    }

    // 2. Already set in environment
    if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) {
      return process.env.JAVA_HOME;
    }

    const isMac = process.platform === "darwin";
    const isWindows = process.platform === "win32";

    // 3. Android Studio bundled JDK (most reliable for Android development)
    const androidStudioJdkPaths = isMac
      ? [
          "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
          `${process.env.HOME}/Applications/Android Studio.app/Contents/jbr/Contents/Home`,
        ]
      : isWindows
        ? [
            `${process.env.LOCALAPPDATA}\\Programs\\Android\\Android Studio\\jbr`,
            `C:\\Program Files\\Android\\Android Studio\\jbr`,
          ]
        : [
            `${process.env.HOME}/android-studio/jbr`,
            "/opt/android-studio/jbr",
            "/usr/local/android-studio/jbr",
          ];

    for (const p of androidStudioJdkPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // 4. macOS: use /usr/libexec/java_home
    if (isMac) {
      try {
        const result = cp.execSync("/usr/libexec/java_home 2>/dev/null", {
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        if (result && fs.existsSync(result)) {
          return result;
        }
      } catch {
        // not available
      }
    }

    // 5. Common JDK install paths
    const commonPaths = isMac
      ? [
          "/Library/Java/JavaVirtualMachines",
          `${process.env.HOME}/Library/Java/JavaVirtualMachines`,
        ]
      : isWindows
        ? [
            `${process.env.ProgramFiles}\\Java`,
            `${process.env.ProgramFiles}\\Eclipse Adoptium`,
            `${process.env.ProgramFiles}\\Microsoft\\jdk`,
            `${process.env.ProgramFiles}\\Zulu`,
          ]
        : ["/usr/lib/jvm"];

    const javaExe = isWindows ? "java.exe" : "java";
    for (const dir of commonPaths) {
      if (fs.existsSync(dir)) {
        try {
          const entries = fs.readdirSync(dir).sort().reverse();
          for (const entry of entries) {
            const home = isMac
              ? path.join(dir, entry, "Contents", "Home")
              : path.join(dir, entry);
            if (fs.existsSync(path.join(home, "bin", javaExe))) {
              return home;
            }
          }
        } catch {
          // ignore
        }
      }
    }

    return undefined;
  }

  private runGradle(projectRoot: string, task: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const isWindows = process.platform === "win32";
      const gradlewPath = path.join(
        projectRoot,
        isWindows ? "gradlew.bat" : "gradlew"
      );

      const executable = fs.existsSync(gradlewPath)
        ? gradlewPath
        : isWindows
          ? "gradlew.bat"
          : "./gradlew";

      const env = { ...process.env };
      const detectedJavaHome = this.detectJavaHome();
      if (detectedJavaHome) {
        env.JAVA_HOME = detectedJavaHome;
        this.outputChannel.info(`  JAVA_HOME: ${detectedJavaHome}`);
      } else {
        this.outputChannel.warn(vscode.l10n.t("JAVA_HOME not found. Build may fail."));
        const openSettings = vscode.l10n.t("Open Settings");
        vscode.window.showWarningMessage(
          vscode.l10n.t("JDK not found. Set native-runner.javaHome or install a JDK."),
          openSettings
        ).then((selection) => {
          if (selection === openSettings) {
            vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "native-runner.javaHome"
            );
          }
        });
      }

      if (isWindows) {
        this.buildProcess = cp.spawn("cmd.exe", ["/c", executable, task, "--console=plain"], {
          cwd: projectRoot,
          env,
          windowsHide: true,
        });
      } else {
        this.buildProcess = cp.spawn(executable, [task, "--console=plain"], {
          cwd: projectRoot,
          env,
        });
      }

      this.buildProcess.stdout?.on("data", (data: Buffer) => {
        for (const line of data.toString().split("\n")) {
          const t = line.trim();
          if (t) { this.outputChannel.info(t); }
        }
      });

      this.buildProcess.stderr?.on("data", (data: Buffer) => {
        for (const line of data.toString().split("\n")) {
          const t = line.trim();
          if (t) { this.outputChannel.warn(t); }
        }
      });

      this.buildProcess.on("close", (code) => {
        this.buildProcess = undefined;
        if (code === 0) {
          this.outputChannel.info(vscode.l10n.t("✓ Build successful"));
          resolve();
        } else if (code === null) {
          // Process was killed (user stopped) — silently reject
          reject(new Error("cancelled"));
        } else {
          reject(new Error(vscode.l10n.t("Gradle build failed with exit code {0}", code)));
        }
      });

      this.buildProcess.on("error", (err) => {
        this.buildProcess = undefined;
        reject(err);
      });
    });
  }

  private buildCancelled = false;

  private killBuild(): void {
    if (this.buildProcess) {
      this.buildCancelled = true;
      this.buildProcess.kill();
      this.buildProcess = undefined;
    }
  }

  /**
   * Update status bar based on current state
   */
  private updateStatusBar(): void {
    if (this.isBuildInProgress) {
      // Building: hide Run, show Building spinner + Stop
      this.runStatusBarItem.hide();
      this.buildingStatusBarItem.text = `$(loading~spin) ${vscode.l10n.t("Building...")}`;
      this.buildingStatusBarItem.command = undefined;
      this.buildingStatusBarItem.show();
      this.stopStatusBarItem.show();
    } else {
      const currentDevice = this.deviceManager.getCurrentDevice();
      const currentDeviceRunning = currentDevice && this.sessions.has(currentDevice.id);
      if (currentDeviceRunning) {
        // Current device has a running session: hide Run, show Stop
        this.runStatusBarItem.hide();
        this.stopStatusBarItem.show();
      } else {
        // Current device is idle: show Run, hide Stop
        this.runStatusBarItem.show();
        this.stopStatusBarItem.hide();
      }
      this.buildingStatusBarItem.hide();
    }
  }

  dispose(): void {
    this.killBuild();
    for (const [, session] of this.sessions) {
      session.logcatProcess.kill();
      session.outputChannel.dispose();
    }
    this.sessions.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
