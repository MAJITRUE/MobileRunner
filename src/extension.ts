import * as vscode from "vscode";
import { DeviceProvider } from "./deviceProvider";
import { DeviceManager } from "./deviceManager";
import { BuildRunner } from "./buildRunner";

let deviceManager: DeviceManager | undefined;
let buildRunner: BuildRunner | undefined;

// Current debug adapter instance, accessible from BuildRunner
let currentDebugAdapter: AndroidDebugAdapter | undefined;

export function getDebugAdapter(): AndroidDebugAdapter | undefined {
  return currentDebugAdapter;
}

export function activate(context: vscode.ExtensionContext) {
  const deviceProvider = new DeviceProvider();
  deviceManager = new DeviceManager(deviceProvider);
  buildRunner = new BuildRunner(deviceProvider, deviceManager);

  context.subscriptions.push(deviceManager);
  context.subscriptions.push(buildRunner);

  // Register debug adapter for floating toolbar + debug console
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(
      "mobile-runner",
      new AndroidDebugAdapterFactory()
    )
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("mobile-runner.selectDevice", () => {
      deviceManager?.showDevicePicker();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mobile-runner.run", () => {
      buildRunner?.installAndRun();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mobile-runner.installAndRun", () => {
      buildRunner?.installAndRun();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mobile-runner.stop", () => {
      buildRunner?.stop();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mobile-runner.restart", () => {
      buildRunner?.restart();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mobile-runner.filterLog", () => {
      buildRunner?.setLogFilter();
    })
  );

  // Capture debug session when it starts
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      if (session.type === "mobile-runner") {
        buildRunner?.onDebugSessionStarted(session);
      }
    })
  );

  // When debug session ends (floating toolbar stop button pressed)
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.type === "mobile-runner") {
        buildRunner?.onDebugSessionEnded(session);
      }
    })
  );

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("mobile-runner.sdkPath")) {
        deviceProvider.refreshSdkPath();
      }
    })
  );

  // Initial device refresh
  deviceManager.refreshDevices();
}

class AndroidDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(
    _session: vscode.DebugSession
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const adapter = new AndroidDebugAdapter();
    currentDebugAdapter = adapter;
    return new vscode.DebugAdapterInlineImplementation(adapter);
  }
}

export class AndroidDebugAdapter implements vscode.DebugAdapter {
  private onDidSendMessageEmitter = new vscode.EventEmitter<any>();
  readonly onDidSendMessage = this.onDidSendMessageEmitter.event;
  private seq = 1;

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
          break;
        case "restart":
          this.sendResponse(message, {});
          vscode.commands.executeCommand("mobile-runner.restart");
          break;
        case "disconnect":
        case "terminate":
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
    currentDebugAdapter = undefined;
    this.onDidSendMessageEmitter.dispose();
  }
}

export function deactivate() {
  deviceManager = undefined;
  buildRunner = undefined;
}
