import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/** Directories to skip during project search */
const SKIP_DIRS = new Set(["node_modules", "build", "dist", "out", "vendor", "Pods", ".gradle"]);

/**
 * Recursively search for a project root in workspace folders.
 * @param matcher - function that returns true if the directory contains a project
 * @param workspaceFolders - VSCode workspace folders
 * @param activeFilePath - currently open file (searched upward first)
 * @param maxDepth - maximum subdirectory depth to search (default from settings)
 */
export function findProjectRootCommon(
  matcher: (dir: string) => boolean,
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  activeFilePath?: string,
  maxDepth?: number,
): string | undefined {
  const depth = maxDepth ?? vscode.workspace.getConfiguration("native-runner").get<number>("projectSearchDepth", 2);

  // Strategy 1: Walk up from active file (no depth limit)
  if (activeFilePath) {
    let dir = path.dirname(activeFilePath);
    while (dir !== path.dirname(dir)) {
      if (matcher(dir)) { return dir; }
      dir = path.dirname(dir);
    }
  }

  // Strategy 2: Scan workspace folders up to configured depth
  for (const folder of workspaceFolders) {
    const result = scanDir(folder.uri.fsPath, matcher, depth, 0);
    if (result) { return result; }
  }
  return undefined;
}

function scanDir(dir: string, matcher: (dir: string) => boolean, maxDepth: number, currentDepth: number): string | undefined {
  if (matcher(dir)) { return dir; }
  if (currentDepth >= maxDepth) { return undefined; }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) { continue; }
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) { continue; }
      const result = scanDir(path.join(dir, entry.name), matcher, maxDepth, currentDepth + 1);
      if (result) { return result; }
    }
  } catch { /* ignore permission errors etc. */ }
  return undefined;
}

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
