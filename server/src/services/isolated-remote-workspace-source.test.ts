import { describe, expect, it } from "vitest";
import { forbidden } from "../errors.js";
import { canIsolateRemoteWorkspaceSource } from "./isolated-remote-workspace-source.js";

const allowed = {
  error: forbidden("Task workspace access is no longer available"),
  repoUrl: "https://example.test/company/repository.git",
  reuseExisting: false,
  hasExistingWorkspace: false,
  selection: null,
  strategy: { type: "git_worktree" },
  trustPresetKind: "standard",
};

describe("isolated remote source admission", () => {
  it("allows a fresh default remote source after a workspace privacy denial", () => {
    expect(canIsolateRemoteWorkspaceSource(allowed)).toBe(true);
  });

  it.each([
    { reuseExisting: true },
    { hasExistingWorkspace: true },
    { strategy: { type: "git_worktree", existingBranch: "unpublished-work" } },
    { error: forbidden("Project access denied") },
    { error: new Error("Task workspace access is no longer available") },
    { repoUrl: "file:///private/source" },
    { repoUrl: "/private/source" },
    { repoUrl: "https://user:password@example.test/repo" },
    { repoUrl: null },
    { trustPresetKind: "low_trust_review" },
    { trustPresetKind: "denied" },
    { trustPresetKind: "unknown" },
  ])("preserves the original denial for %j", patch => {
    expect(canIsolateRemoteWorkspaceSource({ ...allowed, ...patch })).toBe(false);
  });

  it.each(["explicit", "parent", "channel", "operator_cwd"] as const)("preserves %s source intent", source => {
    expect(canIsolateRemoteWorkspaceSource({ ...allowed, selection: {
      version: 1, source, selection: { kind: "configured_source", projectWorkspaceId: "source", mode: "managed_isolated" },
    } })).toBe(false);
  });
});
