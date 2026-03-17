import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";

export class VariantManager implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private cachedVariants: string[] | undefined;
  private selectedVariant: string | undefined;
  private scanning = false;
  private outputChannel: vscode.LogOutputChannel | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      "androidRunnerVariant",
      vscode.StatusBarAlignment.Right,
      97
    );
    this.statusBarItem.name = "Build Variant";
    this.statusBarItem.command = "native-runner.selectVariant";
    this.statusBarItem.tooltip = vscode.l10n.t("Select Build Variant");
    this.updateStatusBar();
    this.statusBarItem.show();
    this.disposables.push(this.statusBarItem);
  }

  public setOutputChannel(channel: vscode.LogOutputChannel): void {
    this.outputChannel = channel;
  }

  public getSelectedVariant(): string {
    if (this.selectedVariant) {
      return this.selectedVariant;
    }
    const config = vscode.workspace.getConfiguration("native-runner");
    return config.get<string>("buildVariant", "debug");
  }

  public hasCachedVariants(): boolean {
    return this.cachedVariants !== undefined;
  }

  public async showVariantPicker(): Promise<string | undefined> {
    const quickPick = vscode.window.createQuickPick<VariantPickItem>();
    quickPick.placeholder = vscode.l10n.t("Select Build Variant");
    quickPick.ignoreFocusOut = true;

    const current = this.getSelectedVariant();

    if (this.cachedVariants) {
      quickPick.items = this.buildPickerItems(this.cachedVariants, current);
    } else {
      quickPick.items = [{
        label: `$(check) ${current}`,
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
      quickPick.onDidAccept(() => {
        resolve(quickPick.selectedItems[0]);
        quickPick.hide();
      });
      quickPick.onDidHide(() => resolve(undefined));
    });

    quickPick.dispose();

    if (!selection) {
      return undefined;
    }

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
    if (this.scanning) {
      return this.cachedVariants || [];
    }

    const projectRoot = this.findProjectRoot();
    if (!projectRoot) {
      return [];
    }

    this.scanning = true;
    this.statusBarItem.text = `$(loading~spin) ${this.getSelectedVariant()}`;
    try {
      let variants: string[];
      if (silent) {
        variants = await this.scanVariants(projectRoot);
      } else {
        variants = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t("Scanning build variants..."),
          },
          async () => {
            return this.scanVariants(projectRoot);
          }
        );
      }
      this.cachedVariants = variants;
      this.updateStatusBar();
      return variants;
    } finally {
      this.scanning = false;
    }
  }

  private async scanVariants(projectRoot: string): Promise<string[]> {
    try {
      const output = await this.runGradleTasks(projectRoot);
      const variants = this.parseInstallTasks(output);
      if (variants.length > 0) {
        this.outputChannel?.info(
          vscode.l10n.t("Found variants: {0}", variants.join(", "))
        );
      }
      return variants;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.outputChannel?.warn(
        vscode.l10n.t("Failed to scan build variants: {0}", msg)
      );
      return [];
    }
  }

  private parseInstallTasks(output: string): string[] {
    const variants: string[] = [];
    const regex = /^(?::?\w+:)?install([A-Z][A-Za-z0-9]*)(?:\s+-\s+|\s*$)/gm;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(output)) !== null) {
      const suffix = match[1];
      // Skip test variants
      if (suffix.endsWith("AndroidTest") || suffix.endsWith("UnitTest")) {
        continue;
      }
      const normalized = suffix.charAt(0).toLowerCase() + suffix.slice(1);
      if (!variants.includes(normalized)) {
        variants.push(normalized);
      }
    }
    return variants;
  }

  private runGradleTasks(projectRoot: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const isWindows = process.platform === "win32";
      const gradlewPath = path.join(
        projectRoot,
        isWindows ? "gradlew.bat" : "gradlew"
      );

      const executable = fs.existsSync(gradlewPath)
        ? gradlewPath
        : isWindows
          ? "gradlew.bat"
          : "./gradlew";

      const appModule = vscode.workspace
        .getConfiguration("native-runner")
        .get<string>("appModule", "app");

      const args = [`${appModule}:tasks`, "--all", "--console=plain"];
      const env = { ...process.env };

      const javaHome = this.detectJavaHome();
      if (javaHome) {
        env.JAVA_HOME = javaHome;
      }

      const spawnArgs = isWindows
        ? { cmd: "cmd.exe", args: ["/c", executable, ...args] }
        : { cmd: executable, args };

      const child = cp.execFile(
        spawnArgs.cmd,
        spawnArgs.args,
        {
          cwd: projectRoot,
          env,
          timeout: 60000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || stdout || error.message));
            return;
          }
          resolve(stdout);
        }
      );
    });
  }

  private findProjectRoot(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return undefined;
    }

    for (const folder of workspaceFolders) {
      const root = folder.uri.fsPath;
      if (
        fs.existsSync(path.join(root, "build.gradle")) ||
        fs.existsSync(path.join(root, "build.gradle.kts"))
      ) {
        return root;
      }
      const androidDir = path.join(root, "android");
      if (
        fs.existsSync(path.join(androidDir, "build.gradle")) ||
        fs.existsSync(path.join(androidDir, "build.gradle.kts"))
      ) {
        return androidDir;
      }
    }

    return undefined;
  }

  private detectJavaHome(): string | undefined {
    const config = vscode.workspace.getConfiguration("native-runner");
    const configJavaHome = config.get<string>("javaHome");
    if (configJavaHome && fs.existsSync(configJavaHome)) {
      return configJavaHome;
    }

    if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) {
      return process.env.JAVA_HOME;
    }

    const isMac = process.platform === "darwin";
    const isWindows = process.platform === "win32";

    const androidStudioJdkPaths = isMac
      ? [
          "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
          `${process.env.HOME}/Applications/Android Studio.app/Contents/jbr/Contents/Home`,
        ]
      : isWindows
        ? [
            `${process.env.LOCALAPPDATA}\\Programs\\Android\\Android Studio\\jbr`,
            `C:\\Program Files\\Android\\Android Studio\\jbr`,
          ]
        : [
            `${process.env.HOME}/android-studio/jbr`,
            "/opt/android-studio/jbr",
            "/usr/local/android-studio/jbr",
          ];

    for (const p of androidStudioJdkPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    if (isMac) {
      try {
        const result = cp.execSync("/usr/libexec/java_home 2>/dev/null", {
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        if (result && fs.existsSync(result)) {
          return result;
        }
      } catch {
        // not available
      }
    }

    const commonPaths = isMac
      ? [
          "/Library/Java/JavaVirtualMachines",
          `${process.env.HOME}/Library/Java/JavaVirtualMachines`,
        ]
      : isWindows
        ? [
            `${process.env.ProgramFiles}\\Java`,
            `${process.env.ProgramFiles}\\Eclipse Adoptium`,
            `${process.env.ProgramFiles}\\Microsoft\\jdk`,
            `${process.env.ProgramFiles}\\Zulu`,
          ]
        : ["/usr/lib/jvm"];

    const javaExe = isWindows ? "java.exe" : "java";
    for (const dir of commonPaths) {
      if (fs.existsSync(dir)) {
        try {
          const entries = fs.readdirSync(dir).sort().reverse();
          for (const entry of entries) {
            const home = isMac
              ? path.join(dir, entry, "Contents", "Home")
              : path.join(dir, entry);
            if (fs.existsSync(path.join(home, "bin", javaExe))) {
              return home;
            }
          }
        } catch {
          // ignore
        }
      }
    }

    return undefined;
  }

  private buildPickerItems(variants: string[], current: string): VariantPickItem[] {
    const items: VariantPickItem[] = [];

    items.push({
      label: vscode.l10n.t("Build Variants"),
      kind: vscode.QuickPickItemKind.Separator,
    });

    for (const variant of variants) {
      const isCurrent = variant === current;
      items.push({
        label: isCurrent ? `$(check) ${variant}` : `$(package) ${variant}`,
        description: isCurrent ? vscode.l10n.t("(current)") : undefined,
        variant,
      });
    }

    items.push({
      label: "",
      kind: vscode.QuickPickItemKind.Separator,
    });
    items.push({
      label: `$(refresh) ${vscode.l10n.t("Rescan variants")}`,
      action: "rescan",
    });

    return items;
  }

  private updateStatusBar(): void {
    const variant = this.getSelectedVariant();
    this.statusBarItem.text = `$(package) ${variant}`;
  }

  public invalidateCache(): void {
    this.cachedVariants = undefined;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

interface VariantPickItem extends vscode.QuickPickItem {
  variant?: string;
  action?: "rescan";
}
