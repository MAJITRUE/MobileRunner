import * as cp from "child_process";
import * as vscode from "vscode";

export type Platform = "android" | "ios";

export interface Device {
  id: string;
  name: string;
  platform: Platform;
  type: "device" | "emulator"; // emulator = Android emulator / iOS simulator
  state: string; // "device"/"booted"/"offline"/"unauthorized"/"shutdown"
  isOnline: boolean;
}

export interface Emulator {
  id: string;
  name: string;
  platform: Platform;
  runtime?: string; // iOS only: "iOS 17.2"
}

export interface DeviceSession {
  deviceId: string;
  deviceName: string;
  platform: Platform;
  packageName: string; // applicationId or bundleId
  logProcess: cp.ChildProcess;
  outputChannel: vscode.OutputChannel;
  debugSession?: vscode.DebugSession;
}

export interface PlatformProvider {
  readonly platform: Platform;

  /** Check if the platform SDK is available on this machine */
  isAvailable(): boolean;

  /** Get connected/booted devices */
  getConnectedDevices(): Promise<Device[]>;

  /** Get available emulators/simulators (offline ones) */
  getAvailableEmulators(): Promise<Emulator[]>;

  /** Launch an emulator/simulator */
  launchEmulator(id: string, coldBoot?: boolean): Promise<void>;

  /** Kill a running emulator/simulator */
  killEmulator(deviceId: string): Promise<void>;

  /** Build the project, returning the artifact path (.apk or .app) */
  buildProject(
    projectRoot: string,
    device: Device,
    variant: string,
    outputChannel: vscode.LogOutputChannel
  ): Promise<string>;

  /** Install app artifact on device */
  installApp(deviceId: string, artifactPath: string): Promise<void>;

  /** Launch app on device */
  launchApp(deviceId: string, packageName: string, launchTarget?: string): Promise<void>;

  /** Stop app on device */
  stopApp(deviceId: string, packageName: string): Promise<void>;

  /** Start log streaming, returns the child process */
  startLog(
    deviceId: string,
    pid?: string,
    writeToConsole?: (text: string, category: "stdout" | "stderr") => void
  ): cp.ChildProcess;

  /** Get PID of running app */
  getAppPid(deviceId: string, packageName: string): Promise<string | undefined>;

  /** Find project root for this platform.
   *  Strategy: if activeFilePath is provided, walk up from there looking for project markers.
   *  Otherwise scan workspace folders and their immediate subdirectories. */
  findProjectRoot(workspaceFolders: readonly vscode.WorkspaceFolder[], activeFilePath?: string): string | undefined;

  /** Get package/bundle info from project */
  getPackageInfo(projectRoot: string, variant: string, artifactPath?: string): Promise<{
    packageName: string;
    launchTarget?: string;
  }>;

  /** Scan available build variants/schemes */
  scanVariants(projectRoot: string): Promise<string[]>;
}
