import * as vscode from "vscode";
import { DeviceManager } from "./deviceManager";
import { PlatformProvider } from "./types";

export class VariantManager implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private cachedVariants: string[] | undefined;
  private selectedVariant: string | undefined;
  private scanning = false;
  private outputChannel: vscode.LogOutputChannel | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private providers: PlatformProvider[],
    private deviceManager: DeviceManager
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      "androidRunnerVariant",
      vscode.StatusBarAlignment.Right,
      97
    );
    this.statusBarItem.name = "Build Variant";
    this.statusBarItem.command = "native-runner.selectVariant";
    this.statusBarItem.tooltip = vscode.l10n.t("Select Build Variant / Scheme");
    this.updateStatusBar();
    this.statusBarItem.show();
    this.disposables.push(this.statusBarItem);

    // Invalidate cache when device changes (platform may change)
    this.disposables.push(
      this.deviceManager.onDeviceChanged(() => {
        this.cachedVariants = undefined;
        this.updateStatusBar();
      })
    );
  }

  public setOutputChannel(channel: vscode.LogOutputChannel): void {
    this.outputChannel = channel;
  }

  public getSelectedVariant(): string {
    if (this.selectedVariant) { return this.selectedVariant; }
    const config = vscode.workspace.getConfiguration("native-runner");
    const device = this.deviceManager.getCurrentDevice();
    if (device?.platform === "ios") {
      return config.get<string>("iosScheme", "");
    }
    return config.get<string>("buildVariant", "debug");
  }

  public hasCachedVariants(): boolean {
    return this.cachedVariants !== undefined;
  }

  private getCurrentProvider(): PlatformProvider | undefined {
    const device = this.deviceManager.getCurrentDevice();
    if (!device) { return this.providers[0]; }
    return this.providers.find((p) => p.platform === device.platform) || this.providers[0];
  }

  public async showVariantPicker(): Promise<string | undefined> {
    const quickPick = vscode.window.createQuickPick<VariantPickItem>();
    const device = this.deviceManager.getCurrentDevice();
    const isIos = device?.platform === "ios";
    quickPick.placeholder = isIos
      ? vscode.l10n.t("Select Xcode Scheme")
      : vscode.l10n.t("Select Build Variant");
    quickPick.ignoreFocusOut = true;

    const current = this.getSelectedVariant();

    if (this.cachedVariants) {
      quickPick.items = this.buildPickerItems(this.cachedVariants, current);
    } else {
      quickPick.items = [{
        label: `$(check) ${current || "(none)"}`,
        description: vscode.l10n.t("(current)"),
        variant: current,
      }, {
        label: "",
        kind: vscode.QuickPickItemKind.Separator,
      }, {
        label: `$(refresh) ${vscode.l10n.t("Scan variants")}`,
        action: "rescan",
      }];
    }

    quickPick.show();

    const selection = await new Promise<VariantPickItem | undefined>((resolve) => {
      quickPick.onDidAccept(() => { resolve(quickPick.selectedItems[0]); quickPick.hide(); });
      quickPick.onDidHide(() => resolve(undefined));
    });

    quickPick.dispose();

    if (!selection) { return undefined; }

    if (selection.action === "rescan") {
      this.cachedVariants = undefined;
      await this.triggerScan();
      return this.showVariantPicker();
    }

    if (selection.variant) {
      this.selectedVariant = selection.variant;
      this.updateStatusBar();
      return selection.variant;
    }

    return undefined;
  }

  public async triggerScan(silent = false): Promise<string[]> {
    if (this.scanning) { return this.cachedVariants || []; }

    const provider = this.getCurrentProvider();
    if (!provider) { return []; }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) { return []; }

    const projectRoot = provider.findProjectRoot(workspaceFolders);
    if (!projectRoot) { return []; }

    this.scanning = true;
    this.statusBarItem.text = `$(loading~spin) ${this.getSelectedVariant() || "..."}`;

    try {
      let variants: string[];
      if (silent) {
        variants = await provider.scanVariants(projectRoot);
      } else {
        variants = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Scanning build variants...") },
          () => provider.scanVariants(projectRoot)
        );
      }
      this.cachedVariants = variants;
      if (variants.length > 0) {
        this.outputChannel?.info(vscode.l10n.t("Found variants: {0}", variants.join(", ")));
      }
      this.updateStatusBar();
      return variants;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.outputChannel?.warn(vscode.l10n.t("Failed to scan build variants: {0}", msg));
      return [];
    } finally {
      this.scanning = false;
    }
  }

  private buildPickerItems(variants: string[], current: string): VariantPickItem[] {
    const items: VariantPickItem[] = [];

    const device = this.deviceManager.getCurrentDevice();
    const sectionLabel = device?.platform === "ios"
      ? vscode.l10n.t("Xcode Schemes")
      : vscode.l10n.t("Build Variants");

    items.push({ label: sectionLabel, kind: vscode.QuickPickItemKind.Separator });

    for (const variant of variants) {
      const isCurrent = variant === current;
      items.push({
        label: isCurrent ? `$(check) ${variant}` : `$(package) ${variant}`,
        description: isCurrent ? vscode.l10n.t("(current)") : undefined,
        variant,
      });
    }

    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: `$(refresh) ${vscode.l10n.t("Rescan variants")}`, action: "rescan" });

    return items;
  }

  private updateStatusBar(): void {
    const variant = this.getSelectedVariant();
    this.statusBarItem.text = `$(package) ${variant || "—"}`;
  }

  public invalidateCache(): void {
    this.cachedVariants = undefined;
  }

  dispose(): void {
    for (const d of this.disposables) { d.dispose(); }
  }
}

interface VariantPickItem extends vscode.QuickPickItem {
  variant?: string;
  action?: "rescan";
}
