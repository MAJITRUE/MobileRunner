import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import { DeviceProvider } from "./deviceProvider";
import { DeviceManager } from "./deviceManager";
import { getDebugAdapter } from "./extension";

export class BuildRunner implements vscode.Disposable {
  private outputChannel: vscode.LogOutputChannel;
  private buildProcess: cp.ChildProcess | undefined;
  private logcatProcess: cp.ChildProcess | undefined;
  private runStatusBarItem: vscode.StatusBarItem;
  private stopStatusBarItem: vscode.StatusBarItem;
  private isRunning = false;
  private lastPackageName: string | undefined;
  private logFilter: string | undefined;
  private debugSession: vscode.DebugSession | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private deviceProvider: DeviceProvider,
    private deviceManager: DeviceManager
  ) {
    this.outputChannel = vscode.window.createOutputChannel("Android Runner", { log: true });
    this.disposables.push(this.outputChannel);

    // Run button in status bar
    this.runStatusBarItem = vscode.window.createStatusBarItem(
      "androidRunnerRun",
      vscode.StatusBarAlignment.Right,
      99
    );
    this.runStatusBarItem.name = "Android Run";
    this.runStatusBarItem.text = "$(play) Run";
    this.runStatusBarItem.tooltip = "Build and run Android app";
    this.runStatusBarItem.command = "android-runner.installAndRun";
    this.runStatusBarItem.show();
    this.disposables.push(this.runStatusBarItem);

    // Stop button (hidden by default)
    this.stopStatusBarItem = vscode.window.createStatusBarItem(
      "androidRunnerStop",
      vscode.StatusBarAlignment.Right,
      98
    );
    this.stopStatusBarItem.name = "Android Stop";
    this.stopStatusBarItem.text = "$(debug-stop) Stop";
    this.stopStatusBarItem.tooltip = "Stop running app";
    this.stopStatusBarItem.command = "android-runner.stop";
    this.disposables.push(this.stopStatusBarItem);
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
  private findApk(projectRoot: string, variant: string): string | undefined {
    const apkDir = path.join(projectRoot, "app", "build", "outputs", "apk", variant);
    if (!fs.existsSync(apkDir)) {
      return undefined;
    }

    const files = fs.readdirSync(apkDir).filter((f) => f.endsWith(".apk"));
    if (files.length === 0) {
      return undefined;
    }

    return path.join(apkDir, files[0]);
  }

  /**
   * Extract package name from build.gradle(.kts) or AndroidManifest.xml,
   * and launcher activity from AndroidManifest.xml
   */
  private findPackageInfo(projectRoot: string): { packageName: string; launcherActivity?: string } | undefined {
    let packageName: string | undefined;

    // Try build.gradle.kts first (modern Android projects use namespace/applicationId)
    for (const gradleFile of ["app/build.gradle.kts", "app/build.gradle"]) {
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
      projectRoot, "app", "src", "main", "AndroidManifest.xml"
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
    const device = this.deviceManager.getCurrentDevice();
    if (!device || !device.isOnline) {
      const selected = await this.deviceManager.showDevicePicker();
      if (!selected) {
        return;
      }
    }

    const currentDevice = this.deviceManager.getCurrentDevice();
    if (!currentDevice || !currentDevice.isOnline) {
      vscode.window.showErrorMessage("No online device selected.");
      return;
    }

    const projectRoot = this.findProjectRoot();
    if (!projectRoot) {
      vscode.window.showErrorMessage(
        "No Android project found. Open a folder containing build.gradle or build.gradle.kts."
      );
      return;
    }

    const config = vscode.workspace.getConfiguration("android-runner");
    const variant = config.get<string>("buildVariant", "debug");
    const capitalizedVariant = variant.charAt(0).toUpperCase() + variant.slice(1);

    this.outputChannel.clear();
    this.outputChannel.show(true);
    this.setRunning(true);

    try {
      // Step 1: Build
      this.outputChannel.info(`▶ Building ${variant}...`);
      this.outputChannel.info(`  Project: ${projectRoot}`);
      this.outputChannel.info(`  Device: ${currentDevice.name} (${currentDevice.id})`);

      await this.runGradle(projectRoot, `assemble${capitalizedVariant}`);

      // Step 2: Find APK
      const apkPath = this.findApk(projectRoot, variant);
      if (!apkPath) {
        throw new Error(`APK not found in app/build/outputs/apk/${variant}/`);
      }
      this.outputChannel.info(`✓ APK: ${apkPath}`);

      // Step 3: Install
      this.outputChannel.info(`▶ Installing on ${currentDevice.name}...`);
      await this.deviceProvider.installApk(currentDevice.id, apkPath);
      this.outputChannel.info("✓ Installed");

      // Step 4: Launch
      const pkgInfo = this.findPackageInfo(projectRoot);
      if (!pkgInfo) {
        throw new Error("Could not determine package name from AndroidManifest.xml");
      }

      this.lastPackageName = pkgInfo.packageName;
      this.outputChannel.info(`▶ Launching ${pkgInfo.packageName}...`);
      await this.deviceProvider.launchActivity(
        currentDevice.id,
        pkgInfo.packageName,
        pkgInfo.launcherActivity
      );
      this.outputChannel.info("✓ Launched");

      // Step 5: Start logcat (filtered by app PID)
      this.outputChannel.info("--- Logcat ---");
      this.stopLogcat();
      // Wait for app process to start, retry up to 3 times
      let pid: string | undefined;
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        pid = await this.deviceProvider.getAppPid(currentDevice.id, pkgInfo.packageName);
        if (pid) { break; }
      }
      if (pid) {
        this.outputChannel.info(`(filtered by PID ${pid})`);
      } else {
        this.outputChannel.warn("could not get app PID, showing all logs");
      }
      this.logcatProcess = this.deviceProvider.startLogcat(
        currentDevice.id,
        pid,
        (text, category) => {
          const adapter = getDebugAdapter();
          if (adapter) {
            adapter.writeToConsole(text, category);
          } else {
            // Fallback to output channel
            this.outputChannel.info(text);
          }
        }
      );

      // Build done — update status bar
      this.runStatusBarItem.text = "$(play) Run";

      // Start debug session for floating toolbar (skip on restart)
      if (!skipDebugSession) {
        await this.startDebugSession(currentDevice.name);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.outputChannel.error(`✗ ${msg}`);
      vscode.window.showErrorMessage(`Android Runner: ${msg}`);
      this.setRunning(false);
    }
  }

  /**
   * Set or clear the logcat text filter
   */
  public async setLogFilter(): Promise<void> {
    const current = this.logFilter || "";
    const input = await vscode.window.showInputBox({
      prompt: "Filter logcat output (leave empty to clear filter)",
      value: current,
      placeHolder: "e.g. MainActivity, Error, warning",
    });
    if (input === undefined) {
      return; // cancelled
    }
    this.logFilter = input || undefined;
    if (this.logFilter) {
      this.outputChannel.appendLine(`\n--- Filter set: "${this.logFilter}" ---`);
    } else {
      this.outputChannel.appendLine("\n--- Filter cleared ---");
    }
  }

  /**
   * Start a debug session to show the floating toolbar
   */
  private async startDebugSession(deviceName: string): Promise<void> {
    // Stop any existing debug session first
    if (this.debugSession) {
      await vscode.debug.stopDebugging(this.debugSession);
      this.debugSession = undefined;
    }

    await vscode.debug.startDebugging(undefined, {
      type: "android-runner",
      name: `Android: ${deviceName}`,
      request: "launch",
    });
    this.debugSession = vscode.debug.activeDebugSession;
  }

  /**
   * Restart: stop app and logcat, rebuild and relaunch, keeping the same debug session
   */
  public async restart(): Promise<void> {
    const device = this.deviceManager.getCurrentDevice();
    if (device && this.lastPackageName) {
      try {
        await this.deviceProvider.stopApp(device.id, this.lastPackageName);
      } catch {
        // ignore
      }
    }
    this.stopLogcat();
    this.killBuild();
    await this.installAndRun(true);
  }

  /**
   * Stop the running app
   */
  public async stop(): Promise<void> {
    const device = this.deviceManager.getCurrentDevice();
    if (device && this.lastPackageName) {
      try {
        await this.deviceProvider.stopApp(device.id, this.lastPackageName);
        this.outputChannel.info("■ App stopped");
      } catch {
        // ignore
      }
    }

    // Stop debug session (floating toolbar)
    if (this.debugSession) {
      try {
        await vscode.debug.stopDebugging(this.debugSession);
      } catch {
        // ignore
      }
      this.debugSession = undefined;
    }

    this.stopLogcat();
    this.killBuild();
    this.setRunning(false);
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

      if (isWindows) {
        this.buildProcess = cp.spawn("cmd.exe", ["/c", executable, task, "--console=plain"], {
          cwd: projectRoot,
          windowsHide: true,
        });
      } else {
        this.buildProcess = cp.spawn(executable, [task, "--console=plain"], {
          cwd: projectRoot,
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
          this.outputChannel.info("✓ Build successful");
          resolve();
        } else {
          reject(new Error(`Gradle build failed with exit code ${code}`));
        }
      });

      this.buildProcess.on("error", (err) => {
        this.buildProcess = undefined;
        reject(err);
      });
    });
  }

  private killBuild(): void {
    if (this.buildProcess) {
      this.buildProcess.kill();
      this.buildProcess = undefined;
    }
  }

  private stopLogcat(): void {
    if (this.logcatProcess) {
      this.logcatProcess.kill();
      this.logcatProcess = undefined;
    }
  }

  private setRunning(running: boolean): void {
    this.isRunning = running;
    if (running) {
      this.runStatusBarItem.text = "$(loading~spin) Building...";
      this.stopStatusBarItem.show();
    } else {
      this.runStatusBarItem.text = "$(play) Run";
      this.stopStatusBarItem.hide();
    }
  }

  dispose(): void {
    this.killBuild();
    this.stopLogcat();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
