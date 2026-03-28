import * as vscode from "vscode";
import * as cp from "child_process";
import { DeviceManager } from "./deviceManager";
import { VariantManager } from "./variantManager";
import { DeviceSession, PlatformProvider } from "./types";
import { getDebugAdapter, removeDebugAdapter } from "./extension";

export class BuildRunner implements vscode.Disposable {
  public readonly outputChannel: vscode.LogOutputChannel;
  private buildProcess: cp.ChildProcess | undefined;
  private sessions = new Map<string, DeviceSession>();
  private runStatusBarItem: vscode.StatusBarItem;
  private buildingStatusBarItem: vscode.StatusBarItem;
  private stopStatusBarItem: vscode.StatusBarItem;
  private isBuildInProgress = false;
  private logFilter: string | undefined;
  private disposables: vscode.Disposable[] = [];
  private buildCancelled = false;

  constructor(
    private providers: PlatformProvider[],
    private deviceManager: DeviceManager,
    private variantManager: VariantManager
  ) {
    this.outputChannel = vscode.window.createOutputChannel("Native Runner", { log: true });
    this.disposables.push(this.outputChannel);

    // Run button
    this.runStatusBarItem = vscode.window.createStatusBarItem("androidRunnerRun", vscode.StatusBarAlignment.Right, 99);
    this.runStatusBarItem.name = "Run";
    this.runStatusBarItem.text = `$(play) ${vscode.l10n.t("Run")}`;
    this.runStatusBarItem.tooltip = vscode.l10n.t("Build and run app");
    this.runStatusBarItem.command = "native-runner.installAndRun";
    this.runStatusBarItem.show();
    this.disposables.push(this.runStatusBarItem);

    // Building indicator
    this.buildingStatusBarItem = vscode.window.createStatusBarItem("androidRunnerBuilding", vscode.StatusBarAlignment.Right, 99);
    this.buildingStatusBarItem.name = "Building";
    this.buildingStatusBarItem.text = `$(loading~spin) ${vscode.l10n.t("Building...")}`;
    this.disposables.push(this.buildingStatusBarItem);

    // Stop button
    this.stopStatusBarItem = vscode.window.createStatusBarItem("androidRunnerStop", vscode.StatusBarAlignment.Right, 98);
    this.stopStatusBarItem.name = "Stop";
    this.stopStatusBarItem.text = `$(debug-stop) ${vscode.l10n.t("Stop")}`;
    this.stopStatusBarItem.tooltip = vscode.l10n.t("Stop running app");
    this.stopStatusBarItem.command = "native-runner.stop";
    this.disposables.push(this.stopStatusBarItem);

    this.disposables.push(this.deviceManager.onDeviceChanged(() => this.updateStatusBar()));
    this.disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("native-runner.showBuildControls")) { this.updateStatusBar(); }
    }));
  }

  private getProviderForDevice(device: { platform: string }): PlatformProvider | undefined {
    return this.providers.find((p) => p.platform === device.platform);
  }

  /**
   * Build, install, and run the app
   */
  public async installAndRun(skipDebugSession = false): Promise<void> {
    if (this.isBuildInProgress) {
      vscode.window.showWarningMessage(vscode.l10n.t("Build is already in progress."));
      return;
    }

    const currentDev = this.deviceManager.getCurrentDevice();
    if (skipDebugSession && currentDev && this.sessions.has(currentDev.id)) {
      return;
    }

    let device = this.deviceManager.getCurrentDevice();
    if (!device || !device.isOnline) {
      const selected = await this.deviceManager.showDevicePicker();
      if (!selected) { return; }
      device = this.deviceManager.getCurrentDevice();
    }

    if (!device || !device.isOnline) {
      vscode.window.showErrorMessage(vscode.l10n.t("No online device selected."));
      return;
    }

    const provider = this.getProviderForDevice(device);
    if (!provider) {
      vscode.window.showErrorMessage(vscode.l10n.t("No provider for platform: {0}", device.platform));
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage(vscode.l10n.t("No workspace folder open."));
      return;
    }

    const activeFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    const projectRoot = provider.findProjectRoot(workspaceFolders, activeFilePath);
    if (!projectRoot) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("No {0} project found in workspace.", device.platform === "ios" ? "Xcode" : "Android")
      );
      return;
    }

    // Tear down existing session on this device
    await this.stopDevice(device.id);

    const variant = this.variantManager.getSelectedVariant();

    this.outputChannel.clear();
    this.buildCancelled = false;
    this.isBuildInProgress = true;
    this.updateStatusBar();

    // Auto-show output channel after 30 seconds (long build)
    const autoShowTimer = setTimeout(() => this.outputChannel.show(true), 30000);

    try {
      // Step 1: Build
      this.outputChannel.info(vscode.l10n.t("▶ Building {0}...", variant));
      this.outputChannel.info(vscode.l10n.t("  Project: {0}", projectRoot));
      this.outputChannel.info(vscode.l10n.t("  Device: {0} ({1})", device.name, device.id));

      const artifactPath = await provider.buildProject(projectRoot, device, variant, this.outputChannel);
      this.outputChannel.info(vscode.l10n.t("✓ Artifact: {0}", artifactPath));

      // Step 2: Install
      this.outputChannel.info(vscode.l10n.t("▶ Installing on {0}...", device.name));
      await provider.installApp(device.id, artifactPath);
      this.outputChannel.info(vscode.l10n.t("✓ Installed"));

      // Step 3: Launch
      const pkgInfo = await provider.getPackageInfo(projectRoot, variant, artifactPath);
      this.outputChannel.info(vscode.l10n.t("▶ Launching {0}...", pkgInfo.packageName));
      await provider.launchApp(device.id, pkgInfo.packageName, pkgInfo.launchTarget);
      this.outputChannel.info(vscode.l10n.t("✓ Launched"));
      clearTimeout(autoShowTimer);

      // Step 4: Start log in per-device Output Channel
      const logChannelName = device.platform === "ios"
        ? `Console: ${device.name}`
        : `Logcat: ${device.name}`;
      const deviceOutputChannel = vscode.window.createOutputChannel(logChannelName);
      deviceOutputChannel.show(true);

      // Wait for app process to start
      let pid: string | undefined;
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        pid = await provider.getAppPid(device.id, pkgInfo.packageName);
        if (pid) { break; }
      }
      if (pid) {
        deviceOutputChannel.appendLine(vscode.l10n.t("(filtered by PID {0})", pid));
      } else {
        deviceOutputChannel.appendLine(vscode.l10n.t("Could not get app PID, showing all logs"));
      }

      const platformLabel = device.platform === "ios" ? "iOS" : "Android";
      const debugSessionName = `${platformLabel}: ${device.name}`;
      const logProcess = provider.startLog(device.id, pid, (text, category) => {
        deviceOutputChannel.appendLine(text);
        const adapter = getDebugAdapter(debugSessionName);
        if (adapter) { adapter.writeToConsole(text, category); }
      });

      // Register session
      this.sessions.set(device.id, {
        deviceId: device.id,
        deviceName: device.name,
        platform: device.platform,
        packageName: pkgInfo.packageName,
        logProcess,
        outputChannel: deviceOutputChannel,
      });

      this.isBuildInProgress = false;
      this.updateStatusBar();

      if (!skipDebugSession) {
        await this.startDebugSession(device.name, device.platform);
      }
    } catch (error) {
      clearTimeout(autoShowTimer);
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === "cancelled" || this.buildCancelled) {
        this.buildCancelled = false;
        this.outputChannel.info(vscode.l10n.t("■ Build cancelled"));
        this.isBuildInProgress = false;
        this.updateStatusBar();
        return;
      }
      this.outputChannel.error(`✗ ${msg}`);
      this.outputChannel.show(true);
      vscode.window.showErrorMessage(`Native Runner: ${msg}`);
      this.isBuildInProgress = false;
      this.updateStatusBar();
    }
  }

  /**
   * Set or clear the log text filter
   */
  public async setLogFilter(): Promise<void> {
    const current = this.logFilter || "";
    const input = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("Filter log output (leave empty to clear filter)"),
      value: current,
      placeHolder: vscode.l10n.t("e.g. MainActivity, Error, warning"),
    });
    if (input === undefined) { return; }
    this.logFilter = input || undefined;
    if (this.logFilter) {
      this.outputChannel.appendLine(`\n--- ${vscode.l10n.t('Filter set: "{0}"', this.logFilter)} ---`);
    } else {
      this.outputChannel.appendLine(`\n--- ${vscode.l10n.t("Filter cleared")} ---`);
    }
  }

  // --- Public state queries ---

  public getIsBuildInProgress(): boolean {
    return this.isBuildInProgress;
  }

  public hasSessionForDevice(deviceId: string): boolean {
    return this.sessions.has(deviceId);
  }

  // --- Debug session lifecycle ---

  public onDebugSessionStarted(session: vscode.DebugSession): void {
    for (const [, deviceSession] of this.sessions) {
      const platformLabel = deviceSession.platform === "ios" ? "iOS" : "Android";
      if (session.name === `${platformLabel}: ${deviceSession.deviceName}`) {
        deviceSession.debugSession = session;
        break;
      }
    }
  }

  private async startDebugSession(deviceName: string, platform: string): Promise<void> {
    const platformLabel = platform === "ios" ? "iOS" : "Android";
    await vscode.debug.startDebugging(undefined, {
      type: "native-runner",
      name: `${platformLabel}: ${deviceName}`,
      request: "launch",
    });
  }

  public async restart(): Promise<void> {
    const device = this.deviceManager.getCurrentDevice();
    if (device) { await this.stopDevice(device.id); }
    this.killBuild();
    await this.installAndRun(true);
  }

  public onDebugSessionEnded(session: vscode.DebugSession): void {
    for (const [deviceId, deviceSession] of this.sessions) {
      if (deviceSession.debugSession === session) {
        deviceSession.debugSession = undefined;
        removeDebugAdapter(session.name);
        this.stopDevice(deviceId);
        return;
      }
    }
  }

  // --- Stop ---

  public async stop(): Promise<void> {
    if (this.isBuildInProgress) {
      this.killBuild();
      return;
    }
    if (this.sessions.size === 0) { return; }
    const currentDevice = this.deviceManager.getCurrentDevice();
    if (currentDevice && this.sessions.has(currentDevice.id)) {
      await this.stopDevice(currentDevice.id);
    }
  }

  private async stopDevice(deviceId: string): Promise<void> {
    const session = this.sessions.get(deviceId);
    if (!session) { return; }

    // Remove first to prevent circular calls
    this.sessions.delete(deviceId);

    const provider = this.providers.find((p) => p.platform === session.platform);
    if (provider) {
      try { await provider.stopApp(deviceId, session.packageName); } catch { /* ignore */ }
    }

    session.logProcess.kill();
    session.outputChannel.appendLine(vscode.l10n.t("■ App stopped"));
    session.outputChannel.dispose();

    if (session.debugSession) {
      const platformLabel = session.platform === "ios" ? "iOS" : "Android";
      const debugSessionName = `${platformLabel}: ${session.deviceName}`;
      const adapter = getDebugAdapter(debugSessionName);
      if (adapter) { adapter.sendTerminated(); }
      try { await vscode.debug.stopDebugging(session.debugSession); } catch { /* ignore */ }
      removeDebugAdapter(debugSessionName);
    }

    this.outputChannel.info(vscode.l10n.t("■ Stopped on {0}", session.deviceName));
    this.updateStatusBar();
  }

  private async stopAll(): Promise<void> {
    this.stopStatusBarItem.hide();
    this.buildingStatusBarItem.text = `$(loading~spin) ${vscode.l10n.t("Stopping...")}`;
    this.buildingStatusBarItem.command = undefined;
    this.buildingStatusBarItem.show();

    for (const deviceId of [...this.sessions.keys()]) {
      await this.stopDevice(deviceId);
    }
    this.killBuild();

    this.buildingStatusBarItem.text = `$(loading~spin) ${vscode.l10n.t("Building...")}`;
    this.isBuildInProgress = false;
    this.updateStatusBar();
  }

  private killBuild(): void {
    if (this.buildProcess) {
      this.buildCancelled = true;
      this.buildProcess.kill();
      this.buildProcess = undefined;
    }
  }

  private updateStatusBar(): void {
    const enabled = vscode.workspace.getConfiguration("native-runner").get<boolean>("showBuildControls", true);
    const currentDevice = this.deviceManager.getCurrentDevice();
    const hasOnlineDevice = currentDevice !== undefined && currentDevice.isOnline;

    if (!enabled || !hasOnlineDevice) {
      this.runStatusBarItem.hide();
      this.buildingStatusBarItem.hide();
      this.stopStatusBarItem.hide();
      return;
    }
    if (this.isBuildInProgress) {
      this.runStatusBarItem.hide();
      this.buildingStatusBarItem.text = `$(loading~spin) ${vscode.l10n.t("Building...")}`;
      this.buildingStatusBarItem.command = undefined;
      this.buildingStatusBarItem.show();
      this.stopStatusBarItem.show();
    } else {
      const currentDeviceRunning = this.sessions.has(currentDevice.id);
      if (currentDeviceRunning) {
        this.runStatusBarItem.hide();
        this.stopStatusBarItem.show();
      } else {
        this.runStatusBarItem.show();
        this.stopStatusBarItem.hide();
      }
      this.buildingStatusBarItem.hide();
    }
  }

  dispose(): void {
    this.killBuild();
    for (const [, session] of this.sessions) {
      session.logProcess.kill();
      session.outputChannel.dispose();
    }
    this.sessions.clear();
    for (const d of this.disposables) { d.dispose(); }
  }
}
