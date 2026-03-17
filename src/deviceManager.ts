import * as vscode from "vscode";
import { AndroidDevice, AvdEmulator, DeviceProvider } from "./deviceProvider";

interface DevicePickItem extends vscode.QuickPickItem {
  device?: AndroidDevice;
  emulator?: AvdEmulator;
  coldBoot?: boolean;
  action?: "refresh";
}

export class DeviceManager implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private currentDevice: AndroidDevice | undefined;
  private devices: AndroidDevice[] = [];
  private pollTimer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];

  private readonly onDeviceChangedEmitter = new vscode.EventEmitter<AndroidDevice | undefined>();
  public readonly onDeviceChanged = this.onDeviceChangedEmitter.event;

  constructor(private deviceProvider: DeviceProvider) {
    // Create status bar item (right side, like Flutter)
    this.statusBarItem = vscode.window.createStatusBarItem(
      "androidRunnerDevice",
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.name = "Android Device";
    this.statusBarItem.command = "native-runner.selectDevice";
    this.statusBarItem.tooltip = vscode.l10n.t("Select Android Device");
    this.disposables.push(this.statusBarItem);

    this.updateStatusBar();
    this.statusBarItem.show();

    // Start polling for device changes
    this.startPolling();
  }

  public getCurrentDevice(): AndroidDevice | undefined {
    return this.currentDevice;
  }

  public getDevices(): AndroidDevice[] {
    return this.devices;
  }

  /**
   * Show the device picker QuickPick UI
   */
  public async showDevicePicker(): Promise<AndroidDevice | undefined> {
    const quickPick = vscode.window.createQuickPick<DevicePickItem>();
    quickPick.placeholder = vscode.l10n.t("Select an Android device or emulator");
    quickPick.busy = true;
    quickPick.ignoreFocusOut = true;
    quickPick.show();

    await this.refreshDevices();
    const items = await this.buildPickerItems();
    quickPick.items = items;
    quickPick.busy = false;

    const selection = await new Promise<DevicePickItem | undefined>((resolve) => {
      quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems[0];
        resolve(selected);
        quickPick.hide();
      });
      quickPick.onDidHide(() => resolve(undefined));
    });

    quickPick.dispose();

    if (!selection) {
      return undefined;
    }

    // Handle emulator launch
    if (selection.emulator) {
      return this.launchAndWaitForEmulator(selection.emulator, selection.coldBoot);
    }

    // Handle device selection
    if (selection.device) {
      this.selectDevice(selection.device);
      return selection.device;
    }

    return undefined;
  }

  private async buildPickerItems(): Promise<DevicePickItem[]> {
    const items: DevicePickItem[] = [];
    const emulators = await this.deviceProvider.getAvailableEmulators();

    // Connected devices — split into Current Device + Available Devices
    const onlineDevices = this.devices.filter((d) => d.isOnline);
    const currentId = this.currentDevice?.id;

    if (onlineDevices.length > 0) {
      const currentOnline = onlineDevices.find((d) => d.id === currentId);
      const otherOnline = onlineDevices.filter((d) => d.id !== currentId);

      // "Available Devices" separator (shown at right edge, like Flutter)
      items.push({
        label: vscode.l10n.t("Available Devices"),
        kind: vscode.QuickPickItemKind.Separator,
      });

      // Current Device first
      if (currentOnline) {
        const icon = currentOnline.type === "emulator" ? "$(device-mobile)" : "$(plug)";
        const typeLabel = currentOnline.type === "emulator" ? "mobile" : "physical";
        items.push({
          label: `${icon} ${currentOnline.name}`,
          description: `${currentOnline.id} — ${typeLabel}`,
          detail: vscode.l10n.t("Current Device"),
          device: currentOnline,
        });
      }

      // Other online devices
      for (const device of otherOnline) {
        const icon = device.type === "emulator" ? "$(device-mobile)" : "$(plug)";
        const typeLabel = device.type === "emulator" ? "mobile" : "physical";
        items.push({
          label: `${icon} ${device.name}`,
          description: `${device.id} — ${typeLabel}`,
          device,
        });
      }
    }

    // Offline emulators (not currently running)
    const runningEmulatorNames = new Set(
      onlineDevices
        .filter((d) => d.type === "emulator")
        .map((d) => d.name.replace(/ /g, "_"))
    );
    const offlineEmulators = emulators.filter(
      (e) => !runningEmulatorNames.has(e.id)
    );

    if (offlineEmulators.length > 0) {
      items.push({
        label: vscode.l10n.t("Offline Emulators"),
        kind: vscode.QuickPickItemKind.Separator,
      });
      for (const emu of offlineEmulators) {
        items.push({
          label: `$(play) ${vscode.l10n.t("Start {0}", emu.name)}`,
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
        description: vscode.l10n.t("Connect a device or create an AVD in Android Studio"),
      });
    }

    // Cold boot section (at the bottom, separated)
    const coldBootTargets: { name: string; emulator: AvdEmulator }[] = [];
    // Running emulators
    for (const device of onlineDevices.filter((d) => d.type === "emulator")) {
      const avd = emulators.find((e) => e.name === device.name.replace(/ /g, "_"));
      if (avd) {
        coldBootTargets.push({ name: device.name, emulator: avd });
      }
    }
    // Offline emulators
    for (const emu of offlineEmulators) {
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

  private async launchAndWaitForEmulator(emulator: AvdEmulator, coldBoot = false): Promise<AndroidDevice | undefined> {
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
            (d) => d.type === "emulator" && d.isOnline && d.name.replace(/ /g, "_") === emulator.id
          );
          if (runningDevice) {
            await this.deviceProvider.killEmulator(runningDevice.id);
            // Wait for emulator to fully shut down
            for (let i = 0; i < 15; i++) {
              if (cancelled) { return; }
              await this.sleep(1000);
              const devices = await this.deviceProvider.getConnectedDevices();
              const stillRunning = devices.find((d) => d.id === runningDevice.id && d.isOnline);
              if (!stillRunning) { break; }
            }
          }
        }

        await this.deviceProvider.launchEmulator(emulator.id, coldBoot);

        // Wait for the emulator to appear in adb devices
        for (let i = 0; i < maxWaitSeconds; i++) {
          if (cancelled) { return; }
          await this.sleep(2000);
          const devices = await this.deviceProvider.getConnectedDevices();
          this.devices = devices;
          this.updateStatusBar();
          const newDevice = devices.find(
            (d) => d.type === "emulator" && d.isOnline
          );
          if (newDevice) {
            this.selectDevice(newDevice);
            return;
          }
          progress.report({
            message: vscode.l10n.t("{0}s — {1} device(s) found", (i + 1) * 2, devices.length),
          });
        }

        vscode.window.showWarningMessage(
          vscode.l10n.t("Emulator {0} launched but not yet connected. Select it manually when ready.", emulator.name)
        );
      }
    );

    return this.currentDevice;
  }

  public selectDevice(device: AndroidDevice): void {
    this.currentDevice = device;
    this.updateStatusBar();
    this.onDeviceChangedEmitter.fire(device);
  }

  public async refreshDevices(): Promise<void> {
    this.devices = await this.deviceProvider.getConnectedDevices();

    // Auto-select if current device is gone
    if (this.currentDevice) {
      const stillExists = this.devices.find(
        (d) => d.id === this.currentDevice!.id && d.isOnline
      );
      if (!stillExists) {
        this.currentDevice = undefined;
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
      const icon = this.currentDevice.type === "emulator" ? "$(device-mobile)" : "$(plug)";
      this.statusBarItem.text = `${icon} ${this.currentDevice.name}`;
      this.statusBarItem.backgroundColor = undefined;
    } else {
      this.statusBarItem.text = `$(device-mobile) ${vscode.l10n.t("No Device")}`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
    }
  }

  private startPolling(): void {
    // Poll every 3 seconds for device changes
    this.pollTimer = setInterval(async () => {
      const oldDeviceCount = this.devices.length;
      const oldDeviceId = this.currentDevice?.id;
      await this.refreshDevices();

      // Notify if device list changed
      if (this.devices.length !== oldDeviceCount || this.currentDevice?.id !== oldDeviceId) {
        this.updateStatusBar();
      }
    }, 3000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    this.onDeviceChangedEmitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
