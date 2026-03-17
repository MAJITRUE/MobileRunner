import * as cp from "child_process";
import * as path from "path";
import * as vscode from "vscode";

export interface AndroidDevice {
  id: string;
  name: string;
  type: "device" | "emulator";
  state: "device" | "offline" | "unauthorized" | "no device";
  isOnline: boolean;
}

export interface AvdEmulator {
  id: string;
  name: string;
}

export class DeviceProvider {
  private sdkPath: string | undefined;

  constructor() {
    this.sdkPath = this.resolveSdkPath();
  }

  private resolveSdkPath(): string | undefined {
    const config = vscode.workspace.getConfiguration("native-runner");
    const configPath = config.get<string>("sdkPath");
    if (configPath) {
      return configPath;
    }
    if (process.env.ANDROID_HOME) {
      return process.env.ANDROID_HOME;
    }
    if (process.env.ANDROID_SDK_ROOT) {
      return process.env.ANDROID_SDK_ROOT;
    }

    // Auto-detect common SDK locations
    const fs = require("fs");
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const candidates = [
      path.join(home, "AppData", "Local", "Android", "Sdk"), // Windows
      path.join(home, "Library", "Android", "sdk"),           // macOS
      path.join(home, "Android", "Sdk"),                      // Linux
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  public refreshSdkPath(): void {
    this.sdkPath = this.resolveSdkPath();
  }

  private getAdbPath(): string {
    const isWindows = process.platform === "win32";
    const exe = isWindows ? "adb.exe" : "adb";
    if (this.sdkPath) {
      return path.join(this.sdkPath, "platform-tools", exe);
    }
    return exe;
  }

  private getEmulatorPath(): string {
    const isWindows = process.platform === "win32";
    const exe = isWindows ? "emulator.exe" : "emulator";
    if (this.sdkPath) {
      return path.join(this.sdkPath, "emulator", exe);
    }
    return exe;
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

  /**
   * Get the AVD name from a running emulator via telnet command
   */
  private async getAvdNameForEmulator(deviceId: string): Promise<string | undefined> {
    try {
      const output = await this.exec(this.getAdbPath(), [
        "-s", deviceId, "emu", "avd", "name",
      ]);
      const name = output.split("\n")[0]?.trim();
      return name && name !== "OK" ? name.replace(/_/g, " ") : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Get connected devices via `adb devices -l`
   */
  public async getConnectedDevices(): Promise<AndroidDevice[]> {
    try {
      const output = await this.exec(this.getAdbPath(), ["devices", "-l"]);
      const lines = output.split("\n").slice(1); // Skip header
      const devices: AndroidDevice[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        const match = trimmed.match(/^(\S+)\s+(device|offline|unauthorized|no device)\b(.*)$/);
        if (!match) {
          continue;
        }

        const id = match[1];
        const state = match[2] as AndroidDevice["state"];
        const details = match[3] || "";

        // Extract model name from details
        const modelMatch = details.match(/model:(\S+)/);
        const productMatch = details.match(/product:(\S+)/);
        let name = modelMatch
          ? modelMatch[1].replace(/_/g, " ")
          : productMatch
            ? productMatch[1].replace(/_/g, " ")
            : id;

        const isEmulator = id.startsWith("emulator-");

        // For emulators, get the AVD name for a friendlier display
        if (isEmulator && state === "device") {
          const avdName = await this.getAvdNameForEmulator(id);
          if (avdName) {
            name = avdName;
          }
        }

        devices.push({
          id,
          name,
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
            vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "native-runner.sdkPath"
            );
          }
        });
      }
      return [];
    }
  }

  /**
   * Get available AVDs via `emulator -list-avds`
   */
  public async getAvailableEmulators(): Promise<AvdEmulator[]> {
    try {
      const output = await this.exec(this.getEmulatorPath(), ["-list-avds"]);
      const lines = output.split("\n").filter((l) => l.trim());
      return lines.map((line) => ({
        id: line.trim(),
        name: line.trim(),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Kill a running emulator via adb
   */
  public async killEmulator(deviceId: string): Promise<void> {
    try {
      await this.exec(this.getAdbPath(), ["-s", deviceId, "emu", "kill"]);
    } catch {
      // ignore
    }
  }

  /**
   * Launch an AVD emulator
   */
  public async launchEmulator(avdName: string, coldBoot = false): Promise<void> {
    const emulatorPath = this.getEmulatorPath();
    const args = ["-avd", avdName];
    if (coldBoot) {
      args.push("-no-snapshot-load");
    }
    // Spawn detached so it doesn't block VSCode
    const child = cp.spawn(emulatorPath, args, {
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  }

  /**
   * Get the package name from the APK or gradle output
   */
  public async getPackageName(apkPath: string): Promise<string | undefined> {
    try {
      const aaptPath = this.findAapt2();
      if (!aaptPath) {
        return undefined;
      }
      const output = await this.exec(aaptPath, ["dump", "badging", apkPath]);
      const match = output.match(/package:\s+name='([^']+)'/);
      return match ? match[1] : undefined;
    } catch {
      return undefined;
    }
  }

  private findAapt2(): string | undefined {
    if (!this.sdkPath) {
      return undefined;
    }
    // aapt2 is in build-tools/<version>/
    const buildToolsDir = path.join(this.sdkPath, "build-tools");
    try {
      const fs = require("fs");
      const versions = fs.readdirSync(buildToolsDir).sort().reverse();
      if (versions.length > 0) {
        const exe = process.platform === "win32" ? "aapt2.exe" : "aapt2";
        return path.join(buildToolsDir, versions[0], exe);
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  /**
   * Install APK on device
   */
  public async installApk(deviceId: string, apkPath: string): Promise<void> {
    await this.exec(this.getAdbPath(), ["-s", deviceId, "install", "-r", apkPath], 120000);
  }

  /**
   * Launch an activity on device
   */
  public async launchActivity(
    deviceId: string,
    packageName: string,
    activityName?: string
  ): Promise<void> {
    const component = activityName
      ? `${packageName}/${activityName}`
      : `${packageName}/.MainActivity`;

    await this.exec(this.getAdbPath(), [
      "-s", deviceId,
      "shell", "am", "start",
      "-n", component,
    ]);
  }

  /**
   * Force stop an app on device
   */
  public async stopApp(deviceId: string, packageName: string): Promise<void> {
    await this.exec(this.getAdbPath(), [
      "-s", deviceId,
      "shell", "am", "force-stop",
      packageName,
    ]);
  }

  /**
   * Get the PID of a running app
   */
  public async getAppPid(deviceId: string, packageName: string): Promise<string | undefined> {
    // Try pidof first
    try {
      const output = await this.exec(this.getAdbPath(), [
        "-s", deviceId, "shell", "pidof", packageName,
      ]);
      const pid = output.trim().split(/\s+/)[0];
      if (pid && /^\d+$/.test(pid)) {
        return pid;
      }
    } catch {
      // ignore
    }

    // Fallback: parse ps output
    try {
      const output = await this.exec(this.getAdbPath(), [
        "-s", deviceId, "shell", "ps", "-A",
      ]);
      for (const line of output.split("\n")) {
        if (line.includes(packageName)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
            return parts[1];
          }
        }
      }
    } catch {
      // ignore
    }

    return undefined;
  }

  /**
   * Open logcat for a device, filtered by package PID.
   * Output goes to debug console via writeToConsole callback.
   */
  public startLogcat(
    deviceId: string,
    pid?: string,
    writeToConsole?: (text: string, category: "stdout" | "stderr") => void
  ): cp.ChildProcess {
    const args = ["-s", deviceId, "logcat", "-v", "brief"];
    if (pid) {
      args.push("--pid", pid);
    }

    const child = cp.spawn(this.getAdbPath(), args, { windowsHide: true });

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        if (writeToConsole) {
          const category = (trimmed.startsWith("E/") || trimmed.startsWith("E ")) ? "stderr" as const : "stdout" as const;
          writeToConsole(trimmed, category);
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      if (writeToConsole) {
        writeToConsole(data.toString(), "stderr");
      }
    });

    return child;
  }
}
