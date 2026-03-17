import * as vscode from "vscode";
import { DeviceProvider } from "./deviceProvider";
import { DeviceManager } from "./deviceManager";
import { BuildRunner } from "./buildRunner";
import { VariantManager } from "./variantManager";

let deviceManager: DeviceManager | undefined;
let buildRunner: BuildRunner | undefined;
let variantManager: VariantManager | undefined;

// Debug adapter instances, keyed by session name (e.g. "Android: Pixel 7")
const debugAdapters = new Map<string, AndroidDebugAdapter>();

export function getDebugAdapter(sessionName?: string): AndroidDebugAdapter | undefined {
  if (sessionName) {
    return debugAdapters.get(sessionName);
  }
  // Fallback: return the most recently added adapter
  let last: AndroidDebugAdapter | undefined;
  for (const adapter of debugAdapters.values()) {
    last = adapter;
  }
  return last;
}

export function removeDebugAdapter(sessionName: string): void {
  debugAdapters.delete(sessionName);
}

export function activate(context: vscode.ExtensionContext) {
  const deviceProvider = new DeviceProvider();
  deviceManager = new DeviceManager(deviceProvider);
  variantManager = new VariantManager();
  buildRunner = new BuildRunner(deviceProvider, deviceManager, variantManager);
  variantManager.setOutputChannel(buildRunner.outputChannel);

  context.subscriptions.push(deviceManager);
  context.subscriptions.push(variantManager);
  context.subscriptions.push(buildRunner);

  // Guard: cancel F5 if already running; assign unique ID to bypass confirmOnStart dialog
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider("native-runner", {
      resolveDebugConfiguration(
        _folder,
        config
      ): vscode.DebugConfiguration | undefined {
        // Unique ID per launch — prevents VSCode's "already running" dialog
        (config as any).__uniqueId = `session-${Math.random().toString(16).slice(2, 10)}`;

        // Guard: silently cancel if already running or building
        if (buildRunner?.getIsBuildInProgress()) {
          return undefined;
        }
        const currentDevice = deviceManager?.getCurrentDevice();
        if (currentDevice && buildRunner?.hasSessionForDevice(currentDevice.id)) {
          return undefined;
        }
        return config;
      },
    })
  );

  // Register debug adapter for floating toolbar + debug console
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(
      "native-runner",
      new AndroidDebugAdapterFactory()
    )
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("native-runner.selectDevice", () => {
      deviceManager?.showDevicePicker();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("native-runner.run", () => {
      buildRunner?.installAndRun();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("native-runner.installAndRun", () => {
      buildRunner?.installAndRun();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("native-runner.stop", () => {
      buildRunner?.stop();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("native-runner.restart", () => {
      buildRunner?.restart();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("native-runner.filterLog", () => {
      buildRunner?.setLogFilter();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("native-runner.selectVariant", () => {
      variantManager?.showVariantPicker();
    })
  );

  // Internal: called from debug adapter launch handler (F5)
  // Skip if build in progress or selected device already has a session
  context.subscriptions.push(
    vscode.commands.registerCommand("native-runner._launchFromDebug", () => {
      if (buildRunner?.getIsBuildInProgress()) {
        return;
      }
      const currentDevice = deviceManager?.getCurrentDevice();
      if (currentDevice && buildRunner?.hasSessionForDevice(currentDevice.id)) {
        return;
      }
      buildRunner?.installAndRun(true);
    })
  );

  // Capture debug session when it starts
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      if (session.type === "native-runner") {
        buildRunner?.onDebugSessionStarted(session);
      }
    })
  );

  // When debug session ends (floating toolbar stop button pressed)
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.type === "native-runner") {
        buildRunner?.onDebugSessionEnded(session);
      }
    })
  );

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("native-runner.sdkPath")) {
        deviceProvider.refreshSdkPath();
      }
    })
  );

  // Initial device refresh
  deviceManager.refreshDevices();

  // Scan build variants in background (silent, no notification)
  variantManager.triggerScan(true);
}

class AndroidDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(
    session: vscode.DebugSession
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const adapter = new AndroidDebugAdapter(session.name);
    debugAdapters.set(session.name, adapter);
    return new vscode.DebugAdapterInlineImplementation(adapter);
  }
}

export class AndroidDebugAdapter implements vscode.DebugAdapter {
  private onDidSendMessageEmitter = new vscode.EventEmitter<any>();
  readonly onDidSendMessage = this.onDidSendMessageEmitter.event;
  private seq = 1;

  constructor(public readonly sessionName: string) {}

  handleMessage(message: any): void {
    if (message.type === "request") {
      switch (message.command) {
        case "initialize":
          this.sendResponse(message, {
            supportsTerminateRequest: true,
            supportsRestartRequest: true,
          });
          this.onDidSendMessageEmitter.fire({
            type: "event",
            event: "initialized",
            seq: this.seq++,
          });
          break;
        case "launch":
          this.sendResponse(message, {});
          // Trigger build (skipDebugSession=true since session already exists)
          vscode.commands.executeCommand("native-runner._launchFromDebug");
          break;
        case "restart":
          this.sendResponse(message, {});
          vscode.commands.executeCommand("native-runner.restart");
          break;
        case "terminate":
          this.sendResponse(message, {});
          // Signal VSCode that we're done
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

  /**
   * Write a line to the Debug Console via DAP output event
   */
  public writeToConsole(text: string, category: "console" | "stdout" | "stderr" = "stdout"): void {
    this.onDidSendMessageEmitter.fire({
      type: "event",
      event: "output",
      seq: this.seq++,
      body: {
        category,
        output: text + "\n",
      },
    });
  }

  private sendResponse(request: any, body: any): void {
    this.onDidSendMessageEmitter.fire({
      type: "response",
      request_seq: request.seq,
      success: true,
      command: request.command,
      body,
      seq: this.seq++,
    });
  }

  /**
   * Send DAP terminated event to end the debug session
   */
  public sendTerminated(): void {
    this.onDidSendMessageEmitter.fire({
      type: "event",
      event: "terminated",
      seq: this.seq++,
    });
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
