import * as vscode from "vscode";
import { Device, Emulator, PlatformProvider } from "./types";

interface DevicePickItem extends vscode.QuickPickItem {
  device?: Device;
  emulator?: Emulator;
  coldBoot?: boolean;
  action?: "refresh";
}

export class DeviceManager implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private currentDevice: Device | undefined;
  private devices: Device[] = [];
  private pollTimer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];

  private readonly onDeviceChangedEmitter = new vscode.EventEmitter<Device | undefined>();
  public readonly onDeviceChanged = this.onDeviceChangedEmitter.event;

  constructor(private providers: PlatformProvider[]) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      "androidRunnerDevice",
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.name = "Device";
    this.statusBarItem.command = "native-runner.selectDevice";
    this.statusBarItem.tooltip = vscode.l10n.t("Select Device");
    this.disposables.push(this.statusBarItem);

    this.updateStatusBar();
    if (vscode.workspace.getConfiguration("native-runner").get<boolean>("showDeviceSelector", true)) {
      this.statusBarItem.show();
    }

    this.disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("native-runner.showDeviceSelector")) {
        const show = vscode.workspace.getConfiguration("native-runner").get<boolean>("showDeviceSelector", true);
        if (show) { this.statusBarItem.show(); } else { this.statusBarItem.hide(); }
      }
      if (e.affectsConfiguration("native-runner.showDeviceSelector")
        || e.affectsConfiguration("native-runner.showDeviceExplorer")
        || e.affectsConfiguration("native-runner.showBuildControls")) {
        if (this.needsPolling()) { this.startPolling(); } else { this.stopPolling(); }
      }
    }));

    if (this.needsPolling()) { this.startPolling(); }
  }

  public getCurrentDevice(): Device | undefined {
    return this.currentDevice;
  }

  public getDevices(): Device[] {
    return this.devices;
  }

  public getProviderForDevice(device: Device): PlatformProvider | undefined {
    return this.providers.find((p) => p.platform === device.platform);
  }

  /**
   * Show the device picker QuickPick UI
   */
  public async showDevicePicker(): Promise<Device | undefined> {
    const quickPick = vscode.window.createQuickPick<DevicePickItem>();
    quickPick.placeholder = vscode.l10n.t("Select a device to use");
    quickPick.busy = true;
    quickPick.ignoreFocusOut = true;
    quickPick.show();

    await this.refreshDevices();
    const items = await this.buildPickerItems();
    quickPick.items = items;
    quickPick.busy = false;

    const selection = await new Promise<DevicePickItem | undefined>((resolve) => {
      quickPick.onDidAccept(() => {
        resolve(quickPick.selectedItems[0]);
        quickPick.hide();
      });
      quickPick.onDidHide(() => resolve(undefined));
    });

    quickPick.dispose();

    if (!selection) { return undefined; }

    if (selection.emulator) {
      return this.launchAndWaitForEmulator(selection.emulator, selection.coldBoot);
    }

    if (selection.device) {
      this.selectDevice(selection.device);
      return selection.device;
    }

    return undefined;
  }

  private async buildPickerItems(): Promise<DevicePickItem[]> {
    const items: DevicePickItem[] = [];

    // Collect emulators from all providers
    const allEmulators: Emulator[] = [];
    for (const provider of this.providers) {
      const emus = await provider.getAvailableEmulators();
      allEmulators.push(...emus);
    }

    // Connected devices — split into Current Device + Available Devices
    const onlineDevices = this.devices.filter((d) => d.isOnline);
    const currentId = this.currentDevice?.id;

    if (onlineDevices.length > 0) {
      const currentOnline = onlineDevices.find((d) => d.id === currentId);
      const otherOnline = onlineDevices.filter((d) => d.id !== currentId);

      // "Available Devices" separator
      items.push({
        label: vscode.l10n.t("Available Devices"),
        kind: vscode.QuickPickItemKind.Separator,
      });

      // Current Device first
      if (currentOnline) {
        const icon = this.deviceIcon(currentOnline);
        items.push({
          label: `${icon} ${currentOnline.name}`,
          description: `${currentOnline.id} — ${this.deviceTypeLabel(currentOnline)}`,
          detail: vscode.l10n.t("Current Device"),
          device: currentOnline,
        });
      }

      // Other online devices
      for (const device of otherOnline) {
        const icon = this.deviceIcon(device);
        items.push({
          label: `${icon} ${device.name}`,
          description: `${device.id} — ${this.deviceTypeLabel(device)}`,
          device,
        });
      }
    }

    // Offline emulators/simulators (not currently running)
    const runningEmulatorNames = new Set(
      onlineDevices
        .filter((d) => d.type === "emulator")
        .map((d) => d.platform === "ios" ? d.id : d.name.replace(/ /g, "_"))
    );
    const offlineEmulators = allEmulators.filter((e) => !runningEmulatorNames.has(e.id));

    if (offlineEmulators.length > 0) {
      items.push({
        label: vscode.l10n.t("Offline Emulators"),
        kind: vscode.QuickPickItemKind.Separator,
      });
      for (const emu of offlineEmulators) {
        const platformLabel = emu.runtime ? ` (${emu.runtime})` : "";
        items.push({
          label: `$(play) ${vscode.l10n.t("Start {0}", emu.name)}${platformLabel}`,
          description: emu.platform,
          emulator: emu,
        });
      }
    }

    // Offline/unauthorized devices
    const offlineDevices = this.devices.filter((d) => !d.isOnline);
    if (offlineDevices.length > 0) {
      items.push({
        label: vscode.l10n.t("Offline / Unauthorized"),
        kind: vscode.QuickPickItemKind.Separator,
      });
      for (const device of offlineDevices) {
        items.push({
          label: `$(warning) ${device.name}`,
          description: `${device.id} — ${device.state}`,
          device,
        });
      }
    }

    // No devices at all
    if (items.length === 0) {
      items.push({
        label: vscode.l10n.t("$(info) No devices found"),
        description: vscode.l10n.t("Connect a device or start an emulator/simulator"),
      });
    }

    // Cold boot section (Android emulators only)
    const androidEmulators = allEmulators.filter((e) => e.platform === "android");
    const coldBootTargets: { name: string; emulator: Emulator }[] = [];
    for (const device of onlineDevices.filter((d) => d.type === "emulator" && d.platform === "android")) {
      const avd = androidEmulators.find((e) => e.name === device.name.replace(/ /g, "_"));
      if (avd) { coldBootTargets.push({ name: device.name, emulator: avd }); }
    }
    for (const emu of offlineEmulators.filter((e) => e.platform === "android")) {
      coldBootTargets.push({ name: emu.name, emulator: emu });
    }
    if (coldBootTargets.length > 0) {
      items.push({
        label: vscode.l10n.t("Cold Boot"),
        kind: vscode.QuickPickItemKind.Separator,
      });
      for (const target of coldBootTargets) {
        items.push({
          label: `$(zap) ${target.name}`,
          emulator: target.emulator,
          coldBoot: true,
        });
      }
    }

    return items;
  }

  private deviceIcon(device: Device): string {
    if (device.platform === "ios") {
      return device.type === "emulator" ? "$(device-mobile)" : "$(plug)";
    }
    return device.type === "emulator" ? "$(device-mobile)" : "$(plug)";
  }

  private deviceTypeLabel(device: Device): string {
    if (device.platform === "ios") {
      return device.type === "emulator" ? "ios simulator" : "ios device";
    }
    return device.type === "emulator" ? "android" : "android device";
  }

  private async launchAndWaitForEmulator(emulator: Emulator, coldBoot = false): Promise<Device | undefined> {
    const provider = this.providers.find((p) => p.platform === emulator.platform);
    if (!provider) { return undefined; }

    const maxWaitSeconds = 120;
    let cancelled = false;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: coldBoot
          ? vscode.l10n.t("Cold booting emulator: {0}...", emulator.name)
          : vscode.l10n.t("Launching emulator: {0}...", emulator.name),
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => { cancelled = true; });

        // If cold booting a running emulator, kill it first
        if (coldBoot) {
          const runningDevice = this.devices.find(
            (d) => d.type === "emulator" && d.isOnline && d.platform === emulator.platform &&
              (d.platform === "ios" ? d.id === emulator.id : d.name.replace(/ /g, "_") === emulator.id)
          );
          if (runningDevice) {
            await provider.killEmulator(runningDevice.id);
            for (let i = 0; i < 15; i++) {
              if (cancelled) { return; }
              await this.sleep(1000);
              await this.refreshDevices();
              const stillRunning = this.devices.find((d) => d.id === runningDevice.id && d.isOnline);
              if (!stillRunning) { break; }
            }
          }
        }

        await provider.launchEmulator(emulator.id, coldBoot);

        for (let i = 0; i < maxWaitSeconds; i++) {
          if (cancelled) { return; }
          await this.sleep(2000);
          await this.refreshDevices();
          const newDevice = this.devices.find(
            (d) => d.type === "emulator" && d.isOnline && d.platform === emulator.platform
          );
          if (newDevice) {
            this.selectDevice(newDevice);
            return;
          }
          progress.report({
            message: vscode.l10n.t("{0}s — {1} device(s) found", (i + 1) * 2, this.devices.length),
          });
        }

        vscode.window.showWarningMessage(
          vscode.l10n.t("Emulator {0} launched but not yet connected. Select it manually when ready.", emulator.name)
        );
      }
    );

    return this.currentDevice;
  }

  public selectDevice(device: Device): void {
    this.currentDevice = device;
    this.updateStatusBar();
    this.onDeviceChangedEmitter.fire(device);
  }

  public async refreshDevices(): Promise<void> {
    const allDevices: Device[] = [];
    for (const provider of this.providers) {
      const devices = await provider.getConnectedDevices();
      allDevices.push(...devices);
    }
    this.devices = allDevices;

    // Auto-deselect only if current device is completely gone from list
    if (this.currentDevice) {
      const stillExists = this.devices.find((d) => d.id === this.currentDevice!.id);
      if (!stillExists) {
        this.currentDevice = undefined;
      } else {
        // Update device state (online/offline) but keep selection
        this.currentDevice = stillExists;
      }
    }

    // Auto-select first online device if none selected
    const config = vscode.workspace.getConfiguration("native-runner");
    if (!this.currentDevice && config.get<boolean>("autoSelectDevice", true)) {
      const firstOnline = this.devices.find((d) => d.isOnline);
      if (firstOnline) {
        this.currentDevice = firstOnline;
        this.onDeviceChangedEmitter.fire(firstOnline);
      }
    }

    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    if (this.currentDevice) {
      const icon = this.deviceIcon(this.currentDevice);
      this.statusBarItem.text = `${icon} ${this.currentDevice.name}`;
      this.statusBarItem.backgroundColor = undefined;
    } else {
      this.statusBarItem.text = `$(device-mobile) ${vscode.l10n.t("No Device")}`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }
  }

  private startPolling(): void {
    if (this.pollTimer) { return; }
    this.pollTimer = setInterval(async () => {
      const oldDeviceCount = this.devices.length;
      const oldDeviceId = this.currentDevice?.id;
      await this.refreshDevices();
      if (this.devices.length !== oldDeviceCount || this.currentDevice?.id !== oldDeviceId) {
        this.updateStatusBar();
      }
    }, 4000);
  }

  private stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
  }

  private needsPolling(): boolean {
    const config = vscode.workspace.getConfiguration("native-runner");
    return config.get<boolean>("showDeviceSelector", true)
      || config.get<boolean>("showDeviceExplorer", true)
      || config.get<boolean>("showBuildControls", true);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  dispose(): void {
    this.stopPolling();
    this.onDeviceChangedEmitter.dispose();
    for (const d of this.disposables) { d.dispose(); }
  }
}
