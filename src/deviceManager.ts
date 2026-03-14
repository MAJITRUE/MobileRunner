import * as vscode from "vscode";
import { AndroidDevice, AvdEmulator, DeviceProvider } from "./deviceProvider";

interface DevicePickItem extends vscode.QuickPickItem {
  device?: AndroidDevice;
  emulator?: AvdEmulator;
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
    this.statusBarItem.command = "android-runner.selectDevice";
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

    // Handle refresh action
    if (selection.action === "refresh") {
      return this.showDevicePicker();
    }

    // Handle emulator launch
    if (selection.emulator) {
      return this.launchAndWaitForEmulator(selection.emulator);
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

    // Connected devices
    const onlineDevices = this.devices.filter((d) => d.isOnline);
    if (onlineDevices.length > 0) {
      items.push({
        label: vscode.l10n.t("Connected Devices"),
        kind: vscode.QuickPickItemKind.Separator,
      });
      for (const device of onlineDevices) {
        const icon = device.type === "emulator" ? "$(device-mobile)" : "$(plug)";
        items.push({
          label: `${icon} ${device.name}`,
          description: device.id,
          detail: device.type === "emulator" ? vscode.l10n.t("Emulator") : vscode.l10n.t("Physical Device"),
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
        label: vscode.l10n.t("Available Emulators (not running)"),
        kind: vscode.QuickPickItemKind.Separator,
      });
      for (const emu of offlineEmulators) {
        items.push({
          label: `$(vm) ${emu.name}`,
          description: vscode.l10n.t("Click to launch"),
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

    // Refresh option
    items.push({
      label: "",
      kind: vscode.QuickPickItemKind.Separator,
    });
    items.push({
      label: vscode.l10n.t("$(refresh) Refresh device list"),
      action: "refresh",
    });

    return items;
  }

  private async launchAndWaitForEmulator(emulator: AvdEmulator): Promise<AndroidDevice | undefined> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Launching emulator: {0}...", emulator.name),
        cancellable: false,
      },
      async () => {
        await this.deviceProvider.launchEmulator(emulator.id);

        // Wait for the emulator to appear in adb devices (up to 60 seconds)
        for (let i = 0; i < 60; i++) {
          await this.sleep(1000);
          await this.refreshDevices();
          const newDevice = this.devices.find(
            (d) => d.type === "emulator" && d.isOnline
          );
          if (newDevice) {
            this.selectDevice(newDevice);
            return;
          }
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
    const config = vscode.workspace.getConfiguration("android-runner");
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
