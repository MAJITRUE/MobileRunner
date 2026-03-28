import * as path from "path";
import * as vscode from "vscode";
import { DeviceManager } from "./deviceManager";
import { PlatformProvider } from "./types";

interface ProjectVariants {
  projectRoot: string;
  projectName: string;
  variants: string[];
}

export class VariantManager implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private cachedProjects: ProjectVariants[] | undefined;
  private selectedVariant: string | undefined;
  private selectedProjectRoot: string | undefined;
  private scanning = false;
  private scanPromise: Promise<string[]> | undefined;
  private outputChannel: vscode.LogOutputChannel | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private providers: PlatformProvider[],
    private deviceManager: DeviceManager,
    private workspaceState: vscode.Memento
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      "androidRunnerVariant",
      vscode.StatusBarAlignment.Right,
      99
    );
    this.statusBarItem.name = "Build Variant";
    this.statusBarItem.command = "native-runner.selectVariant";
    this.statusBarItem.tooltip = vscode.l10n.t("Select Build Variant / Scheme");
    this.updateStatusBar();
    if (vscode.workspace.getConfiguration("native-runner").get<boolean>("showVariantSelector", true)) {
      this.statusBarItem.show();
    }
    this.disposables.push(this.statusBarItem);

    this.disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("native-runner.showVariantSelector")) {
        const show = vscode.workspace.getConfiguration("native-runner").get<boolean>("showVariantSelector", true);
        if (show) { this.statusBarItem.show(); } else { this.statusBarItem.hide(); }
      }
    }));

    // Invalidate cache when device changes (platform may change)
    this.disposables.push(
      this.deviceManager.onDeviceChanged(() => {
        this.cachedProjects = undefined;
        this.updateStatusBar();
      })
    );
  }

  public setOutputChannel(channel: vscode.LogOutputChannel): void {
    this.outputChannel = channel;
  }

  public getSelectedVariant(): string {
    if (this.selectedVariant) { return this.selectedVariant; }
    // Don't return default "debug" before scan completes — show "—" instead
    if (!this.cachedProjects) { return ""; }
    const config = vscode.workspace.getConfiguration("native-runner");
    const device = this.deviceManager.getCurrentDevice();
    if (device?.platform === "ios") {
      return config.get<string>("iosScheme", "");
    }
    return config.get<string>("buildVariant", "debug");
  }

  public getSelectedProjectRoot(): string | undefined {
    return this.selectedProjectRoot;
  }

  public hasCachedVariants(): boolean {
    return this.cachedProjects !== undefined;
  }

  private getCurrentProvider(): PlatformProvider | undefined {
    const device = this.deviceManager.getCurrentDevice();
    if (!device) { return this.providers[0]; }
    return this.providers.find((p) => p.platform === device.platform) || this.providers[0];
  }

  public async showVariantPicker(): Promise<string | undefined> {
    const quickPick = vscode.window.createQuickPick<VariantPickItem>();
    quickPick.placeholder = vscode.l10n.t("Select Build Variant / Scheme");
    quickPick.ignoreFocusOut = true;

    const current = this.getSelectedVariant();

    if (this.cachedProjects && this.cachedProjects.length > 0) {
      quickPick.items = this.buildPickerItems(this.cachedProjects, current);
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
      this.cachedProjects = undefined;
      await this.triggerScan();
      return this.showVariantPicker();
    }

    if (selection.variant) {
      this.selectedVariant = selection.variant;
      if (selection.projectRoot) {
        this.selectedProjectRoot = selection.projectRoot;
        this.workspaceState.update(`variant:${selection.projectRoot}`, selection.variant);
      }
      this.updateStatusBar();
      return selection.variant;
    }

    return undefined;
  }

  /** Wait for any in-progress scan to complete */
  public async waitForScan(): Promise<void> {
    if (this.scanPromise) { await this.scanPromise; }
  }

  public async triggerScan(silent = false): Promise<string[]> {
    if (this.scanning) {
      if (this.scanPromise) { return this.scanPromise; }
      const allVariants = this.cachedProjects?.flatMap((p) => p.variants) || [];
      return allVariants;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) { return []; }

    const activeFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;

    // Find all project roots from all providers
    const allRoots: { root: string; provider: PlatformProvider }[] = [];
    for (const p of this.providers) {
      const roots = p.findAllProjectRoots(workspaceFolders, activeFilePath);
      for (const root of roots) {
        allRoots.push({ root, provider: p });
      }
    }
    if (allRoots.length === 0) { return []; }

    this.scanning = true;
    this.statusBarItem.text = `$(loading~spin) ${vscode.l10n.t("Scanning...")}`;

    this.scanPromise = (async () => {
      try {
        const projects: ProjectVariants[] = [];
        for (const { root, provider } of allRoots) {
          let variants: string[];
          if (silent) {
            variants = await provider.scanVariants(root);
          } else {
            variants = await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Scanning {0}...", path.basename(root)) },
              () => provider.scanVariants(root)
            );
          }
          if (variants.length > 0) {
            projects.push({
              projectRoot: root,
              projectName: path.basename(root),
              variants,
            });
            this.outputChannel?.info(vscode.l10n.t("Found variants in {0}: {1}", path.basename(root), variants.join(", ")));
          }
        }
        this.cachedProjects = projects;

        // Restore previous selection from any project, or auto-select first
        const allVariants = projects.flatMap((p) => p.variants);
        if (allVariants.length > 0) {
          let restored = false;
          for (const proj of projects) {
            const saved = this.workspaceState.get<string>(`variant:${proj.projectRoot}`);
            if (saved && proj.variants.includes(saved)) {
              this.selectedVariant = saved;
              this.selectedProjectRoot = proj.projectRoot;
              restored = true;
              break;
            }
          }
          if (!restored) {
            const current = this.getSelectedVariant();
            if (!allVariants.includes(current)) {
              this.selectedVariant = projects[0].variants[0];
              this.selectedProjectRoot = projects[0].projectRoot;
            }
          }
        }
        this.updateStatusBar();
        return allVariants;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.outputChannel?.warn(vscode.l10n.t("Failed to scan build variants: {0}", msg));
        this.statusBarItem.text = `$(error) ${vscode.l10n.t("Scan failed")}`;
        if (!silent) {
          vscode.window.showErrorMessage(vscode.l10n.t("Failed to scan build variants: {0}", msg));
        }
        return [];
      } finally {
        this.scanning = false;
        this.scanPromise = undefined;
      }
    })();

    return this.scanPromise;
  }

  private buildPickerItems(projects: ProjectVariants[], current: string): VariantPickItem[] {
    const items: VariantPickItem[] = [];

    for (const project of projects) {
      items.push({
        label: project.projectName,
        kind: vscode.QuickPickItemKind.Separator,
      });

      for (const variant of project.variants) {
        const isCurrent = variant === current && project.projectRoot === this.selectedProjectRoot;
        items.push({
          label: isCurrent ? `$(check) ${variant}` : `$(package) ${variant}`,
          description: isCurrent ? vscode.l10n.t("(current)") : undefined,
          variant,
          projectRoot: project.projectRoot,
        });
      }
    }

    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: `$(refresh) ${vscode.l10n.t("Rescan variants")}`, action: "rescan" });

    return items;
  }

  private updateStatusBar(): void {
    const enabled = vscode.workspace.getConfiguration("native-runner").get<boolean>("showVariantSelector", true);
    const currentDevice = this.deviceManager.getCurrentDevice();
    const hasOnlineDevice = currentDevice !== undefined && currentDevice.isOnline;

    if (!enabled || !hasOnlineDevice) {
      this.statusBarItem.hide();
      return;
    }

    const variant = this.getSelectedVariant();
    this.statusBarItem.text = `$(package) ${variant || "—"}`;
    this.statusBarItem.show();
  }

  public invalidateCache(): void {
    this.cachedProjects = undefined;
  }

  dispose(): void {
    for (const d of this.disposables) { d.dispose(); }
  }
}

interface VariantPickItem extends vscode.QuickPickItem {
  variant?: string;
  projectRoot?: string;
  action?: "rescan";
}
