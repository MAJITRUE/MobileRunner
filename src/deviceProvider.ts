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
    const config = vscode.workspace.getConfiguration("android-runner");
    const configPath = config.get<string>("sdkPath");
    if (configPath) {
      return configPath;
    }
    return (
      process.env.ANDROID_HOME ||
      process.env.ANDROID_SDK_ROOT ||
      undefined
    );
  }

  public refreshSdkPath(): void {
    this.sdkPath = this.resolveSdkPath();
  }

  private getAdbPath(): string {
    if (this.sdkPath) {
      return path.join(this.sdkPath, "platform-tools", "adb");
    }
    return "adb";
  }

  private getEmulatorPath(): string {
    if (this.sdkPath) {
      return path.join(this.sdkPath, "emulator", "emulator");
    }
    return "emulator";
  }

  private exec(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.execFile(command, args, { timeout: 10000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`));
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
   * Launch an AVD emulator
   */
  public async launchEmulator(avdName: string): Promise<void> {
    const emulatorPath = this.getEmulatorPath();
    // Spawn detached so it doesn't block VSCode
    const child = cp.spawn(emulatorPath, ["-avd", avdName], {
      detached: true,
      stdio: "ignore",
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
        return path.join(buildToolsDir, versions[0], "aapt2");
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
    await this.exec(this.getAdbPath(), ["-s", deviceId, "install", "-r", apkPath]);
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

    const child = cp.spawn(this.getAdbPath(), args);

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
