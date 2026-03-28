import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import * as vscode from "vscode";
import { Device } from "./types";
import { DeviceManager } from "./deviceManager";
import { FileExplorerService, RemoteFileEntry } from "./fileExplorerService";

interface OpenedFileInfo {
  deviceId: string;
  remotePath: string;
  runAsPackage?: string;
  localPath: string;
}

/** Normalize path for Map key (case-insensitive on Windows) */
function normalizeKey(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

// --- Node data model ---

type NodeType = "root" | "folder" | "file" | "appDataRoot" | "package" | "error";

interface FileNodeData {
  type: NodeType;
  deviceId: string;
  remotePath: string;
  entry?: RemoteFileEntry;
  packageName?: string;
}

class FileExplorerItem extends vscode.TreeItem {
  constructor(
    public readonly data: FileNodeData,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(label, collapsibleState);

    switch (data.type) {
      case "root":
        this.contextValue = "deviceRoot";
        this.iconPath = new vscode.ThemeIcon("folder");
        this.description = data.remotePath;
        break;
      case "appDataRoot":
        this.contextValue = "deviceRoot";
        this.iconPath = new vscode.ThemeIcon("package");
        this.description = "/data/data/";
        break;
      case "package":
        this.contextValue = "deviceFolder";
        this.iconPath = new vscode.ThemeIcon("symbol-namespace");
        break;
      case "folder":
        this.contextValue = "deviceFolder";
        this.iconPath = new vscode.ThemeIcon("folder");
        break;
      case "file":
        this.contextValue = "deviceFile";
        this.iconPath = new vscode.ThemeIcon("file");
        if (data.entry?.size !== undefined) {
          this.description = formatSize(data.entry.size);
        }
        this.command = {
          command: "native-runner.fileExplorer.openInEditor",
          title: "Open",
          arguments: [this],
        };
        break;
      case "error":
        this.contextValue = "deviceError";
        this.iconPath = new vscode.ThemeIcon("warning");
        break;
    }

    if (data.entry && !data.entry.isError) {
      const lines: string[] = [];
      if (data.entry.permissions) { lines.push(data.entry.permissions); }
      if (data.entry.size !== undefined) { lines.push(formatSize(data.entry.size)); }
      if (data.entry.date) { lines.push(data.entry.date); }
      lines.push(data.entry.path);
      this.tooltip = lines.join("\n");
    }
  }
}

// --- TreeDataProvider ---

export class DeviceFileExplorer implements vscode.TreeDataProvider<FileExplorerItem>, vscode.TreeDragAndDropController<FileExplorerItem>, vscode.Disposable {
  readonly dropMimeTypes = ["text/uri-list", "application/vnd.native-runner.file-explorer"];
  readonly dragMimeTypes = ["application/vnd.native-runner.file-explorer"];

  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<FileExplorerItem | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private currentDevice: Device | undefined;
  private treeView: vscode.TreeView<FileExplorerItem>;
  private disposables: vscode.Disposable[] = [];
  private childrenCache = new Map<string, FileExplorerItem[]>(); // remotePath → cached children
  private openedFiles = new Map<string, OpenedFileInfo>(); // normalizedLocalPath → info
  private pushDebounceTimers = new Map<string, NodeJS.Timeout>();
  private fileWatchers = new Map<string, fs.FSWatcher>(); // normalizedLocalPath → watcher
  private readonly tmpRoot = path.join(os.tmpdir(), "native-runner-explorer");
  private readonly mappingFile = path.join(os.tmpdir(), "native-runner-explorer", "_mappings.json");

  constructor(
    private service: FileExplorerService,
    private deviceManager: DeviceManager,
  ) {
    this.treeView = vscode.window.createTreeView("deviceFileExplorer", {
      treeDataProvider: this,
      showCollapseAll: true,
      dragAndDropController: this,
    });
    this.disposables.push(this.treeView);

    // Auto-select first device; handle disconnection
    this.disposables.push(
      this.deviceManager.onDeviceChanged(() => {
        if (!this.currentDevice) {
          this.autoSelectDevice();
        } else {
          const still = this.deviceManager.getDevices().find(d => d.id === this.currentDevice!.id);
          if (!still || !still.isOnline) {
            this.setDevice(undefined);
          }
        }
      })
    );

    this.autoSelectDevice();

    // Unregister auto-push on file close (keep cache file, stop watcher)
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const key = normalizeKey(doc.uri.fsPath);
        this.unwatchFile(key);
      })
    );

    // Restore mappings from previous session, then clean expired cache
    this.restoreMappings();
    this.cleanExpiredCache();
  }

  private saveMappings(): void {
    try {
      fs.mkdirSync(this.tmpRoot, { recursive: true });
      const data = Object.fromEntries(this.openedFiles);
      fs.writeFileSync(this.mappingFile, JSON.stringify(data, null, 2));
    } catch { /* ignore */ }
  }

  private restoreMappings(): void {
    try {
      if (!fs.existsSync(this.mappingFile)) { return; }
      const data: Record<string, OpenedFileInfo> = JSON.parse(fs.readFileSync(this.mappingFile, "utf-8"));
      for (const [key, info] of Object.entries(data)) {
        if (fs.existsSync(info.localPath)) {
          this.openedFiles.set(key, info);
          this.watchFile(info.localPath, info);
        }
      }
    } catch { /* ignore corrupt file */ }
  }

  private watchFile(localPath: string, info: OpenedFileInfo): void {
    const key = normalizeKey(localPath);
    if (this.fileWatchers.has(key)) { return; }
    try {
      const watcher = fs.watch(localPath, () => {
        const existing = this.pushDebounceTimers.get(key);
        if (existing) { clearTimeout(existing); }
        this.pushDebounceTimers.set(key, setTimeout(() => {
          this.pushDebounceTimers.delete(key);
          const current = this.openedFiles.get(key);
          if (current) { this.pushBackToDevice(current); }
        }, 1000));
      });
      this.fileWatchers.set(key, watcher);
    } catch { /* ignore - file may not exist yet */ }
  }

  private unwatchFile(key: string): void {
    if (!this.openedFiles.has(key)) { return; }
    const timer = this.pushDebounceTimers.get(key);
    if (timer) { clearTimeout(timer); this.pushDebounceTimers.delete(key); }
    const watcher = this.fileWatchers.get(key);
    if (watcher) { watcher.close(); this.fileWatchers.delete(key); }
    this.openedFiles.delete(key);
    this.saveMappings();
  }

  private async pushBackToDevice(info: OpenedFileInfo): Promise<void> {
    try {
      await this.service.pushFile(info.deviceId, info.localPath, info.remotePath, info.runAsPackage);
      vscode.window.setStatusBarMessage(vscode.l10n.t("Saved to device: {0}", path.posix.basename(info.remotePath)), 3000);
      this.onDidChangeTreeDataEmitter.fire(undefined);
    } catch (err: any) {
      vscode.window.showErrorMessage(vscode.l10n.t("Failed to save to device: {0}", err?.message || String(err)));
    }
  }

  private autoSelectDevice(): void {
    const android = this.deviceManager.getDevices()
      .find(d => d.platform === "android" && d.isOnline);
    this.setDevice(android);
  }

  async selectExplorerDevice(): Promise<void> {
    const devices = this.deviceManager.getDevices()
      .filter(d => d.platform === "android" && d.isOnline);
    if (devices.length === 0) {
      vscode.window.showInformationMessage(vscode.l10n.t("No Android devices connected"));
      return;
    }
    const items = devices.map(d => ({ label: d.name, description: d.id, device: d }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: vscode.l10n.t("Select device for file explorer"),
    });
    if (!picked) { return; }
    this.setDevice(picked.device);
  }

  private setDevice(device: Device | undefined): void {
    const previousDeviceId = this.currentDevice?.id;
    const isAndroid = device?.platform === "android" && device.isOnline;
    this.currentDevice = isAndroid ? device : undefined;
    this.childrenCache.clear();

    // Stop watchers for the disconnected device to prevent push errors
    if (previousDeviceId && (!this.currentDevice || this.currentDevice.id !== previousDeviceId)) {
      const keysToRemove: string[] = [];
      for (const [key, info] of this.openedFiles) {
        if (info.deviceId === previousDeviceId) {
          keysToRemove.push(key);
        }
      }
      for (const key of keysToRemove) {
        this.unwatchFile(key);
      }
    }

    vscode.commands.executeCommand("setContext", "native-runner.hasAndroidDevice", isAndroid);
    this.treeView.title = this.currentDevice?.name
      || vscode.l10n.t("No device");
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  // --- TreeDataProvider interface ---

  getTreeItem(element: FileExplorerItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: FileExplorerItem): Promise<FileExplorerItem[]> {
    if (!this.currentDevice) {
      return [new FileExplorerItem(
        { type: "error", deviceId: "", remotePath: "" },
        vscode.l10n.t("No Android device selected"),
        vscode.TreeItemCollapsibleState.None,
      )];
    }

    const deviceId = this.currentDevice.id;

    // Root level
    if (!element) {
      return [
        new FileExplorerItem(
          { type: "root", deviceId, remotePath: "/sdcard" },
          vscode.l10n.t("Storage"),
          vscode.TreeItemCollapsibleState.Collapsed,
        ),
        new FileExplorerItem(
          { type: "appDataRoot", deviceId, remotePath: "/data/data" },
          vscode.l10n.t("App Data"),
          vscode.TreeItemCollapsibleState.Collapsed,
        ),
        new FileExplorerItem(
          { type: "root", deviceId, remotePath: "/" },
          vscode.l10n.t("System"),
          vscode.TreeItemCollapsibleState.Collapsed,
        ),
      ];
    }

    // App Data root → list packages
    if (element.data.type === "appDataRoot") {
      const packages = await this.service.listPackages(deviceId);
      if (packages.length === 0) {
        return [new FileExplorerItem(
          { type: "error", deviceId, remotePath: "" },
          vscode.l10n.t("No packages found"),
          vscode.TreeItemCollapsibleState.None,
        )];
      }
      return packages.map((pkg) => new FileExplorerItem(
        { type: "package", deviceId, remotePath: `/data/data/${pkg}`, packageName: pkg },
        pkg,
        vscode.TreeItemCollapsibleState.Collapsed,
      ));
    }

    // Directory listing
    const remotePath = element.data.remotePath;
    const runAsPackage = element.data.packageName || element.data.entry?.packageName;
    const refreshOnExpand = vscode.workspace.getConfiguration("native-runner").get<boolean>("explorerRefreshOnExpand", true);

    // Return cache if available and refreshOnExpand is disabled
    if (!refreshOnExpand) {
      const cached = this.childrenCache.get(remotePath);
      if (cached) { return cached; }
    }

    const entries = await this.service.listDirectory(deviceId, remotePath, runAsPackage);

    if (entries.length === 0) {
      return [new FileExplorerItem(
        { type: "error", deviceId, remotePath },
        vscode.l10n.t("Empty"),
        vscode.TreeItemCollapsibleState.None,
      )];
    }

    const items = entries.map((entry) => {
      if (entry.isError) {
        return new FileExplorerItem(
          { type: "error", deviceId, remotePath: entry.path },
          entry.name,
          vscode.TreeItemCollapsibleState.None,
        );
      }
      const type: NodeType = entry.isDirectory ? "folder" : "file";
      return new FileExplorerItem(
        { type, deviceId, remotePath: entry.path, entry, packageName: runAsPackage },
        entry.name,
        entry.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      );
    });

    // Cache for non-refresh mode
    this.childrenCache.set(remotePath, items);
    return items;
  }

  // --- Actions ---

  refresh(): void {
    this.childrenCache.clear();
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  async downloadFile(item: FileExplorerItem): Promise<void> {
    if (!item?.data?.deviceId || !item?.data?.remotePath) { return; }
    if (!await this.confirmLargeFile(item)) { return; }

    const targetDir = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      title: vscode.l10n.t("Select download folder"),
    });
    if (!targetDir?.[0]) { return; }

    const runAs = item.data.packageName || item.data.entry?.packageName;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Downloading...") },
        async () => {
          await this.service.pullFile(item.data.deviceId, item.data.remotePath, targetDir[0].fsPath, runAs);
        }
      );
      vscode.window.showInformationMessage(vscode.l10n.t("Download complete"));
    } catch (err: any) {
      vscode.window.showErrorMessage(vscode.l10n.t("Download failed: {0}", err?.message || String(err)));
    }
  }

  async uploadFile(item: FileExplorerItem): Promise<void> {
    if (!item?.data?.deviceId || !item?.data?.remotePath) { return; }

    const files = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: true,
      title: vscode.l10n.t("Select files to upload"),
    });
    if (!files || files.length === 0) { return; }

    const runAs = item.data.packageName || item.data.entry?.packageName;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Uploading...") },
        async () => {
          for (const file of files) {
            const remoteDest = item.data.remotePath + "/" + path.basename(file.fsPath);
            await this.service.pushFile(item.data.deviceId, file.fsPath, remoteDest, runAs);
          }
        }
      );
      vscode.window.showInformationMessage(vscode.l10n.t("Upload complete"));
      this.onDidChangeTreeDataEmitter.fire(item);
    } catch (err: any) {
      vscode.window.showErrorMessage(vscode.l10n.t("Upload failed: {0}", err?.message || String(err)));
    }
  }

  async deleteItem(item: FileExplorerItem): Promise<void> {
    if (!item?.data?.deviceId || !item?.data?.remotePath) { return; }

    const name = item.data.entry?.name || path.posix.basename(item.data.remotePath);
    const confirm = await vscode.window.showWarningMessage(
      vscode.l10n.t("Delete {0}?", name),
      { modal: true },
      vscode.l10n.t("Delete"),
    );
    if (!confirm) { return; }

    const runAs = item.data.packageName || item.data.entry?.packageName;
    try {
      await this.service.deleteFile(item.data.deviceId, item.data.remotePath, runAs);
      vscode.window.showInformationMessage(vscode.l10n.t("Deleted"));
      this.onDidChangeTreeDataEmitter.fire(undefined);
    } catch (err: any) {
      vscode.window.showErrorMessage(vscode.l10n.t("Delete failed: {0}", err?.message || String(err)));
    }
  }

  async newFolder(item: FileExplorerItem): Promise<void> {
    if (!item?.data?.deviceId || !item?.data?.remotePath) { return; }

    const folderName = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("New folder name"),
      placeHolder: "new-folder",
    });
    if (!folderName) { return; }

    const remotePath = item.data.remotePath + "/" + folderName;
    const runAs = item.data.packageName || item.data.entry?.packageName;
    try {
      await this.service.makeDirectory(item.data.deviceId, remotePath, runAs);
      this.onDidChangeTreeDataEmitter.fire(item);
    } catch (err: any) {
      vscode.window.showErrorMessage(vscode.l10n.t("Failed to create folder: {0}", err?.message || String(err)));
    }
  }

  /** Returns false if user cancels due to file size warning */
  private async confirmLargeFile(item: FileExplorerItem): Promise<boolean> {
    const size = item.data.entry?.size;
    if (size === undefined) { return true; }
    const limitMB = vscode.workspace.getConfiguration("native-runner")
      .get<number>("explorerFileSizeLimit", 10);
    if (limitMB <= 0 || size < limitMB * 1024 * 1024) { return true; }
    const label = formatSize(size);
    const result = await vscode.window.showWarningMessage(
      vscode.l10n.t("This file is {0}. Continue?", label),
      vscode.l10n.t("Continue"),
      vscode.l10n.t("Cancel"),
    );
    return result === vscode.l10n.t("Continue");
  }

  async renameItem(item: FileExplorerItem): Promise<void> {
    if (!item?.data?.deviceId || !item?.data?.remotePath || !item.data.entry) { return; }

    const newName = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("New name"),
      value: item.data.entry.name,
    });
    if (!newName || newName === item.data.entry.name) { return; }

    const parentDir = path.posix.dirname(item.data.remotePath);
    const newPath = parentDir + "/" + newName;
    const runAs = item.data.packageName || item.data.entry.packageName;
    try {
      await this.service.renameFile(item.data.deviceId, item.data.remotePath, newPath, runAs);
      this.onDidChangeTreeDataEmitter.fire(undefined);
    } catch (err: any) {
      vscode.window.showErrorMessage(vscode.l10n.t("Rename failed: {0}", err?.message || String(err)));
    }
  }

  async newFile(item: FileExplorerItem): Promise<void> {
    if (!item?.data?.deviceId || !item?.data?.remotePath) { return; }

    const fileName = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("New file name"),
      placeHolder: "new-file.txt",
    });
    if (!fileName) { return; }

    const remotePath = item.data.remotePath + "/" + fileName;
    const runAs = item.data.packageName || item.data.entry?.packageName;
    try {
      await this.service.touchFile(item.data.deviceId, remotePath, runAs);
      this.onDidChangeTreeDataEmitter.fire(item);
    } catch (err: any) {
      vscode.window.showErrorMessage(vscode.l10n.t("Failed to create file: {0}", err?.message || String(err)));
    }
  }

  copyPath(item: FileExplorerItem): void {
    if (!item?.data?.remotePath) { return; }
    vscode.env.clipboard.writeText(item.data.remotePath);
  }

  async openInEditor(item: FileExplorerItem): Promise<void> {
    if (!item?.data?.deviceId || !item?.data?.remotePath || !item.data.entry) { return; }
    if (!await this.confirmLargeFile(item)) { return; }

    // Use hash to avoid same-name collisions from different remote paths
    const hash = crypto.createHash("md5").update(item.data.deviceId + ":" + item.data.remotePath).digest("hex").slice(0, 8);
    const tmpDir = path.join(this.tmpRoot, hash);
    fs.mkdirSync(tmpDir, { recursive: true });
    const localPath = path.join(tmpDir, item.data.entry.name);

    const runAs = item.data.packageName || item.data.entry.packageName;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Opening...") },
        async () => {
          await this.service.pullFile(item.data.deviceId, item.data.remotePath, localPath, runAs);
        }
      );
      // Register for auto-push on file change
      const info: OpenedFileInfo = {
        deviceId: item.data.deviceId,
        remotePath: item.data.remotePath,
        runAsPackage: runAs,
        localPath,
      };
      this.openedFiles.set(normalizeKey(localPath), info);
      this.watchFile(localPath, info);
      this.saveMappings();
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(localPath));
    } catch (err: any) {
      vscode.window.showErrorMessage(vscode.l10n.t("Failed to open file: {0}", err?.message || String(err)));
    }
  }

  handleDrag(source: readonly FileExplorerItem[], dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): void {
    const paths = source
      .filter((s) => s.data.type === "file" || s.data.type === "folder")
      .map((s) => JSON.stringify({ remotePath: s.data.remotePath, packageName: s.data.packageName || s.data.entry?.packageName, deviceId: s.data.deviceId, isDirectory: s.data.type === "folder" }));
    if (paths.length > 0) {
      dataTransfer.set("application/vnd.native-runner.file-explorer", new vscode.DataTransferItem(paths.join("\n")));
    }
  }

  async handleDrop(target: FileExplorerItem | undefined, dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): Promise<void> {
    if (!target?.data?.deviceId) { return; }

    // Resolve target folder
    const isFolder = target.data.type === "folder" || target.data.type === "root" || target.data.type === "appDataRoot" || target.data.type === "package";
    const targetFolder = isFolder ? target : undefined;
    if (!targetFolder?.data?.remotePath) { return; }

    const runAs = targetFolder.data.packageName || targetFolder.data.entry?.packageName;

    // Internal tree drag: move files within device
    const internalData = dataTransfer.get("application/vnd.native-runner.file-explorer");
    if (internalData) {
      const raw = await internalData.asString();
      const items = raw.split("\n").filter(Boolean).map((s) => JSON.parse(s) as { remotePath: string; packageName?: string; deviceId: string; isDirectory?: boolean });
      if (items.length > 0 && items[0].deviceId === targetFolder.data.deviceId) {
        // Confirm if any dragged item is a folder
        const hasFolder = items.some((item) => item.isDirectory);
        if (hasFolder) {
          const folderNames = items.filter((i) => i.isDirectory).map((i) => path.posix.basename(i.remotePath)).join(", ");
          const result = await vscode.window.showWarningMessage(
            vscode.l10n.t("Move folder \"{0}\" and all its contents?", folderNames),
            { modal: true },
            vscode.l10n.t("Move")
          );
          if (!result) { return; }
        }
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Moving...") },
            async () => {
              for (const item of items) {
                const destPath = targetFolder.data.remotePath + "/" + path.posix.basename(item.remotePath);
                await this.service.moveFile(item.deviceId, item.remotePath, destPath, runAs);
              }
            }
          );
          this.onDidChangeTreeDataEmitter.fire(undefined); // refresh whole tree since source and target both changed
        } catch (err: any) {
          vscode.window.showErrorMessage(vscode.l10n.t("Move failed: {0}", err?.message || String(err)));
        }
        return;
      }
    }

    // External drag: upload files from local filesystem
    const uriList = dataTransfer.get("text/uri-list");
    if (!uriList) { return; }
    const raw = await uriList.asString();
    const uris = raw.split("\n").map(s => s.trim()).filter(Boolean).map(s => vscode.Uri.parse(s));
    if (uris.length === 0) { return; }

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Uploading...") },
        async () => {
          for (const uri of uris) {
            const remoteDest = targetFolder.data.remotePath + "/" + path.basename(uri.fsPath);
            await this.service.pushFile(targetFolder.data.deviceId, uri.fsPath, remoteDest, runAs);
          }
        }
      );
      vscode.window.showInformationMessage(vscode.l10n.t("Upload complete"));
      this.onDidChangeTreeDataEmitter.fire(targetFolder);
    } catch (err: any) {
      vscode.window.showErrorMessage(vscode.l10n.t("Upload failed: {0}", err?.message || String(err)));
    }
  }

  private async confirmFolderOperation(item: { remotePath: string; type?: string; entry?: { isDirectory?: boolean } }, mode: "move" | "copy"): Promise<boolean> {
    const isDir = item.type === "folder" || item.entry?.isDirectory;
    if (!isDir) { return true; }

    const action = mode === "move" ? vscode.l10n.t("Move") : vscode.l10n.t("Copy");
    const folderName = path.posix.basename(item.remotePath);
    const result = await vscode.window.showWarningMessage(
      vscode.l10n.t("{0} folder \"{1}\" and all its contents?", action, folderName),
      { modal: true },
      action
    );
    return result === action;
  }

  async moveToFolder(item: FileExplorerItem): Promise<void> {
    await this.transferToFolder(item, "move");
  }

  async copyToFolder(item: FileExplorerItem): Promise<void> {
    await this.transferToFolder(item, "copy");
  }

  private async transferToFolder(item: FileExplorerItem, mode: "move" | "copy"): Promise<void> {
    if (!item?.data?.deviceId || !item?.data?.remotePath) { return; }
    const deviceId = item.data.deviceId;
    const runAs = item.data.packageName || item.data.entry?.packageName;

    const dest = await vscode.window.showInputBox({
      prompt: mode === "move"
        ? vscode.l10n.t("Move to (remote path)")
        : vscode.l10n.t("Copy to (remote path)"),
      value: item.data.remotePath,
      valueSelection: [path.posix.dirname(item.data.remotePath).length + 1, path.posix.dirname(item.data.remotePath).length + 1],
    });
    if (!dest) { return; }

    const destPath = dest.endsWith("/")
      ? dest + path.posix.basename(item.data.remotePath)
      : dest;

    try {
      if (mode === "move") {
        await this.service.moveFile(deviceId, item.data.remotePath, destPath, runAs);
      } else {
        await this.service.copyFile(deviceId, item.data.remotePath, destPath, runAs);
      }
      this.onDidChangeTreeDataEmitter.fire(undefined);
    } catch (err: any) {
      const msg = mode === "move"
        ? vscode.l10n.t("Move failed: {0}", err?.message || String(err))
        : vscode.l10n.t("Copy failed: {0}", err?.message || String(err));
      vscode.window.showErrorMessage(msg);
    }
  }

  async revealInExplorer(item: FileExplorerItem): Promise<void> {
    if (!item?.data?.deviceId || !item?.data?.remotePath) { return; }

    // Check if this file has been opened/cached locally
    const hash = crypto.createHash("md5").update(item.data.deviceId + ":" + item.data.remotePath).digest("hex").slice(0, 8);
    const tmpDir = path.join(this.tmpRoot, hash);
    const fileName = item.data.entry?.name || path.posix.basename(item.data.remotePath);
    const localPath = path.join(tmpDir, fileName);

    if (!fs.existsSync(localPath)) {
      // Download first
      const runAs = item.data.packageName || item.data.entry?.packageName;
      try {
        fs.mkdirSync(tmpDir, { recursive: true });
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Downloading...") },
          async () => {
            await this.service.pullFile(item.data.deviceId, item.data.remotePath, localPath, runAs);
          }
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(vscode.l10n.t("Download failed: {0}", err?.message || String(err)));
        return;
      }
    }
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(localPath));
  }

  private cleanExpiredCache(): void {
    const days = vscode.workspace.getConfiguration("native-runner").get<number>("explorerCacheDays", 7);
    if (days <= 0 || !fs.existsSync(this.tmpRoot)) { return; }
    const now = Date.now();
    const maxAge = days * 24 * 60 * 60 * 1000;
    let cleaned = false;
    try {
      for (const dir of fs.readdirSync(this.tmpRoot)) {
        if (dir.startsWith("_")) { continue; } // skip _mappings.json etc.
        const dirPath = path.join(this.tmpRoot, dir);
        const stat = fs.statSync(dirPath);
        if (stat.isDirectory() && (now - stat.mtimeMs) > maxAge) {
          // Remove corresponding mappings
          for (const [key, info] of this.openedFiles) {
            if (normalizeKey(info.localPath).startsWith(normalizeKey(dirPath))) {
              this.unwatchFile(key);
              cleaned = true;
            }
          }
          fs.rmSync(dirPath, { recursive: true, force: true });
        }
      }
    } catch { /* ignore */ }
    if (cleaned) { this.saveMappings(); }
  }

  async clearCache(): Promise<void> {
    const size = this.getCacheSize();
    const sizeStr = formatSize(size);

    const confirm = await vscode.window.showWarningMessage(
      vscode.l10n.t("Clear all cached files? ({0})", sizeStr),
      { modal: true },
      vscode.l10n.t("Clear")
    );
    if (!confirm) { return; }

    // Collect directories that have files actually open in editor tabs (skip these)
    const openDirs = new Set<string>();
    for (const tabGroup of vscode.window.tabGroups.all) {
      for (const tab of tabGroup.tabs) {
        const input = tab.input;
        if (input && typeof input === "object" && "uri" in input) {
          const uri = (input as { uri: vscode.Uri }).uri;
          if (uri.scheme === "file") {
            const filePath = uri.fsPath;
            const relative = path.relative(this.tmpRoot, filePath);
            if (relative && !relative.startsWith("..")) {
              const topDir = relative.split(path.sep)[0];
              if (topDir) { openDirs.add(topDir); }
            }
          }
        }
      }
    }

    // Stop watchers for files that will be deleted (not in open tabs)
    const keysToRemove: string[] = [];
    for (const [key, info] of this.openedFiles) {
      const dir = path.dirname(info.localPath);
      const relative = path.relative(this.tmpRoot, dir).split(path.sep)[0];
      if (relative && !openDirs.has(relative)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      this.unwatchFile(key);
    }

    // Delete cache subdirectories, skipping open file dirs
    let cleared = 0;
    if (fs.existsSync(this.tmpRoot)) {
      try {
        for (const dir of fs.readdirSync(this.tmpRoot)) {
          if (dir.startsWith("_")) { continue; }
          if (openDirs.has(dir)) { continue; } // skip — file is open in editor
          const dirPath = path.join(this.tmpRoot, dir);
          const stat = fs.statSync(dirPath);
          if (stat.isDirectory()) {
            fs.rmSync(dirPath, { recursive: true, force: true });
            cleared++;
          }
        }
      } catch { /* ignore */ }
    }

    if (openDirs.size > 0) {
      vscode.window.showInformationMessage(
        vscode.l10n.t("Cache cleared. {0} file(s) in use were skipped.", openDirs.size)
      );
    } else {
      vscode.window.showInformationMessage(vscode.l10n.t("Cache cleared ({0})", sizeStr));
    }
  }

  getCacheSizeFormatted(): string {
    return formatSize(this.getCacheSize());
  }

  private getCacheSize(): number {
    if (!fs.existsSync(this.tmpRoot)) { return 0; }
    let total = 0;
    const walk = (dir: string) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(p);
          } else {
            total += fs.statSync(p).size;
          }
        }
      } catch { /* ignore */ }
    };
    walk(this.tmpRoot);
    return total;
  }

  dispose(): void {
    for (const timer of this.pushDebounceTimers.values()) { clearTimeout(timer); }
    this.pushDebounceTimers.clear();
    for (const watcher of this.fileWatchers.values()) { watcher.close(); }
    this.fileWatchers.clear();
    this.openedFiles.clear();
    this.onDidChangeTreeDataEmitter.dispose();
    for (const d of this.disposables) { d.dispose(); }
  }
}

// --- Helpers ---

function formatSize(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
  if (bytes < 1024 * 1024 * 1024) { return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
