import * as path from "path";
import { AndroidProvider } from "./androidProvider";

export interface RemoteFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size?: number;
  date?: string;
  permissions?: string;
  isRunAs: boolean;
  packageName?: string;
  isError?: boolean;
}

export class FileExplorerService {
  constructor(private provider: AndroidProvider) {}

  async listDirectory(deviceId: string, remotePath: string, runAsPackage?: string): Promise<RemoteFileEntry[]> {
    try {
      const output = runAsPackage
        ? await this.provider.runAsListFiles(deviceId, runAsPackage, remotePath)
        : await this.provider.listFiles(deviceId, remotePath);
      return this.parseLsOutput(output, remotePath, !!runAsPackage, runAsPackage);
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes("Permission denied")) {
        return [{ name: "Permission denied", path: remotePath, isDirectory: false, isSymlink: false, isRunAs: !!runAsPackage, isError: true }];
      }
      if (msg.includes("No such file")) {
        return [];
      }
      if (msg.includes("not debuggable") || msg.includes("not an application") || msg.includes("Unknown package")) {
        return [{ name: msg.split(":").pop()?.trim() || "Not debuggable", path: remotePath, isDirectory: false, isSymlink: false, isRunAs: !!runAsPackage, isError: true }];
      }
      return [{ name: msg.substring(0, 100), path: remotePath, isDirectory: false, isSymlink: false, isRunAs: !!runAsPackage, isError: true }];
    }
  }

  async listPackages(deviceId: string): Promise<string[]> {
    try {
      return await this.provider.listPackages(deviceId);
    } catch {
      return [];
    }
  }

  async pullFile(deviceId: string, remotePath: string, localPath: string, runAsPackage?: string): Promise<void> {
    if (runAsPackage) {
      await this.provider.runAsPullFile(deviceId, runAsPackage, remotePath, localPath);
    } else {
      await this.provider.pullFile(deviceId, remotePath, localPath);
    }
  }

  async pushFile(deviceId: string, localPath: string, remotePath: string, runAsPackage?: string): Promise<void> {
    if (runAsPackage) {
      await this.provider.runAsPushFile(deviceId, runAsPackage, localPath, remotePath);
    } else {
      await this.provider.pushFile(deviceId, localPath, remotePath);
    }
  }

  async deleteFile(deviceId: string, remotePath: string, runAsPackage?: string): Promise<void> {
    if (runAsPackage) {
      await this.provider.runAsDeleteFile(deviceId, runAsPackage, remotePath);
    } else {
      await this.provider.deleteFile(deviceId, remotePath);
    }
  }

  async makeDirectory(deviceId: string, remotePath: string, runAsPackage?: string): Promise<void> {
    if (runAsPackage) {
      await this.provider.runAsMakeDirectory(deviceId, runAsPackage, remotePath);
    } else {
      await this.provider.makeDirectory(deviceId, remotePath);
    }
  }

  async renameFile(deviceId: string, oldPath: string, newPath: string, runAsPackage?: string): Promise<void> {
    if (runAsPackage) {
      await this.provider.runAsRenameFile(deviceId, runAsPackage, oldPath, newPath);
    } else {
      await this.provider.renameFile(deviceId, oldPath, newPath);
    }
  }

  async moveFile(deviceId: string, srcPath: string, destPath: string, runAsPackage?: string): Promise<void> {
    if (runAsPackage) {
      await this.provider.runAsMoveFile(deviceId, runAsPackage, srcPath, destPath);
    } else {
      await this.provider.moveFile(deviceId, srcPath, destPath);
    }
  }

  async copyFile(deviceId: string, srcPath: string, destPath: string, runAsPackage?: string): Promise<void> {
    if (runAsPackage) {
      await this.provider.runAsCopyFile(deviceId, runAsPackage, srcPath, destPath);
    } else {
      await this.provider.copyFile(deviceId, srcPath, destPath);
    }
  }

  async touchFile(deviceId: string, remotePath: string, runAsPackage?: string): Promise<void> {
    if (runAsPackage) {
      await this.provider.runAsTouchFile(deviceId, runAsPackage, remotePath);
    } else {
      await this.provider.touchFile(deviceId, remotePath);
    }
  }

  parseLsOutput(output: string, parentPath: string, isRunAs: boolean, packageName?: string): RemoteFileEntry[] {
    const entries: RemoteFileEntry[] = [];
    for (const line of output.split("\n")) {
      const entry = this.parseLsLine(line.trim(), parentPath, isRunAs, packageName);
      if (entry) { entries.push(entry); }
    }
    // Sort: directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) { return a.isDirectory ? -1 : 1; }
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  private parseLsLine(line: string, parentPath: string, isRunAs: boolean, packageName?: string): RemoteFileEntry | undefined {
    if (!line || line.startsWith("total")) { return undefined; }

    // Error messages
    if (line.includes("Permission denied") || line.includes("not debuggable") || line.includes("not an application")) {
      return { name: line, path: parentPath, isDirectory: false, isSymlink: false, isRunAs, packageName, isError: true };
    }

    const typeChar = line[0];
    if (typeChar !== "d" && typeChar !== "-" && typeChar !== "l" && typeChar !== "c" && typeChar !== "b") {
      return undefined;
    }

    // ls -la format: permissions links owner group size date time name [-> target]
    // Example: drwxr-xr-x  2 root root  4096 2026-03-19 10:30 Downloads
    // Some Android versions: drwxr-xr-x root root 4096 2026-03-19 10:30 Downloads (no link count)
    const parts = line.split(/\s+/);
    if (parts.length < 7) { return undefined; }

    const permissions = parts[0];
    const isDirectory = typeChar === "d";
    const isSymlink = typeChar === "l";

    // Find the name: it's after the date+time fields
    // Look for date pattern YYYY-MM-DD HH:MM in parts
    let nameStartIndex = -1;
    for (let i = 3; i < parts.length - 1; i++) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(parts[i]) && /^\d{2}:\d{2}$/.test(parts[i + 1])) {
        nameStartIndex = i + 2;
        break;
      }
    }

    if (nameStartIndex < 0 || nameStartIndex >= parts.length) {
      // Fallback: use last token as name
      const name = parts[parts.length - 1];
      if (name === "." || name === "..") { return undefined; }
      return {
        name, path: path.posix.join(parentPath, name),
        isDirectory, isSymlink, permissions, isRunAs, packageName,
      };
    }

    // Handle symlinks: "name -> target"
    const remaining = parts.slice(nameStartIndex).join(" ");
    let name: string;
    if (isSymlink && remaining.includes(" -> ")) {
      name = remaining.split(" -> ")[0];
    } else {
      name = remaining;
    }

    if (name === "." || name === "..") { return undefined; }

    // Extract size and date
    let size: number | undefined;
    let date: string | undefined;
    for (let i = 3; i < nameStartIndex; i++) {
      if (/^\d+$/.test(parts[i]) && !parts[i].match(/^\d{4}-/)) {
        size = parseInt(parts[i], 10);
      }
    }
    for (let i = 3; i < parts.length - 1; i++) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(parts[i])) {
        date = `${parts[i]} ${parts[i + 1]}`;
        break;
      }
    }

    return {
      name,
      path: path.posix.join(parentPath, name),
      isDirectory,
      isSymlink,
      size,
      date,
      permissions,
      isRunAs,
      packageName,
    };
  }
}
