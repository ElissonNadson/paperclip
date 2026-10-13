import { describe, expect, it } from "vitest";
import { forbidden } from "../errors.js";
import { canIsolateRemoteWorkspaceSource, recordedIsolatedRemoteSource } from "./isolated-remote-workspace-source.js";

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

describe("recorded isolated source identity", () => {
  const workspace = { companyId: "company", sourceIssueId: "task", repoUrl: allowed.repoUrl,
    metadata: { isolatedRemoteSource: { schema: "paperclip.isolated-remote-source.v1", companyId: "company", issueId: "task", repoUrl: allowed.repoUrl } } };
  it("keeps ordinary workspace sources unchanged", () => {
    expect(recordedIsolatedRemoteSource({ ...workspace, metadata: null })).toBeNull();
  });
  it.each([{ companyId: "other-company" }, { sourceIssueId: "other-task" }, { repoUrl: "https://example.test/other" },
    { metadata: { isolatedRemoteSource: { schema: "unknown" } } },
  ])("rejects a changed source binding: %j", patch => {
    expect(() => recordedIsolatedRemoteSource({ ...workspace, ...patch })).toThrow("source identity changed");
  });
});
