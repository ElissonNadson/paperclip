import path from "node:path";
import fs from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { TaskWorkspaceIntent } from "@paperclipai/shared";
import type { GitRemoteAuthProvider } from "./git-credentials.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { materializeManagedProjectWorkspace } from "./managed-repository-checkout.js";

const execFile = promisify(execFileCallback);

export function isolatedRemoteSourcePath(companyId: string, issueId: string): string {
  if ([companyId, issueId].some(id => !/^[a-zA-Z0-9_-]+$/.test(id))) {
    throw new Error("Invalid isolated repository source identity");
  }
  return path.join(resolvePaperclipInstanceRoot(), "isolated-repository-sources", companyId, issueId, "checkout");
}

export function canIsolateRemoteWorkspaceSource(input: {
  error: unknown;
  repoUrl: string | null;
  reuseExisting: boolean;
  hasExistingWorkspace: boolean;
  selection: TaskWorkspaceIntent | null | undefined;
  strategy: Record<string, unknown>;
}): boolean {
  const error = input.error as { status?: unknown; message?: unknown } | null;
  if (error?.status !== 403 || error.message !== "Task workspace access is no longer available"
    || input.reuseExisting || input.hasExistingWorkspace || input.strategy.existingBranch
    || (input.selection && !["project", "task_default", "legacy"].includes(input.selection.source))) return false;
  if (!input.repoUrl) return false;
  try {
    const url = new URL(input.repoUrl);
    return ["https:", "ssh:"].includes(url.protocol) && !!url.hostname && !url.password
      && (url.protocol === "ssh:" || !url.username);
  } catch { return false; }
}

export async function materializeIsolatedRemoteWorkspaceSource(input: {
  companyId: string;
  issueId: string;
  repoUrl: string;
  resolveGitAuth: GitRemoteAuthProvider;
}): Promise<string> {
  const cwd = isolatedRemoteSourcePath(input.companyId, input.issueId);
  const root = resolvePaperclipInstanceRoot();
  await fs.mkdir(root, { recursive: true });
  const canonicalRoot = await fs.realpath(root);
  let parent = canonicalRoot;
  for (const segment of ["isolated-repository-sources", input.companyId, input.issueId]) {
    parent = path.join(parent, segment);
    await fs.mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const entry = await fs.lstat(parent);
    if (!entry.isDirectory() || entry.isSymbolicLink() || await fs.realpath(parent) !== parent) {
      throw new Error("Isolated repository source path is not a private directory");
    }
  }
  const canonicalCwd = path.join(parent, "checkout");
  const entry = await fs.lstat(canonicalCwd).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error("Isolated repository source cannot be a symbolic link");
  }
  const result = await materializeManagedProjectWorkspace(canonicalCwd, {
    repoUrl: input.repoUrl, resolveGitAuth: input.resolveGitAuth,
  });
  if (result.warning) throw new Error("Isolated repository source is not a Git checkout");
  const origin = await execFile("git", ["-C", canonicalCwd, "config", "--local", "--null", "--get-all", "remote.origin.url"], {
    timeout: 10_000, maxBuffer: 16 * 1024,
  });
  if (origin.stdout !== `${input.repoUrl}\0`) throw new Error("Isolated repository source identity changed");
  return cwd;
}
