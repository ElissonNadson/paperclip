import type { QueryClient } from '@tanstack/react-query';
import type { ProjectSkillRepository, RoutineRunSummary, Issue } from '@paperclipai/shared';
import { buildSkillMentionHref } from '@paperclipai/shared';
import { skillSourcesApi } from '@/api/skillSources';
import { companySkillsApi } from '@/api/companySkills';
import { projectsApi } from '@/api/projects';
import { routinesApi } from '@/api/routines';
import { issuesApi } from '@/api/issues';
import { queryKeys } from '@/lib/queryKeys';
import { baseRoutine } from '../../fixtures/routineWebhooks';
import { storybookProjects, storybookIssues } from '../../fixtures/paperclipData';
import { COMPANY_ID, SOURCE_ID, COMMIT, installFixtures, candidates, sourceFixture } from '../../fixtures/githubSkillSources';

export type Scenario = 'new-project' | 'legacy' | 'ready' | 'refreshing' | 'error' | 'empty' | 'private' | 'shared' | 'shared-private' | 'long' | 'many' | 'paused' | 'removed' | 'validation' | 'repair' | 'automatic' | 'latest';
export const projectRepository: ProjectSkillRepository = {
  projectId: 'project-skills', projectName: 'Acme platform', projectVisibility: 'open',
  workspaceId: 'workspace-skills', repositoryUrl: 'https://github.com/acme/team-skills', trackingRef: 'main',
  bindingId: null, sourceId: null, status: 'available', lastError: null,
};
export const ROUTINE_ID = 'routine-project-skills';
const NEW_COMMIT = 'b'.repeat(40);

/** All mutations are scoped in-memory API fixtures. No provider calls or server writes. */
export function installProjectSkillFixtures(scenario: Scenario, client: QueryClient) {
  const cleanup = installFixtures(['new-project', 'legacy'].includes(scenario), false, { journey: true });
  const baseSources = { ...skillSourcesApi }, baseSkills = { ...companySkillsApi };
  const originalProjects = { ...projectsApi }, originalRoutines = { ...routinesApi }, originalIssues = { ...issuesApi };
  const timers: ReturnType<typeof setTimeout>[] = [];
  let live = true, automaticUpdates = scenario !== 'paused', updated = false, failed = ['error', 'repair'].includes(scenario);
  const privateProject = scenario === 'private';
  let repository = { ...projectRepository, projectVisibility: privateProject ? 'private' as const : 'open' as const };
  if (!['new-project', 'legacy'].includes(scenario)) repository = { ...repository, sourceId: SOURCE_ID, bindingId: 'binding-skills', status: 'ready' };
  let project = { ...storybookProjects[0]!, id: repository.projectId, name: repository.projectName, companyId: COMPANY_ID,
    workspaces: storybookProjects[0]!.workspaces.slice(0, 1).map(workspace => ({ ...workspace, id: repository.workspaceId, projectId: repository.projectId, repoUrl: repository.repositoryUrl, repoRef: 'main', defaultRef: 'main', name: 'acme/team-skills' })) };
  const invalidate = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.skillSources.all(COMPANY_ID) }),
      client.invalidateQueries({ queryKey: queryKeys.companySkills.list(COMPANY_ID) }),
      client.invalidateQueries({ queryKey: ['project-skill-repositories', COMPANY_ID] }),
      client.invalidateQueries({ queryKey: queryKeys.routines.detail(ROUTINE_ID) }),
    ]);
  };
  const delay = (ms: number) => new Promise<void>(resolve => timers.push(setTimeout(resolve, ms)));
  const available = () => candidates.filter(candidate => !candidate.error && !candidate.path.startsWith('experimental/')).map(candidate => candidate.path);
  async function adopt() {
    repository = { ...repository, status: 'pending', bindingId: 'binding-skills' };
    await invalidate(); await delay(600);
    if (!live) return;
    await baseSources.create(COMPANY_ID, { repositoryUrl: repository.repositoryUrl, trackingRef: 'main',
      commitSha: COMMIT, connectionId: 'github-storybook', packageMode: 'repository', selectedPaths: available(), excludedFolders: ['experimental'] });
    repository = { ...repository, sourceId: SOURCE_ID, status: 'ready' };
    await invalidate();
  }
  async function refresh() {
    await delay(450);
    if (failed) { failed = false; throw new Error('GitHub could not be reached. The installed skills were kept. Try again.'); }
    const result = await baseSources.refresh(COMPANY_ID, SOURCE_ID);
    await baseSources.select(COMPANY_ID, SOURCE_ID, { revision: result.source.revision, selectedPaths: available(), excludedFolders: ['experimental'] });
    updated = true;
    return { ...result, source: (await skillSourcesApi.list(COMPANY_ID))[0]! };
  }
  skillSourcesApi.list = async companyId => (await baseSources.list(companyId)).map(source => ({ ...source,
    automaticUpdates, importNewSkills: true, accessScope: 'projects',
    syncState: scenario === 'refreshing' ? 'refreshing' : failed ? 'error' : automaticUpdates ? 'ready' : 'paused',
    fullName: scenario === 'long' ? 'acme/platform-services-production-web-accessibility-improvements' : source.fullName,
    lastScanCommit: updated ? NEW_COMMIT : source.lastScanCommit,
    lastError: failed ? scenario === 'repair' ? 'The person who connected this source no longer has company access. Choose another GitHub connection.'
      : 'GitHub could not be reached. The installed skills were kept.' : null,
    projects: ['shared', 'shared-private'].includes(scenario) ? [{ id: project.id, name: 'Private research', visibility: 'private', active: true },
      { id: 'project-open', name: 'Engineering', visibility: scenario === 'shared' ? 'open' : 'private', active: true }]
      : [{ id: project.id, name: project.name, visibility: repository.projectVisibility, active: true }],
    entries: scenario === 'empty' ? [] : scenario === 'many' ? Array.from({ length: 80 }, (_, index) => ({
      ...source.entries[0]!, id: 'entry-' + index, name: 'Project workflow ' + (index + 1), skillId: 'skill-' + index,
    })) : source.entries.map((entry, index) => index === 1 && scenario === 'removed' ? { ...entry, present: false }
      : index === 1 && scenario === 'validation' ? { ...entry, error: 'SKILL.md contains an invalid package reference. The installed version was kept.' } : entry),
  }));
  skillSourcesApi.projectRepositories = async () => scenario === 'new-project' && !repository.bindingId ? [] : [structuredClone(repository)];
  skillSourcesApi.adoptProject = async () => { await adopt(); return { bindingId: 'binding-skills' }; };
  skillSourcesApi.refresh = refresh;
  skillSourcesApi.settings = async (_companyId, _id, input) => {
    automaticUpdates = input.automaticUpdates ?? automaticUpdates;
    if (input.connectionId !== undefined) failed = false;
    return (await skillSourcesApi.list(COMPANY_ID))[0]!;
  };
  companySkillsApi.detail = async (companyId, id) => {
    const skill = await baseSkills.detail(companyId, id);
    return { ...skill, accessSourceId: SOURCE_ID, sourceRef: updated ? NEW_COMMIT : skill.sourceRef,
      markdown: updated ? `${skill.markdown}\nCheck the project access before publishing results.\n` : skill.markdown,
      currentVersionId: updated ? `${skill.currentVersionId}-updated` : skill.currentVersionId };
  };
  projectsApi.repositoryOptions = baseSources.repositories;
  projectsApi.get = async () => structuredClone(project);
  projectsApi.list = async () => scenario === 'new-project' && !repository.bindingId ? [] : [structuredClone(project)];
  projectsApi.create = async (_companyId, input) => {
    project = { ...project, name: String(input.name) };
    repository = { ...repository, projectName: project.name, bindingId: 'binding-skills', status: 'pending' };
    void adopt();
    return structuredClone(project);
  };
  const skillId = sourceFixture().entries[1]!.skillId!;
  let routine = { ...baseRoutine, id: ROUTINE_ID, title: 'Review project changes', projectId: project.id,
    project: { id: project.id, name: project.name, description: null, status: 'in_progress' },
    description: `Use [/code-review](${buildSkillMentionHref(skillId, 'code-review')}) to review the project changes and report your findings.`, triggers: [], recentRuns: [] as RoutineRunSummary[] };
  let executionIssues: Issue[] = [storybookIssues[0]!].map(issue => ({ ...issue, id: 'project-review-before', projectId: project.id,
    originKind: 'routine_execution' as const, originId: ROUTINE_ID, title: 'Review project changes', status: 'done' as const,
    description: 'Completed using the installed code review checklist.' }));
  routinesApi.get = async () => structuredClone(routine);
  routinesApi.list = async () => [structuredClone({ ...routine, lastRun: routine.recentRuns[0] ?? null })];
  routinesApi.listRuns = async () => structuredClone(routine.recentRuns);
  routinesApi.activity = async () => [];
  routinesApi.listRevisions = async () => [];
  routinesApi.update = async (_id, input) => (routine = { ...routine, ...input });
  routinesApi.run = async () => {
    const now = new Date();
    const run: RoutineRunSummary = { id: `review-run-${routine.recentRuns.length}`, companyId: COMPANY_ID, routineId: ROUTINE_ID,
      triggerId: null, source: 'manual', status: 'completed', idempotencyKey: null, triggerPayload: null, dispatchFingerprint: null,
      linkedIssueId: 'project-review-after', coalescedIntoRunId: null, failureReason: null, triggeredAt: now, completedAt: now, createdAt: now, updatedAt: now,
      trigger: null, linkedIssue: { id: 'project-review-after', identifier: 'PAP-124', title: 'Review project changes', status: 'done', priority: 'medium', updatedAt: now } };
    routine = { ...routine, recentRuns: [run, ...routine.recentRuns] };
    executionIssues = [{ ...executionIssues[0]!, id: 'project-review-after', identifier: 'PAP-124', description: updated ? 'Completed using the updated code review checklist.' : 'Completed using the installed code review checklist.' }, ...executionIssues];
    return run;
  };
  const originalList = originalIssues.list, originalCompact = originalIssues.listCompact;
  issuesApi.get = async (id, options) => {
    const issue = executionIssues.find(candidate => candidate.id === id || candidate.identifier === id);
    return issue ? structuredClone(issue) : originalIssues.get(id, options);
  };
  issuesApi.list = async (companyId, filters) => filters?.originId === ROUTINE_ID ? structuredClone(executionIssues) : originalList(companyId, filters);
  issuesApi.listCompact = async (companyId, filters, options) => filters?.originId === ROUTINE_ID ? structuredClone(executionIssues.map(issue => ({ ...issue, activeRecoveryAction: null, successfulRunHandoff: null }))) : originalCompact(companyId, filters, options);
  if (scenario === 'automatic') timers.push(setTimeout(() => { if (live) void refresh().then(invalidate); }, 1800));
  return () => {
    live = false; timers.forEach(clearTimeout);
    Object.assign(projectsApi, originalProjects); Object.assign(routinesApi, originalRoutines); Object.assign(issuesApi, originalIssues);
    cleanup();
  };
}
