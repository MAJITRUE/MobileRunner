import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { Device, Emulator, PlatformProvider } from "./types";

export class IosProvider implements PlatformProvider {
  readonly platform = "ios" as const;

  /** Stores console-attached devicectl processes for physical device log streaming */
  private consoleProcesses = new Map<string, cp.ChildProcess>();

  /** Cached Xcode major version (e.g. 15, 16, 26) */
  private xcodeVersion: number | undefined;

  /** Cached simctl data — shared between getConnectedDevices and getAvailableEmulators */
  private simctlCache: { json: any; runtimes: Map<string, string>; timestamp: number } | undefined;
  private static readonly SIMCTL_CACHE_TTL = 2000; // 2 seconds

  public isAvailable(): boolean {
    // Check if xcrun (Xcode command line tools) is available
    try {
      cp.execFileSync("xcrun", ["--version"], { timeout: 5000, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /** Detect and cache Xcode major version */
  public getXcodeVersion(): number {
    if (this.xcodeVersion !== undefined) { return this.xcodeVersion; }
    try {
      const output = cp.execFileSync("xcodebuild", ["-version"], { timeout: 5000 }).toString();
      const match = output.match(/Xcode\s+(\d+)/);
      this.xcodeVersion = match ? parseInt(match[1], 10) : 0;
    } catch {
      this.xcodeVersion = 0;
    }
    return this.xcodeVersion;
  }

  /** Check if devicectl (Xcode 15+) is available */
  public hasDevicectl(): boolean {
    return this.getXcodeVersion() >= 15;
  }

  /** Get cached simctl data (shared between getConnectedDevices and getAvailableEmulators) */
  private async getSimctlData(): Promise<{ json: any; runtimes: Map<string, string> }> {
    const now = Date.now();
    if (this.simctlCache && (now - this.simctlCache.timestamp) < IosProvider.SIMCTL_CACHE_TTL) {
      return this.simctlCache;
    }

    const [devicesOutput, runtimes] = await Promise.all([
      this.exec("xcrun", ["simctl", "list", "devices", "--json"]),
      this.getRuntimeNames(),
    ]);
    const json = JSON.parse(devicesOutput);
    this.simctlCache = { json, runtimes, timestamp: now };
    return this.simctlCache;
  }

  // --- Device Detection ---

  public async getConnectedDevices(): Promise<Device[]> {
    const devices: Device[] = [];

    // Booted simulators
    try {
      const simDevices = await this.getSimulatorDevices();
      devices.push(...simDevices);
    } catch { /* ignore */ }

    // Physical devices (Xcode 15+ devicectl)
    try {
      const physicalDevices = await this.getPhysicalDevices();
      devices.push(...physicalDevices);
    } catch { /* ignore */ }

    return devices;
  }

  private async getSimulatorDevices(): Promise<Device[]> {
    const { json } = await this.getSimctlData();
    const devices: Device[] = [];

    this.simulatorUdids.clear();

    for (const [runtimeId, runtimeDevices] of Object.entries(json.devices || {})) {
      if (!runtimeId.includes("iOS") && !runtimeId.includes("iphone")) { continue; }

      for (const sim of runtimeDevices as any[]) {
        if (sim.isAvailable === false) { continue; }
        this.simulatorUdids.add(sim.udid);
        const isBooted = sim.state === "Booted";
        devices.push({
          id: sim.udid,
          name: sim.name,
          platform: "ios",
          type: "emulator",
          state: sim.state?.toLowerCase() || "shutdown",
          isOnline: isBooted,
        });
      }
    }

    return devices.filter((d) => d.isOnline);
  }

  private async getPhysicalDevices(): Promise<Device[]> {
    if (!this.hasDevicectl()) {
      return this.getPhysicalDevicesViaXctrace();
    }
    try {
      const output = await this.exec("xcrun", [
        "devicectl", "list", "devices",
        "--json-output", "/dev/stdout",
      ], 5000);
      const json = JSON.parse(output);
      const devices: Device[] = [];

      for (const device of json.result?.devices || []) {
        const connectionState = device.connectionProperties?.transportType;
        const isConnected = connectionState === "wired" || connectionState === "wifi" || connectionState === "localNetwork";
        devices.push({
          id: device.hardwareProperties?.udid || device.identifier,
          name: device.deviceProperties?.name || "iOS Device",
          platform: "ios",
          type: "device",
          state: isConnected ? "connected" : "disconnected",
          isOnline: isConnected,
        });
      }

      return devices;
    } catch {
      // devicectl not available (pre-Xcode 15) — try xctrace
      return this.getPhysicalDevicesViaXctrace();
    }
  }

  private async getPhysicalDevicesViaXctrace(): Promise<Device[]> {
    try {
      const output = await this.exec("xcrun", ["xctrace", "list", "devices"]);
      const devices: Device[] = [];
      // Parse lines like: "iPhone (14.5) (00008101-XXXX)"
      for (const line of output.split("\n")) {
        const match = line.match(/^(.+?)\s+\([\d.]+\)\s+\(([A-Fa-f0-9-]+)\)/);
        if (match && !line.includes("Simulator")) {
          devices.push({
            id: match[2],
            name: match[1].trim(),
            platform: "ios",
            type: "device",
            state: "connected",
            isOnline: true,
          });
        }
      }
      return devices;
    } catch { return []; }
  }

  // --- Emulator (Simulator) Management ---

  public async getAvailableEmulators(): Promise<Emulator[]> {
    try {
      const { json, runtimes } = await this.getSimctlData();
      const emulators: Emulator[] = [];

      for (const [runtimeId, runtimeDevices] of Object.entries(json.devices || {})) {
        if (!runtimeId.includes("iOS") && !runtimeId.includes("iphone")) { continue; }
        const runtimeName = runtimes.get(runtimeId) || this.parseRuntimeName(runtimeId);

        for (const sim of runtimeDevices as any[]) {
          if (sim.isAvailable === false) { continue; }
          if (sim.state === "Booted") { continue; }

          emulators.push({
            id: sim.udid,
            name: sim.name,
            platform: "ios",
            runtime: runtimeName,
          });
        }
      }

      return emulators;
    } catch { return []; }
  }

  private async getRuntimeNames(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const output = await this.exec("xcrun", ["simctl", "list", "runtimes", "--json"]);
      const json = JSON.parse(output);
      for (const rt of json.runtimes || []) {
        map.set(rt.identifier, rt.name);
      }
    } catch { /* ignore */ }
    return map;
  }

  private parseRuntimeName(runtimeId: string): string {
    // "com.apple.CoreSimulator.SimRuntime.iOS-17-2" → "iOS 17.2"
    const match = runtimeId.match(/iOS[_-](\d+)[_-](\d+)/i);
    return match ? `iOS ${match[1]}.${match[2]}` : "";
  }

  public async launchEmulator(udid: string, _coldBoot?: boolean): Promise<void> {
    await this.exec("xcrun", ["simctl", "boot", udid]);
    // Open Simulator app
    cp.spawn("open", ["-a", "Simulator"], { stdio: "ignore" });
  }

  public async killEmulator(deviceId: string): Promise<void> {
    try {
      await this.exec("xcrun", ["simctl", "shutdown", deviceId]);
    } catch { /* ignore */ }
  }

  // --- Build ---

  public async buildProject(
    projectRoot: string,
    device: Device,
    scheme: string,
    outputChannel: vscode.LogOutputChannel
  ): Promise<string> {
    const xcodeProject = this.findXcodeProject(projectRoot);
    if (!xcodeProject) {
      throw new Error(vscode.l10n.t("No .xcworkspace or .xcodeproj found"));
    }

    // If no scheme provided, try to auto-detect
    if (!scheme) {
      const schemes = await this.scanVariants(projectRoot);
      scheme = schemes[0] || "";
      if (!scheme) {
        throw new Error(vscode.l10n.t("No Xcode scheme found. Set native-runner.iosScheme."));
      }
    }

    const config = vscode.workspace.getConfiguration("native-runner");
    const buildConfig = config.get<string>("iosConfiguration", "Debug");
    const isSimulator = device.type === "emulator";
    const derivedDataPath = path.join(projectRoot, "build", "DerivedData");

    const args = [
      xcodeProject.type === "workspace" ? "-workspace" : "-project",
      xcodeProject.path,
      "-scheme", scheme,
      "-configuration", buildConfig,
      "-destination", `id=${device.id}`,
      "-derivedDataPath", derivedDataPath,
      "build",
    ];

    outputChannel.info(`  xcodebuild ${args.join(" ")}`);

    await this.runXcodebuild(args, projectRoot, outputChannel);

    // Find .app bundle
    const sdk = isSimulator ? `${buildConfig}-iphonesimulator` : `${buildConfig}-iphoneos`;
    const productsDir = path.join(derivedDataPath, "Build", "Products", sdk);

    if (!fs.existsSync(productsDir)) {
      throw new Error(vscode.l10n.t(".app not found in {0}", productsDir));
    }

    const appBundles = fs.readdirSync(productsDir).filter((f) => f.endsWith(".app"));
    if (appBundles.length === 0) {
      throw new Error(vscode.l10n.t("No .app bundle found in build output"));
    }

    return path.join(productsDir, appBundles[0]);
  }

  private runXcodebuild(
    args: string[],
    cwd: string,
    outputChannel: vscode.LogOutputChannel
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = cp.spawn("xcodebuild", args, { cwd });
      let stderrBuffer = "";

      child.stdout?.on("data", (data: Buffer) => {
        for (const line of data.toString().split("\n")) {
          const t = line.trim();
          if (t) { outputChannel.info(t); }
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        stderrBuffer += text;
        for (const line of text.split("\n")) {
          const t = line.trim();
          if (t) { outputChannel.warn(t); }
        }
      });

      child.on("close", (code) => {
        if (code === 0) {
          outputChannel.info(vscode.l10n.t("✓ Build successful"));
          resolve();
        } else if (code === null) {
          reject(new Error("cancelled"));
        } else {
          const friendlyMsg = this.mapIosError(stderrBuffer);
          reject(new Error(friendlyMsg !== stderrBuffer
            ? friendlyMsg
            : vscode.l10n.t("xcodebuild failed with exit code {0}", code)));
        }
      });

      child.on("error", reject);
    });
  }

  // --- Install / Launch / Stop ---

  public async installApp(deviceId: string, appPath: string): Promise<void> {
    const isSimulator = await this.isSimulator(deviceId);
    try {
      if (isSimulator) {
        await this.exec("xcrun", ["simctl", "install", deviceId, appPath], 120000);
      } else {
        await this.exec("xcrun", [
          "devicectl", "device", "install", "app",
          "--device", deviceId, appPath,
        ], 120000);
      }
    } catch (e: any) {
      throw new Error(this.mapIosError(e.message || String(e)));
    }
  }

  public async launchApp(deviceId: string, bundleId: string, _launchTarget?: string): Promise<void> {
    const isSimulator = await this.isSimulator(deviceId);
    if (isSimulator) {
      await this.exec("xcrun", ["simctl", "launch", deviceId, bundleId]);
    } else {
      // Launch with --console to enable log streaming from physical devices.
      // The process stays alive until the app terminates, streaming logs to stdout.
      await this.launchWithConsole(deviceId, bundleId);
    }
  }

  private launchWithConsole(deviceId: string, bundleId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = cp.spawn("xcrun", [
        "devicectl", "device", "process", "launch",
        "--device", deviceId,
        "--console",
        "--environment-variables", JSON.stringify({ OS_ACTIVITY_DT_MODE: "enable" }),
        bundleId,
      ]);

      let launched = false;
      const timeout = setTimeout(() => {
        if (!launched) {
          // Even if we don't see the marker, assume launch succeeded after 10s
          launched = true;
          this.consoleProcesses.set(deviceId, child);
          resolve();
        }
      }, 10000);

      const onData = (data: Buffer) => {
        const text = data.toString();
        // devicectl prints this line when launch completes and it starts waiting
        if (!launched && text.includes("Waiting for the application to terminate")) {
          launched = true;
          clearTimeout(timeout);
          this.consoleProcesses.set(deviceId, child);
          resolve();
        }
      };

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      child.on("error", (err) => {
        clearTimeout(timeout);
        if (!launched) { reject(err); }
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        this.consoleProcesses.delete(deviceId);
        if (!launched) {
          reject(new Error(`devicectl launch exited with code ${code}`));
        }
      });
    });
  }

  public async stopApp(deviceId: string, bundleId: string): Promise<void> {
    const isSimulator = await this.isSimulator(deviceId);
    if (isSimulator) {
      try {
        await this.exec("xcrun", ["simctl", "terminate", deviceId, bundleId]);
      } catch { /* app may not be running */ }
    } else {
      // Clean up console process (kills the app since it's console-attached)
      const consoleProc = this.consoleProcesses.get(deviceId);
      if (consoleProc) {
        this.consoleProcesses.delete(deviceId);
        consoleProc.kill();
      }
      // Also explicitly terminate via devicectl as a fallback
      try {
        await this.exec("xcrun", [
          "devicectl", "device", "process", "terminate",
          "--device", deviceId, bundleId,
        ]);
      } catch { /* ignore */ }
    }
  }

  // --- Logging ---

  public startLog(
    deviceId: string,
    _pid?: string,
    writeToConsole?: (text: string, category: "stdout" | "stderr") => void
  ): cp.ChildProcess {
    const isSimulator = this.isSimulatorSync(deviceId);

    if (!isSimulator) {
      // Physical device: reuse the console-attached process from launchApp()
      const consoleProc = this.consoleProcesses.get(deviceId);
      if (consoleProc) {
        this.attachLogHandlers(consoleProc, writeToConsole);
        return consoleProc;
      }
      // Fallback: try idevicesyslog (libimobiledevice, works on Xcode < 26)
      return this.startPhysicalDeviceLogFallback(deviceId, writeToConsole);
    }

    // Simulator: use simctl spawn log stream
    const child = cp.spawn("xcrun", [
      "simctl", "spawn", deviceId, "log", "stream",
      "--style", "compact", "--level", "default",
    ]);

    this.attachLogHandlers(child, writeToConsole);
    return child;
  }

  private startPhysicalDeviceLogFallback(
    deviceId: string,
    writeToConsole?: (text: string, category: "stdout" | "stderr") => void
  ): cp.ChildProcess {
    // Try idevicesyslog first (libimobiledevice)
    try {
      cp.execFileSync("which", ["idevicesyslog"], { timeout: 2000, stdio: "ignore" });
      const child = cp.spawn("idevicesyslog", ["-u", deviceId]);
      this.attachLogHandlers(child, writeToConsole);
      return child;
    } catch { /* idevicesyslog not available */ }

    // Last resort: spawn a dummy process that outputs a message
    if (writeToConsole) {
      writeToConsole(
        vscode.l10n.t("Log streaming not available for this device. Console-attached process was not created."),
        "stderr",
      );
    }
    // Return a no-op process (cat /dev/null exits immediately but is a valid ChildProcess)
    return cp.spawn("cat", ["/dev/null"]);
  }

  private attachLogHandlers(
    child: cp.ChildProcess,
    writeToConsole?: (text: string, category: "stdout" | "stderr") => void
  ): void {
    child.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        if (writeToConsole) {
          const category = trimmed.includes("error") || trimmed.includes("fault") ? "stderr" as const : "stdout" as const;
          writeToConsole(trimmed, category);
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      if (writeToConsole) { writeToConsole(data.toString(), "stderr"); }
    });
  }

  public async getAppPid(deviceId: string, bundleId: string): Promise<string | undefined> {
    try {
      const isSimulator = await this.isSimulator(deviceId);
      if (isSimulator) {
        const output = await this.exec("xcrun", [
          "simctl", "spawn", deviceId, "launchctl", "list",
        ]);
        for (const line of output.split("\n")) {
          if (line.includes(bundleId)) {
            const parts = line.trim().split(/\s+/);
            if (parts[0] && /^\d+$/.test(parts[0])) { return parts[0]; }
          }
        }
      } else {
        // Physical device: query running processes via devicectl
        const output = await this.exec("xcrun", [
          "devicectl", "device", "info", "processes",
          "--device", deviceId,
          "--json-output", "/dev/stdout",
        ], 15000);
        const json = JSON.parse(output);
        const processes: any[] = json.result?.runningProcesses || [];
        for (const proc of processes) {
          const executable: string = proc.executable || "";
          if (executable.includes(bundleId) || executable.includes(bundleId.replace(/\./g, "/"))) {
            const pid = proc.processIdentifier;
            if (pid != null) { return String(pid); }
          }
        }
      }
    } catch { /* ignore */ }
    return undefined;
  }

  // --- Project Detection ---

  public findProjectRoot(workspaceFolders: readonly vscode.WorkspaceFolder[], activeFilePath?: string): string | undefined {
    // Strategy 1: Walk up from active file (like Dart-Code's locateBestProjectRoot)
    if (activeFilePath) {
      let dir = path.dirname(activeFilePath);
      while (dir !== path.dirname(dir)) {
        if (this.findXcodeProject(dir) && !this.isFlutterProject(dir)) { return dir; }
        dir = path.dirname(dir);
      }
    }

    // Strategy 2: Scan workspace folders and one level of subdirectories
    for (const folder of workspaceFolders) {
      const root = folder.uri.fsPath;
      if (this.findXcodeProject(root) && !this.isFlutterProject(root)) { return root; }

      try {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
            const subDir = path.join(root, entry.name);
            if (this.findXcodeProject(subDir) && !this.isFlutterProject(subDir)) { return subDir; }
          }
        }
      } catch { /* ignore */ }
    }
    return undefined;
  }

  /**
   * Check if a directory is part of a Flutter project.
   * Skip if Dart-Code extension is installed and pubspec.yaml exists.
   */
  private isFlutterProject(dir: string): boolean {
    if (!vscode.extensions.getExtension("Dart-Code.dart-code")) {
      return false;
    }
    let check = dir;
    for (let i = 0; i < 3; i++) {
      if (fs.existsSync(path.join(check, "pubspec.yaml"))) { return true; }
      const parent = path.dirname(check);
      if (parent === check) { break; }
      check = parent;
    }
    return false;
  }

  private findXcodeProject(dir: string): { path: string; type: "workspace" | "project" } | undefined {
    if (!fs.existsSync(dir)) { return undefined; }
    const entries = fs.readdirSync(dir);

    // Prefer .xcworkspace (CocoaPods/SPM)
    const workspace = entries.find((e) => e.endsWith(".xcworkspace") && !e.startsWith("project."));
    if (workspace) {
      return { path: path.join(dir, workspace), type: "workspace" };
    }

    // Fallback to .xcodeproj
    const project = entries.find((e) => e.endsWith(".xcodeproj"));
    if (project) {
      return { path: path.join(dir, project), type: "project" };
    }

    return undefined;
  }

  public async getPackageInfo(projectRoot: string, scheme: string, artifactPath?: string): Promise<{
    packageName: string;
    launchTarget?: string;
  }> {
    // Tier 1: Read from built .app bundle's Info.plist (most reliable)
    if (artifactPath) {
      const bundleId = await this.readBundleIdFromApp(artifactPath);
      if (bundleId) {
        return { packageName: bundleId };
      }
    }

    // Tier 2: xcodebuild -showBuildSettings (slow but standard)
    const bundleIdFromSettings = await this.readBundleIdFromBuildSettings(projectRoot, scheme);
    if (bundleIdFromSettings) {
      return { packageName: bundleIdFromSettings };
    }

    // Tier 3: Parse project.pbxproj directly (regex fallback)
    const bundleIdFromPbxproj = this.readBundleIdFromPbxproj(projectRoot);
    if (bundleIdFromPbxproj) {
      return { packageName: bundleIdFromPbxproj };
    }

    throw new Error(vscode.l10n.t("Could not determine bundle identifier"));
  }

  private async readBundleIdFromApp(appPath: string): Promise<string | undefined> {
    const infoPlistPath = path.join(appPath, "Info.plist");
    if (!fs.existsSync(infoPlistPath)) {
      return undefined;
    }
    try {
      const output = await this.exec(
        "/usr/libexec/PlistBuddy",
        ["-c", "Print :CFBundleIdentifier", infoPlistPath],
        5000,
      );
      const bundleId = output.trim();
      return bundleId || undefined;
    } catch {
      return undefined;
    }
  }

  private async readBundleIdFromBuildSettings(projectRoot: string, scheme: string): Promise<string | undefined> {
    const xcodeProject = this.findXcodeProject(projectRoot);
    if (!xcodeProject) { return undefined; }

    const config = vscode.workspace.getConfiguration("native-runner");
    const buildConfig = config.get<string>("iosConfiguration", "Debug");

    try {
      const args = [
        xcodeProject.type === "workspace" ? "-workspace" : "-project",
        xcodeProject.path,
        "-scheme", scheme || "",
        "-configuration", buildConfig,
        "-showBuildSettings",
      ];
      const output = await this.exec("xcodebuild", args, 60000);
      const match = output.match(/^\s*PRODUCT_BUNDLE_IDENTIFIER\s*=\s*(.+)/m);
      if (match) {
        return match[1].trim();
      }
    } catch (e) {
      console.error("readBundleIdFromBuildSettings failed:", e);
    }
    return undefined;
  }

  private readBundleIdFromPbxproj(projectRoot: string): string | undefined {
    const xcodeProject = this.findXcodeProject(projectRoot);
    if (!xcodeProject) { return undefined; }

    let pbxprojPath: string;
    if (xcodeProject.type === "workspace") {
      const dir = path.dirname(xcodeProject.path);
      const entries = fs.readdirSync(dir);
      const proj = entries.find((e) => e.endsWith(".xcodeproj"));
      if (!proj) { return undefined; }
      pbxprojPath = path.join(dir, proj, "project.pbxproj");
    } else {
      pbxprojPath = path.join(xcodeProject.path, "project.pbxproj");
    }

    if (!fs.existsSync(pbxprojPath)) { return undefined; }

    try {
      const content = fs.readFileSync(pbxprojPath, "utf-8");
      const match = content.match(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([^";]+)"?\s*;/);
      if (match) {
        const bundleId = match[1].trim();
        if (!bundleId.includes("$(")) {
          return bundleId;
        }
      }
    } catch { /* ignore */ }
    return undefined;
  }

  // --- Variant (Scheme) Scanning ---

  public async scanVariants(projectRoot: string): Promise<string[]> {
    const xcodeProject = this.findXcodeProject(projectRoot);
    if (!xcodeProject) { return []; }

    try {
      const args = [
        xcodeProject.type === "workspace" ? "-workspace" : "-project",
        xcodeProject.path,
        "-list", "-json",
      ];
      const output = await this.exec("xcodebuild", args, 30000);
      const json = JSON.parse(output);
      const key = xcodeProject.type === "workspace" ? "workspace" : "project";
      const schemes: string[] = json[key]?.schemes || [];

      // Collect pod names from Pods/ directory to exclude framework schemes
      const podsDir = path.join(projectRoot, "Pods");
      const podNames = new Set<string>();
      if (fs.existsSync(podsDir)) {
        for (const entry of fs.readdirSync(podsDir)) {
          // Skip special directories
          if (entry === "Target Support Files" || entry === "Headers"
            || entry === "Local Podspecs" || entry.startsWith(".")) { continue; }
          const fullPath = path.join(podsDir, entry);
          if (fs.statSync(fullPath).isDirectory()) {
            podNames.add(entry);
          }
        }
      }

      return schemes.filter((s) => {
        if (s.endsWith("Tests") || s.endsWith("UITests")) { return false; }
        if (s.startsWith("Pods-")) { return false; }
        if (podNames.has(s)) { return false; }
        // Exclude pod-derived schemes like "FirebaseCore-FirebaseCore_Privacy"
        const baseName = s.split("-")[0];
        if (baseName !== s && podNames.has(baseName)) { return false; }
        return true;
      });
    } catch { return []; }
  }

  // --- Error Mapping ---

  /** Map known iOS error codes/messages to user-friendly descriptions */
  private mapIosError(errorText: string): string {
    const errorMap: Array<{ pattern: RegExp; message: string }> = [
      { pattern: /0xe8008015/, message: vscode.l10n.t("Provisioning profile not found. Open the project in Xcode and fix signing settings.") },
      { pattern: /0xe8000067/, message: vscode.l10n.t("Provisioning profile does not match the installed signing identity. Check Xcode signing settings.") },
      { pattern: /0xe8000022/, message: vscode.l10n.t("App launch failed. The device may need to trust this computer or the provisioning profile.") },
      { pattern: /0xe80000e2/, message: vscode.l10n.t("Device is locked. Unlock the device and try again.") },
      { pattern: /device was not.*unlocked/i, message: vscode.l10n.t("Device is locked. Unlock the device and try again.") },
      { pattern: /lost connection/i, message: vscode.l10n.t("Lost connection to device. Check the USB cable and try again.") },
      { pattern: /No signing certificate/i, message: vscode.l10n.t("No signing certificate found. Open the project in Xcode and configure code signing.") },
      { pattern: /Signing requires a development team/i, message: vscode.l10n.t("No development team selected. Set a team in Xcode signing settings.") },
      { pattern: /No profiles for.*were found/i, message: vscode.l10n.t("No provisioning profiles found. Open Xcode to create or download profiles.") },
      { pattern: /Developer Mode.*not enabled/i, message: vscode.l10n.t("Developer Mode is not enabled on the device. Enable it in Settings > Privacy & Security.") },
    ];

    for (const { pattern, message } of errorMap) {
      if (pattern.test(errorText)) {
        return message;
      }
    }
    return errorText;
  }

  // --- Internal Helpers ---

  // Cache simulator UDIDs for sync check
  private simulatorUdids = new Set<string>();

  private async isSimulator(deviceId: string): Promise<boolean> {
    if (this.simulatorUdids.has(deviceId)) { return true; }
    try {
      const output = await this.exec("xcrun", ["simctl", "list", "devices", "--json"]);
      const json = JSON.parse(output);
      this.simulatorUdids.clear();
      for (const runtimeDevices of Object.values(json.devices || {})) {
        for (const sim of runtimeDevices as any[]) {
          this.simulatorUdids.add(sim.udid);
        }
      }
      return this.simulatorUdids.has(deviceId);
    } catch { return false; }
  }

  private isSimulatorSync(deviceId: string): boolean {
    if (this.simulatorUdids.has(deviceId)) { return true; }
    // Simulator UDIDs are UUID format (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx, 36 chars)
    // Physical device UDIDs are hex strings (40 chars) or hyphenated (25 chars like 00008140-...)
    return /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(deviceId);
  }

  private exec(command: string, args: string[], timeoutMs = 10000): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout || error.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }
}
