import { and, eq, ne } from 'drizzle-orm';
import { projectSkillSources, type Db, projectWorkspaces } from '@paperclipai/db';
import { parseGitHubSkillRepositoryUrl } from '@paperclipai/shared';
import { currentSkillActor } from './skill-access.js';
import { captureRunIdentity } from './run-identity.js';
import { forbidden } from '../errors.js';

export async function projectSkillSetupIdentity(db: Db, companyId: string, actor = currentSkillActor()) {
  let userId = actor?.type === 'board' ? actor.userId ?? null : null;
  if (actor?.type === 'agent' && actor.source === 'agent_jwt') {
    if (!actor.runId || !actor.agentId || actor.companyId !== companyId) throw forbidden('Project skill setup requires an authenticated agent run.');
    const identity = await captureRunIdentity(db, { companyId, agentId: actor.agentId, runId: actor.runId });
    userId = identity.run.responsibleUserId;
  }
  // An API key can attach repositories, but cannot supply a setup person.
  // Keep the durable job so an authorized person can adopt it from Sources.
  return { refreshUserId: userId, refreshAgentId: actor?.type === 'agent' ? actor.agentId ?? null : null,
    refreshLocalTrusted: actor?.source === 'local_implicit' || userId === 'local-board' };
}

export function projectSkillRepository(workspace: Pick<typeof projectWorkspaces.$inferSelect, 'repoUrl' | 'defaultRef' | 'repoRef'>) {
  const url = workspace.repoUrl?.replace(/^git@github\.com:/i, 'https://github.com/');
  const parsed = url ? parseGitHubSkillRepositoryUrl(url) : null;
  if (!parsed) return null;
  return { repositoryUrl: parsed.repositoryUrl.toLowerCase(), trackingRef: workspace.defaultRef ?? workspace.repoRef ?? parsed.trackingRef ?? 'HEAD' };
}

/** Called inside the workspace mutation transaction; no provider calls here. */
export async function enqueueProjectSkillSource(db: Db, workspace: typeof projectWorkspaces.$inferSelect) {
  const repository = projectSkillRepository(workspace);
  await db.update(projectSkillSources).set({ active: false })
    .where(and(eq(projectSkillSources.companyId, workspace.companyId), eq(projectSkillSources.workspaceId, workspace.id),
      ...(repository ? [ne(projectSkillSources.trackingRef, repository.trackingRef)] : [])));
  if (!repository) return null;
  const setup = await projectSkillSetupIdentity(db, workspace.companyId);
  await db.update(projectSkillSources).set({ active: false })
    .where(and(eq(projectSkillSources.companyId, workspace.companyId), eq(projectSkillSources.workspaceId, workspace.id), ne(projectSkillSources.repositoryUrl, repository.repositoryUrl)));
  const [binding] = await db.insert(projectSkillSources).values({
    companyId: workspace.companyId, projectId: workspace.projectId, workspaceId: workspace.id, ...repository, nextSyncAt: new Date(),
    ...setup,
  }).onConflictDoUpdate({ target: [projectSkillSources.workspaceId, projectSkillSources.repositoryUrl, projectSkillSources.trackingRef],
    set: { active: true } }).returning();
  return binding!;
}

export async function detachProjectSkillSource(db: Db, companyId: string, workspaceId: string) {
  await db.update(projectSkillSources).set({ active: false }).where(and(eq(projectSkillSources.companyId, companyId), eq(projectSkillSources.workspaceId, workspaceId)));
}
