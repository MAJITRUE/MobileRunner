import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { Device, Emulator, PlatformProvider, findProjectRootCommon } from "./types";

export class AndroidProvider implements PlatformProvider {
  readonly platform = "android" as const;
  private sdkPath: string | undefined;

  constructor() {
    this.sdkPath = this.resolveSdkPath();
  }

  public isAvailable(): boolean {
    return this.sdkPath !== undefined;
  }

  public refreshSdkPath(): void {
    this.sdkPath = this.resolveSdkPath();
  }

  // --- Device Detection ---

  public async getConnectedDevices(): Promise<Device[]> {
    try {
      const output = await this.exec(this.getAdbPath(), ["devices", "-l"]);
      const lines = output.split("\n").slice(1);
      const devices: Device[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }

        const match = trimmed.match(/^(\S+)\s+(device|offline|unauthorized|no device)\b(.*)$/);
        if (!match) { continue; }

        const id = match[1];
        const state = match[2];
        const details = match[3] || "";

        const modelMatch = details.match(/model:(\S+)/);
        const productMatch = details.match(/product:(\S+)/);
        let name = modelMatch
          ? modelMatch[1].replace(/_/g, " ")
          : productMatch
            ? productMatch[1].replace(/_/g, " ")
            : id;

        const isEmulator = id.startsWith("emulator-");

        if (isEmulator && state === "device") {
          const avdName = await this.getAvdNameForEmulator(id);
          if (avdName) { name = avdName; }
        }

        devices.push({
          id,
          name,
          platform: "android",
          type: isEmulator ? "emulator" : "device",
          state,
          isOnline: state === "device",
        });
      }

      return devices;
    } catch {
      if (!this.sdkPath) {
        const openSettings = vscode.l10n.t("Open Settings");
        vscode.window.showErrorMessage(
          vscode.l10n.t("Android SDK not found. Set native-runner.sdkPath or the ANDROID_HOME environment variable."),
          openSettings
        ).then((selection) => {
          if (selection === openSettings) {
            vscode.commands.executeCommand("workbench.action.openSettings", "native-runner.sdkPath");
          }
        });
      }
      return [];
    }
  }

  public async getAvailableEmulators(): Promise<Emulator[]> {
    try {
      const output = await this.exec(this.getEmulatorPath(), ["-list-avds"]);
      const lines = output.split("\n").filter((l) => l.trim());
      return lines.map((line) => ({
        id: line.trim(),
        name: line.trim(),
        platform: "android" as const,
      }));
    } catch {
      return [];
    }
  }

  // --- Emulator Management ---

  public async launchEmulator(avdName: string, coldBoot = false): Promise<void> {
    const emulatorPath = this.getEmulatorPath();
    const args = ["-avd", avdName];
    if (coldBoot) { args.push("-no-snapshot-load"); }
    const child = cp.spawn(emulatorPath, args, { stdio: "ignore", windowsHide: true });
    child.unref();
  }

  public async killEmulator(deviceId: string): Promise<void> {
    try {
      await this.exec(this.getAdbPath(), ["-s", deviceId, "emu", "kill"]);
    } catch { /* ignore */ }
  }

  // --- Build ---

  public async buildProject(
    projectRoot: string,
    _device: Device,
    variant: string,
    outputChannel: vscode.LogOutputChannel
  ): Promise<string> {
    const capitalizedVariant = variant.charAt(0).toUpperCase() + variant.slice(1);
    await this.runGradle(projectRoot, `assemble${capitalizedVariant}`, outputChannel);

    const apkPath = this.findApk(projectRoot, variant);
    if (!apkPath) {
      throw new Error(vscode.l10n.t("APK not found for variant {0}", variant));
    }
    return apkPath;
  }

  // --- Install / Launch / Stop ---

  public async installApp(deviceId: string, apkPath: string): Promise<void> {
    const output = await this.exec(this.getAdbPath(), ["-s", deviceId, "install", "-r", apkPath], 120000);
    // adb can exit 0 even on failure — check stdout for "Failure" marker
    const failureMatch = output.match(/Failure\s*\[([^\]]+)]/);
    if (failureMatch) {
      throw new Error(`adb install failed: ${failureMatch[1]}`);
    }
  }

  public async launchApp(
    deviceId: string,
    packageName: string,
    activityName?: string
  ): Promise<void> {
    const component = activityName
      ? `${packageName}/${activityName}`
      : `${packageName}/.MainActivity`;
    await this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "am", "start", "-n", component]);
  }

  public async stopApp(deviceId: string, packageName: string): Promise<void> {
    await this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "am", "force-stop", packageName]);
  }

  // --- File Explorer ---

  public async listFiles(deviceId: string, remotePath: string): Promise<string> {
    return this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "ls", "-la", this.sq(remotePath)], 15000);
  }

  public async runAsListFiles(deviceId: string, packageName: string, remotePath: string): Promise<string> {
    return this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "run-as", packageName, "ls", "-la", this.sq(remotePath)], 15000);
  }

  public async listPackages(deviceId: string): Promise<string[]> {
    const output = await this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "pm", "list", "packages", "-3"]);
    return output.split("\n")
      .map((line) => line.trim().replace(/^package:/, ""))
      .filter((pkg) => pkg.length > 0)
      .sort();
  }

  public async pullFile(deviceId: string, remotePath: string, localPath: string): Promise<void> {
    await this.exec(this.getAdbPath(), ["-s", deviceId, "pull", remotePath, localPath], 120000);
  }

  public async pushFile(deviceId: string, localPath: string, remotePath: string): Promise<void> {
    await this.exec(this.getAdbPath(), ["-s", deviceId, "push", localPath, remotePath], 120000);
  }

  public async deleteFile(deviceId: string, remotePath: string): Promise<void> {
    await this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "rm", "-rf", this.sq(remotePath)]);
  }

  public async makeDirectory(deviceId: string, remotePath: string): Promise<void> {
    await this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "mkdir", "-p", this.sq(remotePath)]);
  }

  public async runAsPullFile(deviceId: string, packageName: string, remotePath: string, localPath: string): Promise<void> {
    const cp = await import("child_process");
    const fs = await import("fs");
    return new Promise<void>((resolve, reject) => {
      const proc = cp.spawn(this.getAdbPath(), [
        "-s", deviceId, "exec-out", "run-as", packageName, "cat", remotePath,
      ]);
      const ws = fs.createWriteStream(localPath);
      proc.stdout.pipe(ws);
      let stderr = "";
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        ws.close();
        if (code !== 0) {
          reject(new Error(`exec-out failed (${code}): ${stderr}`));
        } else {
          resolve();
        }
      });
      proc.on("error", reject);
      setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 120000);
    });
  }

  public async runAsPushFile(deviceId: string, packageName: string, localPath: string, remotePath: string): Promise<void> {
    const tmpRemote = "/data/local/tmp/_nr_upload_tmp";
    try {
      // Step 1: push to world-writable tmp
      await this.pushFile(deviceId, localPath, tmpRemote);
      // Step 2: cat outside run-as, pipe into run-as (single shell command string)
      await this.exec(this.getAdbPath(), [
        "-s", deviceId, "shell",
        `cat ${this.sq(tmpRemote)} | run-as ${packageName} sh -c ${this.sq("cat > " + this.sq(remotePath))}`,
      ], 120000);
    } finally {
      try { await this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "rm", "-f", this.sq(tmpRemote)]); } catch { /* ignore */ }
    }
  }

  public async runAsDeleteFile(deviceId: string, packageName: string, remotePath: string): Promise<void> {
    await this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "run-as", packageName, "rm", "-rf", this.sq(remotePath)]);
  }

  public async runAsMakeDirectory(deviceId: string, packageName: string, remotePath: string): Promise<void> {
    await this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "run-as", packageName, "mkdir", "-p", this.sq(remotePath)]);
  }

  public async renameFile(deviceId: string, oldPath: string, newPath: string): Promise<void> {
    await this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "mv", this.sq(oldPath), this.sq(newPath)]);
  }

  public async runAsRenameFile(deviceId: string, packageName: string, oldPath: string, newPath: string): Promise<void> {
    await this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "run-as", packageName, "mv", this.sq(oldPath), this.sq(newPath)]);
  }

  public async moveFile(deviceId: string, srcPath: string, destPath: string): Promise<void> {
    await this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "mv", this.sq(srcPath), this.sq(destPath)]);
  }

  public async runAsMoveFile(deviceId: string, packageName: string, srcPath: string, destPath: string): Promise<void> {
    await this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "run-as", packageName, "mv", this.sq(srcPath), this.sq(destPath)]);
  }

  public async copyFile(deviceId: string, srcPath: string, destPath: string): Promise<void> {
    await this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "cp", "-r", this.sq(srcPath), this.sq(destPath)]);
  }

  public async runAsCopyFile(deviceId: string, packageName: string, srcPath: string, destPath: string): Promise<void> {
    await this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "run-as", packageName, "cp", "-r", this.sq(srcPath), this.sq(destPath)]);
  }

  public async touchFile(deviceId: string, remotePath: string): Promise<void> {
    await this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "touch", this.sq(remotePath)]);
  }

  public async runAsTouchFile(deviceId: string, packageName: string, remotePath: string): Promise<void> {
    await this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "run-as", packageName, "touch", this.sq(remotePath)]);
  }

  // --- Logging ---

  public startLog(
    deviceId: string,
    pid?: string,
    writeToConsole?: (text: string, category: "stdout" | "stderr") => void
  ): cp.ChildProcess {
    const args = ["-s", deviceId, "logcat", "-v", "brief"];
    if (pid) { args.push("--pid", pid); }

    const child = cp.spawn(this.getAdbPath(), args, { windowsHide: true });

    child.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        if (writeToConsole) {
          const category = (trimmed.startsWith("E/") || trimmed.startsWith("E ")) ? "stderr" as const : "stdout" as const;
          writeToConsole(trimmed, category);
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      if (writeToConsole) { writeToConsole(data.toString(), "stderr"); }
    });

    return child;
  }

  public async getAppPid(deviceId: string, packageName: string): Promise<string | undefined> {
    try {
      const output = await this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "pidof", packageName]);
      const pid = output.trim().split(/\s+/)[0];
      if (pid && /^\d+$/.test(pid)) { return pid; }
    } catch { /* ignore */ }

    try {
      const output = await this.exec(this.getAdbPath(), ["-s", deviceId, "shell", "ps", "-A"]);
      for (const line of output.split("\n")) {
        if (line.includes(packageName)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2 && /^\d+$/.test(parts[1])) { return parts[1]; }
        }
      }
    } catch { /* ignore */ }

    return undefined;
  }

  // --- Project Detection ---

  private hasGradleProject(dir: string): boolean {
    return fs.existsSync(path.join(dir, "build.gradle")) || fs.existsSync(path.join(dir, "build.gradle.kts"));
  }

  /**
   * Check if a directory is part of a Flutter project (has pubspec.yaml at same level or parent).
   * If Dart-Code extension is installed, skip Flutter projects to avoid conflicts.
   */
  private isFlutterProject(dir: string): boolean {
    if (!vscode.extensions.getExtension("Dart-Code.dart-code")) {
      return false; // No Dart extension — no conflict
    }
    // Check current dir and up to 2 parent levels for pubspec.yaml
    let check = dir;
    for (let i = 0; i < 3; i++) {
      if (fs.existsSync(path.join(check, "pubspec.yaml"))) { return true; }
      const parent = path.dirname(check);
      if (parent === check) { break; }
      check = parent;
    }
    return false;
  }

  public findProjectRoot(workspaceFolders: readonly vscode.WorkspaceFolder[], activeFilePath?: string): string | undefined {
    return findProjectRootCommon(
      (dir) => this.hasGradleProject(dir) && !this.isFlutterProject(dir),
      workspaceFolders,
      activeFilePath,
    );
  }

  public async getPackageInfo(projectRoot: string, _variant: string, _artifactPath?: string): Promise<{
    packageName: string;
    launchTarget?: string;
  }> {
    const appModule = this.getAppModule();
    let packageName: string | undefined;

    for (const gradleFile of [`${appModule}/build.gradle.kts`, `${appModule}/build.gradle`]) {
      const gradlePath = path.join(projectRoot, gradleFile);
      if (fs.existsSync(gradlePath)) {
        const content = fs.readFileSync(gradlePath, "utf-8");
        const appIdMatch = content.match(/applicationId\s*[=( ]\s*"([^"]+)"/);
        if (appIdMatch) { packageName = appIdMatch[1]; break; }
        const nsMatch = content.match(/namespace\s*[=( ]\s*"([^"]+)"/);
        if (nsMatch) { packageName = nsMatch[1]; break; }
      }
    }

    const manifestPath = path.join(projectRoot, appModule, "src", "main", "AndroidManifest.xml");
    if (!packageName && fs.existsSync(manifestPath)) {
      const content = fs.readFileSync(manifestPath, "utf-8");
      const pkgMatch = content.match(/package\s*=\s*"([^"]+)"/);
      if (pkgMatch) { packageName = pkgMatch[1]; }
    }

    if (!packageName) {
      throw new Error(vscode.l10n.t("Could not determine package name from AndroidManifest.xml"));
    }

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

    return { packageName, launchTarget: launcherActivity };
  }

  // --- Variant Scanning ---

  public async scanVariants(projectRoot: string): Promise<string[]> {
    const output = await this.runGradleTasks(projectRoot);
    return this.parseInstallTasks(output);
  }

  // --- Internal Helpers ---

  private getAppModule(): string {
    return vscode.workspace.getConfiguration("native-runner").get<string>("appModule", "app");
  }

  /** Write sdk.dir to local.properties if not already present */
  private ensureLocalProperties(projectRoot: string): void {
    if (!this.sdkPath) { return; }
    const localPropsPath = path.join(projectRoot, "local.properties");
    const escapedSdkPath = this.sdkPath.replace(/\\/g, "\\\\");
    try {
      if (fs.existsSync(localPropsPath)) {
        const content = fs.readFileSync(localPropsPath, "utf-8");
        if (/^sdk\.dir\s*=/m.test(content)) { return; }
        fs.appendFileSync(localPropsPath, `\nsdk.dir=${escapedSdkPath}\n`);
      } else {
        fs.writeFileSync(localPropsPath, `sdk.dir=${escapedSdkPath}\n`);
      }
    } catch { /* ignore — read-only filesystem etc. */ }
  }

  private resolveSdkPath(): string | undefined {
    const config = vscode.workspace.getConfiguration("native-runner");
    const configPath = config.get<string>("sdkPath");
    if (configPath) { return configPath; }
    if (process.env.ANDROID_HOME) { return process.env.ANDROID_HOME; }
    if (process.env.ANDROID_SDK_ROOT) { return process.env.ANDROID_SDK_ROOT; }

    const home = process.env.HOME || process.env.USERPROFILE || "";
    const candidates = [
      path.join(home, "AppData", "Local", "Android", "Sdk"),
      path.join(home, "Library", "Android", "sdk"),
      path.join(home, "Android", "Sdk"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) { return candidate; }
    }
    return undefined;
  }

  private getAdbPath(): string {
    const exe = process.platform === "win32" ? "adb.exe" : "adb";
    return this.sdkPath ? path.join(this.sdkPath, "platform-tools", exe) : exe;
  }

  private getEmulatorPath(): string {
    const exe = process.platform === "win32" ? "emulator.exe" : "emulator";
    return this.sdkPath ? path.join(this.sdkPath, "emulator", exe) : exe;
  }

  /** Quote a path for use in adb shell commands (POSIX single-quote escaping) */
  private sq(p: string): string {
    return "'" + p.replace(/'/g, "'\\''") + "'";
  }

  private exec(command: string, args: string[], timeoutMs = 10000): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout || error.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }

  private async getAvdNameForEmulator(deviceId: string): Promise<string | undefined> {
    try {
      const output = await this.exec(this.getAdbPath(), ["-s", deviceId, "emu", "avd", "name"]);
      const name = output.split("\n")[0]?.trim();
      return name && name !== "OK" ? name.replace(/_/g, " ") : undefined;
    } catch { return undefined; }
  }

  private findApk(projectRoot: string, variant: string): string | undefined {
    const appModule = this.getAppModule();
    const parentDir = path.dirname(projectRoot);

    // Search locations for APK directory
    const apkRoots = [
      path.join(projectRoot, appModule, "build", "outputs", "apk"),
      path.join(projectRoot, appModule, "build", "outputs", "flutter-apk"),
      path.join(parentDir, "build", appModule, "outputs", "apk"),
      path.join(parentDir, "build", appModule, "outputs", "flutter-apk"),
    ];

    // Recursively find all APK files, then match by variant name
    const variantLower = variant.toLowerCase();
    const allApks: string[] = [];
    const matchingApks: string[] = [];

    for (const apkRoot of apkRoots) {
      if (!fs.existsSync(apkRoot)) { continue; }
      const stack = [apkRoot];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              stack.push(full);
            } else if (entry.name.endsWith(".apk") && !entry.name.endsWith("-androidTest.apk")) {
              allApks.push(full);
              const lower = full.toLowerCase();
              if (lower.includes(`${path.sep}${variantLower}${path.sep}`) || path.basename(lower).includes(variantLower)) {
                matchingApks.push(full);
              }
            }
          }
        } catch { /* ignore permission errors */ }
      }
    }

    // Prefer variant-matching APKs, fall back to any APK
    const candidates = matchingApks.length > 0 ? matchingApks : allApks;
    if (candidates.length === 0) { return undefined; }

    // Return the most recently modified APK
    candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return candidates[0];
  }

  private runGradle(
    projectRoot: string,
    task: string,
    outputChannel: vscode.LogOutputChannel
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const isWindows = process.platform === "win32";
      const gradlewPath = path.join(projectRoot, isWindows ? "gradlew.bat" : "gradlew");
      const executable = fs.existsSync(gradlewPath) ? gradlewPath : isWindows ? "gradlew.bat" : "./gradlew";

      // Ensure gradlew is executable (like Flutter does)
      if (!isWindows && fs.existsSync(gradlewPath)) {
        try { fs.chmodSync(gradlewPath, 0o755); } catch { /* ignore */ }
      }

      // Write sdk.dir to local.properties if needed
      this.ensureLocalProperties(projectRoot);

      const env = { ...process.env };
      if (this.sdkPath) { env.ANDROID_SDK_ROOT = this.sdkPath; }
      const javaHome = this.detectJavaHome();
      if (javaHome) {
        env.JAVA_HOME = javaHome;
        outputChannel.info(`  JAVA_HOME: ${javaHome}`);
      } else {
        outputChannel.warn(vscode.l10n.t("JAVA_HOME not found. Build may fail."));
      }

      let buildProcess: cp.ChildProcess;
      if (isWindows) {
        buildProcess = cp.spawn("cmd.exe", ["/c", executable, task, "--console=plain"], { cwd: projectRoot, env, windowsHide: true });
      } else {
        buildProcess = cp.spawn(executable, [task, "--console=plain"], { cwd: projectRoot, env });
      }

      // Store reference for cancellation
      (this as any)._buildProcess = buildProcess;

      buildProcess.stdout?.on("data", (data: Buffer) => {
        for (const line of data.toString().split("\n")) {
          const t = line.trim();
          if (t) { outputChannel.info(t); }
        }
      });

      buildProcess.stderr?.on("data", (data: Buffer) => {
        for (const line of data.toString().split("\n")) {
          const t = line.trim();
          if (t) { outputChannel.warn(t); }
        }
      });

      buildProcess.on("close", (code) => {
        (this as any)._buildProcess = undefined;
        if (code === 0) {
          outputChannel.info(vscode.l10n.t("✓ Build successful"));
          resolve();
        } else if (code === null) {
          reject(new Error("cancelled"));
        } else {
          reject(new Error(vscode.l10n.t("Gradle build failed with exit code {0}", code)));
        }
      });

      buildProcess.on("error", (err) => {
        (this as any)._buildProcess = undefined;
        reject(err);
      });
    });
  }

  private runGradleTasks(projectRoot: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const isWindows = process.platform === "win32";
      const gradlewPath = path.join(projectRoot, isWindows ? "gradlew.bat" : "gradlew");
      const executable = fs.existsSync(gradlewPath) ? gradlewPath : isWindows ? "gradlew.bat" : "./gradlew";

      if (!isWindows && fs.existsSync(gradlewPath)) {
        try { fs.chmodSync(gradlewPath, 0o755); } catch { /* ignore */ }
      }
      this.ensureLocalProperties(projectRoot);

      const appModule = this.getAppModule();
      const args = [`${appModule}:tasks`, "--all", "--console=plain"];
      const env = { ...process.env };
      if (this.sdkPath) { env.ANDROID_SDK_ROOT = this.sdkPath; }
      const javaHome = this.detectJavaHome();
      if (javaHome) { env.JAVA_HOME = javaHome; }

      const spawnArgs = isWindows
        ? { cmd: "cmd.exe" as string, args: ["/c", executable, ...args] }
        : { cmd: executable, args };

      cp.execFile(spawnArgs.cmd, spawnArgs.args, {
        cwd: projectRoot, env, timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) { reject(new Error(stderr || stdout || error.message)); return; }
        resolve(stdout);
      });
    });
  }

  private parseInstallTasks(output: string): string[] {
    const variants: string[] = [];
    const regex = /^(?::?\w+:)?install([A-Z][A-Za-z0-9]*)(?:\s+-\s+|\s*$)/gm;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(output)) !== null) {
      const suffix = match[1];
      if (suffix.endsWith("AndroidTest") || suffix.endsWith("UnitTest")) { continue; }
      const normalized = suffix.charAt(0).toLowerCase() + suffix.slice(1);
      if (!variants.includes(normalized)) { variants.push(normalized); }
    }
    return variants;
  }

  private detectJavaHome(): string | undefined {
    const config = vscode.workspace.getConfiguration("native-runner");
    const configJavaHome = config.get<string>("javaHome");
    if (configJavaHome && fs.existsSync(configJavaHome)) { return configJavaHome; }
    if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) { return process.env.JAVA_HOME; }

    const isMac = process.platform === "darwin";
    const isWindows = process.platform === "win32";

    const androidStudioJdkPaths = isMac
      ? ["/Applications/Android Studio.app/Contents/jbr/Contents/Home", `${process.env.HOME}/Applications/Android Studio.app/Contents/jbr/Contents/Home`]
      : isWindows
        ? [`${process.env.LOCALAPPDATA}\\Programs\\Android\\Android Studio\\jbr`, `C:\\Program Files\\Android\\Android Studio\\jbr`]
        : [`${process.env.HOME}/android-studio/jbr`, "/opt/android-studio/jbr", "/usr/local/android-studio/jbr"];

    for (const p of androidStudioJdkPaths) {
      if (fs.existsSync(p)) { return p; }
    }

    if (isMac) {
      try {
        const result = cp.execSync("/usr/libexec/java_home 2>/dev/null", { encoding: "utf-8", timeout: 5000 }).trim();
        if (result && fs.existsSync(result)) { return result; }
      } catch { /* not available */ }
    }

    const commonPaths = isMac
      ? ["/Library/Java/JavaVirtualMachines", `${process.env.HOME}/Library/Java/JavaVirtualMachines`]
      : isWindows
        ? [`${process.env.ProgramFiles}\\Java`, `${process.env.ProgramFiles}\\Eclipse Adoptium`, `${process.env.ProgramFiles}\\Microsoft\\jdk`, `${process.env.ProgramFiles}\\Zulu`]
        : ["/usr/lib/jvm"];

    const javaExe = isWindows ? "java.exe" : "java";
    for (const dir of commonPaths) {
      if (fs.existsSync(dir)) {
        try {
          const entries = fs.readdirSync(dir).sort().reverse();
          for (const entry of entries) {
            const home = isMac ? path.join(dir, entry, "Contents", "Home") : path.join(dir, entry);
            if (fs.existsSync(path.join(home, "bin", javaExe))) { return home; }
          }
        } catch { /* ignore */ }
      }
    }

    return undefined;
  }
}
