import * as vscode from "vscode";
import { AndroidProvider } from "./androidProvider";
import { DeviceManager } from "./deviceManager";
import { BuildRunner } from "./buildRunner";
import { VariantManager } from "./variantManager";
import { PlatformProvider } from "./types";
import { FileExplorerService } from "./fileExplorerService";
import { DeviceFileExplorer } from "./fileExplorer";

let deviceManager: DeviceManager | undefined;
let buildRunner: BuildRunner | undefined;
let variantManager: VariantManager | undefined;

// Debug adapter instances, keyed by session name (e.g. "Android: Pixel 7")
const debugAdapters = new Map<string, NativeDebugAdapter>();

export function getDebugAdapter(sessionName?: string): NativeDebugAdapter | undefined {
  if (sessionName) { return debugAdapters.get(sessionName); }
  let last: NativeDebugAdapter | undefined;
  for (const adapter of debugAdapters.values()) { last = adapter; }
  return last;
}

export function removeDebugAdapter(sessionName: string): void {
  debugAdapters.delete(sessionName);
}

export function activate(context: vscode.ExtensionContext) {
  // Build platform providers list
  const providers: PlatformProvider[] = [];

  const androidProvider = new AndroidProvider();
  providers.push(androidProvider);

  // iOS provider — macOS only (loaded dynamically to avoid import errors on other platforms)
  if (process.platform === "darwin") {
    try {
      const { IosProvider } = require("./iosProvider");
      const iosProvider = new IosProvider();
      if (iosProvider.isAvailable()) {
        providers.push(iosProvider);
      }
    } catch {
      // iosProvider not available — skip
    }
  }

  deviceManager = new DeviceManager(providers);
  variantManager = new VariantManager(providers, deviceManager, context.workspaceState);
  buildRunner = new BuildRunner(providers, deviceManager, variantManager);
  variantManager.setOutputChannel(buildRunner.outputChannel);

  // File Explorer
  const fileExplorerService = new FileExplorerService(androidProvider);
  const fileExplorer = new DeviceFileExplorer(fileExplorerService, deviceManager);

  context.subscriptions.push(deviceManager);
  context.subscriptions.push(variantManager);
  context.subscriptions.push(buildRunner);
  context.subscriptions.push(fileExplorer);

  // Guard: cancel F5 if already running; assign unique ID to bypass confirmOnStart dialog
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider("native-runner", {
      resolveDebugConfiguration(_folder, config): vscode.DebugConfiguration | undefined {
        (config as any).__uniqueId = `session-${Math.random().toString(16).slice(2, 10)}`;
        // Allow if buildRunner is creating the session internally
        if (buildRunner?.isStartingDebugSession()) { return config; }
        if (buildRunner?.getIsBuildInProgress()) { return undefined; }
        const currentDevice = deviceManager?.getCurrentDevice();
        if (currentDevice && buildRunner?.hasSessionForDevice(currentDevice.id)) { return undefined; }
        return config;
      },
    })
  );

  // Register debug adapter factory
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory("native-runner", new NativeDebugAdapterFactory())
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("native-runner.selectDevice", () => { deviceManager?.showDevicePicker(); }),
    vscode.commands.registerCommand("native-runner.run", () => { buildRunner?.installAndRun(); }),
    vscode.commands.registerCommand("native-runner.installAndRun", () => { buildRunner?.installAndRun(); }),
    vscode.commands.registerCommand("native-runner.stop", () => { buildRunner?.stop(); }),
    vscode.commands.registerCommand("native-runner.restart", () => { buildRunner?.restart(); }),
    vscode.commands.registerCommand("native-runner.filterLog", () => { buildRunner?.setLogFilter(); }),
    vscode.commands.registerCommand("native-runner.selectVariant", () => { variantManager?.showVariantPicker(); }),
    // File Explorer commands
    vscode.commands.registerCommand("native-runner.fileExplorer.selectDevice", () => { fileExplorer.selectExplorerDevice(); }),
    vscode.commands.registerCommand("native-runner.fileExplorer.refresh", () => { fileExplorer.refresh(); }),
    vscode.commands.registerCommand("native-runner.fileExplorer.download", (item, items) => { fileExplorer.downloadFile(item, items); }),
    vscode.commands.registerCommand("native-runner.fileExplorer.upload", (item) => { fileExplorer.uploadFile(item); }),
    vscode.commands.registerCommand("native-runner.fileExplorer.delete", (item, items) => { fileExplorer.deleteItem(item, items); }),
    vscode.commands.registerCommand("native-runner.fileExplorer.copyPath", (item, items) => { fileExplorer.copyPath(item, items); }),
    vscode.commands.registerCommand("native-runner.fileExplorer.openInEditor", (item) => { fileExplorer.openInEditor(item); }),
    vscode.commands.registerCommand("native-runner.fileExplorer.newFolder", (item) => { fileExplorer.newFolder(item); }),
    vscode.commands.registerCommand("native-runner.fileExplorer.newFile", (item) => { fileExplorer.newFile(item); }),
    vscode.commands.registerCommand("native-runner.fileExplorer.rename", (item) => { fileExplorer.renameItem(item); }),
    vscode.commands.registerCommand("native-runner.fileExplorer.moveTo", (item, items) => { fileExplorer.moveToFolder(item, items); }),
    vscode.commands.registerCommand("native-runner.fileExplorer.copyTo", (item, items) => { fileExplorer.copyToFolder(item, items); }),
    vscode.commands.registerCommand("native-runner.fileExplorer.clearCache", () => { fileExplorer.clearCache(); }),
    vscode.commands.registerCommand("native-runner.fileExplorer.revealInExplorer", (item) => { fileExplorer.revealInExplorer(item); }),
  );

  // Internal: called from debug adapter launch handler (F5)
  context.subscriptions.push(
    vscode.commands.registerCommand("native-runner._launchFromDebug", () => {
      if (buildRunner?.getIsBuildInProgress()) { return; }
      const currentDevice = deviceManager?.getCurrentDevice();
      if (currentDevice && buildRunner?.hasSessionForDevice(currentDevice.id)) { return; }
      buildRunner?.installAndRun(true);
    })
  );

  // Debug session lifecycle
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      if (session.type === "native-runner") { buildRunner?.onDebugSessionStarted(session); }
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.type === "native-runner") { buildRunner?.onDebugSessionEnded(session); }
    }),
  );

  // Config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("native-runner.sdkPath")) {
        androidProvider.refreshSdkPath();
      }
    })
  );

  // Initial device refresh, then variant scan after devices are detected
  deviceManager.refreshDevices().then(() => {
    variantManager?.triggerScan(true);
  });
}

class NativeDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const adapter = new NativeDebugAdapter(session.name);
    debugAdapters.set(session.name, adapter);
    return new vscode.DebugAdapterInlineImplementation(adapter);
  }
}

export class NativeDebugAdapter implements vscode.DebugAdapter {
  private onDidSendMessageEmitter = new vscode.EventEmitter<any>();
  readonly onDidSendMessage = this.onDidSendMessageEmitter.event;
  private seq = 1;

  constructor(public readonly sessionName: string) {}

  handleMessage(message: any): void {
    if (message.type === "request") {
      switch (message.command) {
        case "initialize":
          this.sendResponse(message, { supportsTerminateRequest: true, supportsRestartRequest: true });
          this.onDidSendMessageEmitter.fire({ type: "event", event: "initialized", seq: this.seq++ });
          break;
        case "launch":
          this.sendResponse(message, {});
          vscode.commands.executeCommand("native-runner._launchFromDebug");
          break;
        case "restart":
          this.sendResponse(message, {});
          vscode.commands.executeCommand("native-runner.restart");
          break;
        case "terminate":
          this.sendResponse(message, {});
          this.sendTerminated();
          break;
        case "disconnect":
          this.sendResponse(message, {});
          break;
        case "threads":
          this.sendResponse(message, { threads: [{ id: 1, name: "main" }] });
          break;
        default:
          this.sendResponse(message, {});
          break;
      }
    }
  }

  public writeToConsole(text: string, category: "console" | "stdout" | "stderr" = "stdout"): void {
    this.onDidSendMessageEmitter.fire({
      type: "event", event: "output", seq: this.seq++,
      body: { category, output: text + "\n" },
    });
  }

  private sendResponse(request: any, body: any): void {
    this.onDidSendMessageEmitter.fire({
      type: "response", request_seq: request.seq, success: true,
      command: request.command, body, seq: this.seq++,
    });
  }

  public sendTerminated(): void {
    this.onDidSendMessageEmitter.fire({ type: "event", event: "terminated", seq: this.seq++ });
  }

  dispose(): void {
    debugAdapters.delete(this.sessionName);
    this.onDidSendMessageEmitter.dispose();
  }
}

export function deactivate() {
  debugAdapters.clear();
  deviceManager = undefined;
  buildRunner = undefined;
  variantManager = undefined;
}
