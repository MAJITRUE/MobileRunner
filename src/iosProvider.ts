import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { Device, Emulator, PlatformProvider } from "./types";

export class IosProvider implements PlatformProvider {
  readonly platform = "ios" as const;

  public isAvailable(): boolean {
    // Check if xcrun (Xcode command line tools) is available
    try {
      cp.execFileSync("xcrun", ["--version"], { timeout: 5000, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
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
    const output = await this.exec("xcrun", ["simctl", "list", "devices", "--json"]);
    const json = JSON.parse(output);
    const devices: Device[] = [];

    for (const [runtimeId, runtimeDevices] of Object.entries(json.devices || {})) {
      // Only include iOS runtimes (skip watchOS, tvOS, visionOS)
      if (!runtimeId.includes("iOS") && !runtimeId.includes("iphone")) { continue; }

      for (const sim of runtimeDevices as any[]) {
        if (sim.isAvailable === false) { continue; }
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

    // Only return booted simulators as "connected"
    return devices.filter((d) => d.isOnline);
  }

  private async getPhysicalDevices(): Promise<Device[]> {
    try {
      const output = await this.exec("xcrun", [
        "devicectl", "list", "devices",
        "--json-output", "/dev/stdout",
      ], 15000);
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
      const output = await this.exec("xcrun", ["simctl", "list", "devices", "--json"]);
      const json = JSON.parse(output);
      const emulators: Emulator[] = [];

      // Also get runtimes for display
      const runtimeNames = await this.getRuntimeNames();

      for (const [runtimeId, runtimeDevices] of Object.entries(json.devices || {})) {
        if (!runtimeId.includes("iOS") && !runtimeId.includes("iphone")) { continue; }
        const runtimeName = runtimeNames.get(runtimeId) || this.parseRuntimeName(runtimeId);

        for (const sim of runtimeDevices as any[]) {
          if (sim.isAvailable === false) { continue; }
          if (sim.state === "Booted") { continue; } // Skip already running

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

      child.stdout?.on("data", (data: Buffer) => {
        for (const line of data.toString().split("\n")) {
          const t = line.trim();
          if (t) { outputChannel.info(t); }
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        for (const line of data.toString().split("\n")) {
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
          reject(new Error(vscode.l10n.t("xcodebuild failed with exit code {0}", code)));
        }
      });

      child.on("error", reject);
    });
  }

  // --- Install / Launch / Stop ---

  public async installApp(deviceId: string, appPath: string): Promise<void> {
    // Determine if simulator or physical device
    const isSimulator = await this.isSimulator(deviceId);
    if (isSimulator) {
      await this.exec("xcrun", ["simctl", "install", deviceId, appPath], 120000);
    } else {
      await this.exec("xcrun", [
        "devicectl", "device", "install", "app",
        "--device", deviceId, appPath,
      ], 120000);
    }
  }

  public async launchApp(deviceId: string, bundleId: string, _launchTarget?: string): Promise<void> {
    const isSimulator = await this.isSimulator(deviceId);
    if (isSimulator) {
      await this.exec("xcrun", ["simctl", "launch", deviceId, bundleId]);
    } else {
      await this.exec("xcrun", [
        "devicectl", "device", "process", "launch",
        "--device", deviceId, bundleId,
      ]);
    }
  }

  public async stopApp(deviceId: string, bundleId: string): Promise<void> {
    const isSimulator = await this.isSimulator(deviceId);
    if (isSimulator) {
      try {
        await this.exec("xcrun", ["simctl", "terminate", deviceId, bundleId]);
      } catch { /* app may not be running */ }
    } else {
      // Physical device — try devicectl
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
    // For simulators, use simctl spawn log stream
    // For physical devices, use log stream --device
    const args = this.isSimulatorSync(deviceId)
      ? ["simctl", "spawn", deviceId, "log", "stream", "--style", "compact", "--level", "default"]
      : ["--device", deviceId, "log", "stream", "--style", "compact", "--level", "default"];

    const cmd = this.isSimulatorSync(deviceId) ? "xcrun" : "log";
    const child = cp.spawn(cmd, args);

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

    return child;
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
      }
    } catch { /* ignore */ }
    return undefined;
  }

  // --- Project Detection ---

  public findProjectRoot(workspaceFolders: readonly vscode.WorkspaceFolder[]): string | undefined {
    for (const folder of workspaceFolders) {
      const root = folder.uri.fsPath;
      const xcodeProject = this.findXcodeProject(root);
      if (xcodeProject) { return root; }

      // Check ios/ subdirectory (Flutter/React Native convention)
      const iosDir = path.join(root, "ios");
      if (fs.existsSync(iosDir)) {
        const iosProject = this.findXcodeProject(iosDir);
        if (iosProject) { return iosDir; }
      }
    }
    return undefined;
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

  public async getPackageInfo(projectRoot: string, scheme: string): Promise<{
    packageName: string;
    launchTarget?: string;
  }> {
    // Get bundle identifier from build settings
    const xcodeProject = this.findXcodeProject(projectRoot);
    if (!xcodeProject) {
      throw new Error(vscode.l10n.t("No Xcode project found"));
    }

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
      const output = await this.exec("xcodebuild", args, 30000);
      const match = output.match(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*(.+)/);
      if (match) {
        return { packageName: match[1].trim() };
      }
    } catch { /* ignore */ }

    throw new Error(vscode.l10n.t("Could not determine bundle identifier"));
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
      // Filter out test schemes
      return schemes.filter((s) => !s.endsWith("Tests") && !s.endsWith("UITests"));
    } catch { return []; }
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
    return this.simulatorUdids.has(deviceId);
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
