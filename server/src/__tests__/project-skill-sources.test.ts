import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agents, authUsers, companies, companyMemberships, companySkillSources, companySkills, createDb, projects,
  projectWorkspaces, projectSkillSources, projectAccessMembers } from '@paperclipai/db';
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from './helpers/embedded-postgres.js';
import { githubFixture } from './helpers/github-skills.js';
import { enqueueProjectSkillSource, detachProjectSkillSource } from '../services/project-skill-source-bindings.js';
import { adoptProjectSkillRepository, projectSkillRepositories, skillSourceSyncService } from '../services/skill-source-sync.js';
import { skillSourceService, type SkillSourceContext } from '../services/skill-sources.js';
import { companySkillService } from '../services/company-skills.js';
import { projectService } from '../services/projects.js';
import { skillAccessService, withSkillActor } from '../services/skill-access.js';
import type { AuthorizationActor } from '../services/authorization.js';
import { unprocessable } from '../errors.js';

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)('automatic project skill sources', () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const oldHome = process.env.PAPERCLIP_HOME;
  const companyId = randomUUID();
  const md = (name: string) => `---\nname: ${name}\ndescription: Test workflow\n---\nFollow the workflow.\n`;
  let files: Record<string, string> = {};
  let commit = 'a'.repeat(40);
  const downloads = vi.fn();
  const context: SkillSourceContext = { actor: { type: 'system' }, setup: { userId: null, localTrusted: true },
    read: () => {
      const fixture = githubFixture(files, {}, commit), open = fixture.openSnapshot;
      fixture.openSnapshot = async (...args) => { downloads(); return open(...args); };
      return fixture;
    }, authorize: async () => {}, audit: async () => {} };
  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase('paperclip-project-skills-');
    db = createDb(testDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-project-skills-home-'));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(companies).values({ id: companyId, name: 'Project skills', issuePrefix: 'PSK' });
  }, 30000);
  afterAll(async () => {
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    await testDb?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });
  async function workspace(ref: string, visibility = 'open') {
    const [project] = await db.insert(projects).values({ companyId, name: ref, visibility }).returning();
    const [row] = await db.insert(projectWorkspaces).values({ companyId, projectId: project!.id, name: ref,
      repoUrl: 'https://github.com/acme/skills', defaultRef: ref }).returning();
    return row!;
  }
  const actor = (userId: string): AuthorizationActor => ({ type: 'board', userId, source: 'session', companyIds: [companyId], ignoreInstanceAdmin: true });

  it('imports after durable enqueue, imports later additions and avoids unchanged downloads', async () => {
    files = { 'one/SKILL.md': md('one') }; commit = 'a'.repeat(40); downloads.mockClear();
    const row = await workspace('automatic');
    const binding = await enqueueProjectSkillSource(db, row);
    await enqueueProjectSkillSource(db, row);
    expect(await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, row.id))).toHaveLength(1);
    expect((await db.select().from(companySkillSources)).filter(source => source.trackingRef === 'automatic')).toHaveLength(0);
    const worker = skillSourceSyncService(db, { context: async () => context });
    expect((await worker.tick()).imported).toBe(1);
    const [ready] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, binding!.id));
    const sourceId = ready!.sourceId!;
    const first = await skillSourceService(db).detail(companyId, sourceId);
    expect(first.accessScope).toBe('projects');
    expect(first.importNewSkills).toBe(true);
    const installedId = first.entries[0]!.skillId!;
    const original = (await companySkillService(db).getById(companyId, installedId))!;
    expect(original.accessSourceId).toBe(sourceId);
    const downloadCount = downloads.mock.calls.length;
    await worker.tick(new Date(Date.now() + 6 * 60_000));
    expect(downloads).toHaveBeenCalledTimes(downloadCount);
    files['one/SKILL.md'] = md('one improved'); files['two/SKILL.md'] = md('two'); commit = 'b'.repeat(40);
    await worker.tick(new Date(Date.now() + 6 * 60_000));
    const updated = await skillSourceService(db).detail(companyId, sourceId);
    expect(updated.entries.filter(entry => entry.skillId)).toHaveLength(2);
    const latest = (await companySkillService(db).getById(companyId, installedId))!;
    expect(latest.id).toBe(original.id);
    expect(latest.currentVersionId).not.toBe(original.currentVersionId);
    const pinned = await companySkillService(db).getVersion(companyId, installedId, original.currentVersionId!);
    expect(pinned!.fileInventory.find(file => file.path === 'SKILL.md')!.content).toBe(md('one'));
    await detachProjectSkillSource(db, companyId, row.id);
    const before = downloads.mock.calls.length;
    await worker.tick(new Date(Date.now() + 6 * 60_000));
    expect(downloads).toHaveBeenCalledTimes(before);
    expect(await companySkillService(db).getById(companyId, installedId)).not.toBeNull();
    expect(await skillSourceService(db).detail(companyId, sourceId)).toMatchObject({ trackingActive: false, syncState: 'paused' });
  });

  it('watches empty repositories, retains folder exclusions and coalesces worker sweeps', async () => {
    files = {}; commit = 'c'.repeat(40);
    const row = await workspace('empty');
    await enqueueProjectSkillSource(db, row);
    const worker = skillSourceSyncService(db, { context: async () => context });
    const first = worker.tick();
    expect(worker.tick()).toBe(first);
    await first;
    const [binding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, row.id));
    expect(binding!.status).toBe('ready');
    const service = skillSourceService(db);
    const source = await service.detail(companyId, binding!.sourceId!);
    await service.refresh(companyId, source.id, context, { revision: source.revision, selectedPaths: [], excludedFolders: ['excluded'] });
    files = { 'excluded/secret/SKILL.md': md('excluded'), 'new/SKILL.md': md('new') }; commit = 'd'.repeat(40);
    await worker.tick(new Date(Date.now() + 6 * 60_000));
    const result = await service.detail(companyId, source.id);
    expect(result.entries.find(entry => entry.path === 'new/SKILL.md')!.skillId).toBeTruthy();
    expect(result.entries.find(entry => entry.path.includes('secret'))!.selection).toBe('excluded');
  });

  it('inherits either project access, rechecks revocation and fails closed after project deletion', async () => {
    files = { 'private/SKILL.md': md('private workflow') }; commit = 'e'.repeat(40);
    const row = await workspace('private', 'private');
    await enqueueProjectSkillSource(db, row);
    await skillSourceSyncService(db, { context: async () => context }).tick();
    const [binding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, row.id));
    expect(binding!.status, binding!.lastError ?? 'initial private binding').toBe('ready');
    const source = await skillSourceService(db).detail(companyId, binding!.sourceId!);
    const skillId = source.entries[0]!.skillId!;
    let privateSnapshotPath = '';
    for (const user of ['alice', 'bob']) {
      await db.insert(authUsers).values({ id: user, name: user, email: `${user}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: 'user', principalId: user, membershipRole: 'member', status: 'active' });
    }
    await db.insert(projectAccessMembers).values({ companyId, projectId: row.projectId, subjectType: 'user', subjectId: 'alice' });
    await withSkillActor(actor('alice'), async () => {
      expect(await companySkillService(db).getById(companyId, skillId)).not.toBeNull();
      expect((await companySkillService(db).list(companyId)).some(skill => skill.id === skillId)).toBe(true);
      const skill = (await companySkillService(db).getById(companyId, skillId))!;
      const [runtime] = await companySkillService(db).listRuntimeSkillEntries(companyId, { onlyKeys: new Set([skill.key]) });
      privateSnapshotPath = runtime!.source;
      await expect(companySkillService(db).importFromSource(companyId, runtime!.source)).rejects.toThrow(/Project-derived skill/);
      const fork = await companySkillService(db).forkSkill(companyId, skillId, { slug: 'private-copy' });
      expect(fork.skill.accessSourceId).toBe(source.id);
      await expect(companySkillService(db).updateSkill(companyId, fork.skill.id, { sharingScope: 'public_link' })).rejects.toThrow(/public link/);
      const copy = await companySkillService(db).createLocalSkill(companyId, { name: 'Private derived copy', forkedFromSkillId: skillId });
      expect(copy.accessSourceId).toBe(source.id);
      await expect(companySkillService(db).createLocalSkill(companyId, { name: 'Unsafe publication', forkedFromSkillId: skillId, sharingScope: 'public_link' })).rejects.toThrow(/public link/);
    });
    await withSkillActor(actor('bob'), async () => {
      await expect(companySkillService(db).importFromSource(companyId, privateSnapshotPath)).rejects.toThrow(/not found/);
      expect(await companySkillService(db).getById(companyId, skillId)).toBeNull();
      expect(await companySkillService(db).readFile(companyId, skillId, 'SKILL.md')).toBeNull();
      expect((await skillSourceService(db).list(companyId)).some(item => item.id === source.id)).toBe(false);
      await expect(skillAccessService(db).assertSkill(companyId, skillId)).rejects.toThrow(/not found/);
    });
    const [reader] = await db.insert(agents).values({ companyId, name: 'Private skill reader', adapterType: 'codex_local', status: 'idle' }).returning();
    const [outsider] = await db.insert(agents).values({ companyId, name: 'Unassigned reader', adapterType: 'codex_local', status: 'idle' }).returning();
    for (const agent of [reader!, outsider!]) await db.insert(companyMemberships).values({ companyId, principalType: 'agent', principalId: agent.id, membershipRole: 'member', status: 'active' });
    await db.insert(projectAccessMembers).values({ companyId, projectId: row.projectId, subjectType: 'agent', subjectId: reader!.id });
    const agentActor = (agentId: string, userId: string): AuthorizationActor => ({
      type: 'agent', source: 'agent_jwt', companyId, agentId, runId: randomUUID(), onBehalfOfUserId: userId,
    });
    await withSkillActor(agentActor(reader!.id, 'alice'), async () => {
      expect(await companySkillService(db).readFile(companyId, skillId, 'SKILL.md')).not.toBeNull();
      const skill = (await companySkillService(db).getById(companyId, skillId))!;
      expect(await companySkillService(db).getVersion(companyId, skillId, skill.currentVersionId!)).not.toBeNull();
      expect((await companySkillService(db).listRuntimeSkillEntries(companyId)).some(entry => entry.key === skill.key)).toBe(true);
    });
    for (const denied of [agentActor(reader!.id, 'bob'), agentActor(outsider!.id, 'alice'), { ...agentActor(reader!.id, 'alice'), companyId: randomUUID() }]) {
      await withSkillActor(denied, async () => {
        expect(await companySkillService(db).readFile(companyId, skillId, 'SKILL.md')).toBeNull();
        expect((await companySkillService(db).listRuntimeSkillEntries(companyId)).some(entry => entry.key.includes('private'))).toBe(false);
      });
    }
    const second = await workspace('private', 'private');
    await db.insert(projectAccessMembers).values({ companyId, projectId: second.projectId, subjectType: 'user', subjectId: 'bob' });
    await enqueueProjectSkillSource(db, second);
    await skillSourceSyncService(db, { context: async () => context }).tick();
    const [linked] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, second.id));
    expect(linked!.status, linked!.lastError ?? 'second project binding').toBe('ready');
    expect(linked!.sourceId).toBe(source.id);
    await withSkillActor(actor('bob'), async () => expect(await companySkillService(db).getById(companyId, skillId)).not.toBeNull());
    await db.delete(projectAccessMembers).where(and(eq(projectAccessMembers.projectId, second.projectId), eq(projectAccessMembers.subjectId, 'bob')));
    await withSkillActor(actor('bob'), async () => expect(await companySkillService(db).getById(companyId, skillId)).toBeNull());
    await db.delete(projects).where(eq(projects.id, row.projectId));
    await db.delete(projects).where(eq(projects.id, second.projectId));
    await withSkillActor(actor('alice'), async () => expect(await companySkillService(db).getById(companyId, skillId)).toBeNull());
    expect((await db.select().from(companySkills).where(eq(companySkills.id, skillId)))[0]!.accessSourceId).toBe(source.id);
  });

  it.each(['copy', 'delete'] as const)('removes project tracking with %s while retaining dynamic copy/fork access', async choice => {
    files = { 'private/SKILL.md': md('retained private workflow') }; commit = '9'.repeat(40);
    const row = await workspace(`removed-${choice}`, 'private');
    await enqueueProjectSkillSource(db, row);
    const worker = skillSourceSyncService(db, { context: async () => context });
    await worker.tick();
    const [binding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, row.id));
    const service = skillSourceService(db), skills = companySkillService(db);
    const source = await service.detail(companyId, binding!.sourceId!);
    const original = (await skills.getById(companyId, source.entries[0]!.skillId!))!;
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: 'Source owner', email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: 'user', principalId: userId, membershipRole: 'member', status: 'active' });
    await db.insert(projectAccessMembers).values({ companyId, projectId: row.projectId, subjectType: 'user', subjectId: userId });
    await withSkillActor(actor(userId), async () => {
      const fork = await skills.forkSkill(companyId, original.id, { slug: `retained-${choice}-fork` });
      const result = await service.disconnect(companyId, source.id, context, { revision: source.revision, skills: choice });
      expect(result).toMatchObject({ copiedCount: choice === 'copy' ? 1 : 0, deletedCount: choice === 'delete' ? 1 : 0 });
      await expect(service.detail(companyId, source.id)).rejects.toThrow(/not found/);
      expect((await service.list(companyId)).some(item => item.id === source.id)).toBe(false);
      expect((await projectSkillRepositories(db, companyId, actor(userId))).find(item => item.workspaceId === row.id)).toMatchObject({ sourceId: null, status: 'available' });
      expect(await skills.getById(companyId, fork.skill.id)).not.toBeNull();
      if (choice === 'copy') {
        expect(await skills.getById(companyId, original.id)).toMatchObject({ sourceType: 'local_path', accessSourceId: source.id });
        expect((await skills.readFile(companyId, original.id, '.paperclip-repository/private/SKILL.md'))?.content).toBe(md('retained private workflow'));
        expect((await skills.readFile(companyId, original.id, 'SKILL.md'))?.content).toContain('.paperclip-repository/private/SKILL.md');
      } else expect(await skills.getById(companyId, original.id)).toBeNull();
      await db.update(companySkillSources).set({ automaticUpdates: false }).where(eq(companySkillSources.companyId, companyId));
      const before = downloads.mock.calls.length;
      await worker.tick(new Date(Date.now() + 6 * 60_000));
      expect(downloads).toHaveBeenCalledTimes(before);
      // Reattachment retains disconnection; adoption is the deliberate restart action.
      await enqueueProjectSkillSource(db, row);
      await worker.tick(new Date(Date.now() + 6 * 60_000));
      expect(downloads).toHaveBeenCalledTimes(before);
      const legacy = await workspace(`removed-${choice}`, 'private');
      await db.insert(projectAccessMembers).values({ companyId, projectId: legacy.projectId, subjectType: 'user', subjectId: userId });
      // This older workspace has no binding/source ID; one explicit adoption must work.
      await adoptProjectSkillRepository(db, companyId, legacy.id, context.authorize);
      await worker.tick(new Date(Date.now() + 6 * 60_000));
      const restored = await service.detail(companyId, source.id);
      expect(restored.enabled).toBe(true);
      expect(restored.lastError).toBeNull();
      expect(restored.entries.filter(entry => entry.skillId)).toHaveLength(1);
      expect(restored.entries[0]!.skillId).not.toBe(original.id);
      if (choice === 'copy') expect(await skills.getById(companyId, original.id)).toMatchObject({ key: original.key, sourceType: 'local_path', currentVersionId: original.currentVersionId });
      await db.delete(projects).where(eq(projects.id, legacy.projectId));
      await db.delete(projectAccessMembers).where(and(eq(projectAccessMembers.projectId, row.projectId), eq(projectAccessMembers.subjectId, userId)));
      expect(await skills.getById(companyId, fork.skill.id)).toBeNull();
      if (choice === 'copy') expect(await skills.getById(companyId, original.id)).toBeNull();
      await db.delete(projects).where(eq(projects.id, row.projectId));
      expect(await skills.getById(companyId, fork.skill.id)).toBeNull();
    });
  });

  it('recovers expired jobs, competes through durable leases and respects failed-refresh backoff', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    files = { 'leased/SKILL.md': md('leased') }; commit = 'f'.repeat(40);
    const row = await workspace('leased');
    const binding = await enqueueProjectSkillSource(db, row);
    await db.update(projectSkillSources).set({ leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(projectSkillSources.id, binding!.id));
    let release!: () => void, scanned!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { scanned = resolve; });
    const blocking: SkillSourceContext = { ...context, read: () => {
      const fixture = context.read(null), open = fixture.openSnapshot!;
      fixture.openSnapshot = async (...args) => { scanned(); await gate; return open(...args); };
      return fixture;
    } };
    const first = skillSourceSyncService(db, { context: async () => blocking }).tick();
    await started;
    expect((await skillSourceSyncService(db, { context: async () => context }).tick()).imported).toBe(0);
    release(); expect((await first).imported).toBe(1);
    const [ready] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, binding!.id));
    const sourceId = ready!.sourceId!;
    const service = skillSourceService(db);
    const original = await service.detail(companyId, sourceId);
    const failure: SkillSourceContext = { ...context, read: () => (async () => {
      throw unprocessable('GitHub request limit reached.', { retryAfterMs: 7_200_000 });
    }) as ReturnType<SkillSourceContext['read']> };
    const failedAt = new Date();
    await db.update(companySkillSources).set({ nextSyncAt: failedAt }).where(eq(companySkillSources.id, sourceId));
    await skillSourceSyncService(db, { context: async () => failure }).tick(failedAt);
    const [failed] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, sourceId));
    expect(failed!.failureCount).toBe(1);
    expect(failed!.nextSyncAt.getTime() - failedAt.getTime()).toBeGreaterThanOrEqual(7_200_000);
    expect((await service.detail(companyId, sourceId)).entries[0]!.skillId).toBe(original.entries[0]!.skillId);
    const retryRead = vi.fn(context.read);
    await skillSourceSyncService(db, { context: async () => ({ ...context, read: retryRead }) })
      .tick(new Date(failedAt.getTime() + 6 * 60_000));
    expect(retryRead).not.toHaveBeenCalled();
    await db.update(companySkillSources).set({ automaticUpdates: false, nextSyncAt: new Date() }).where(eq(companySkillSources.id, sourceId));
    await skillSourceSyncService(db, { context: async () => ({ ...context, read: retryRead }) }).tick();
    expect(retryRead).not.toHaveBeenCalled();
  });

  it('skips live leases before bounding import and refresh batches', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    files = { 'fair/SKILL.md': md('fair') }; commit = '9'.repeat(40);
    const now = new Date();
    const expires = new Date(now.getTime() + 60 * 60_000);
    const busyJobs: string[] = [];
    for (let index = 0; index < 10; index++) {
      const row = await workspace(`busy-import-${index}`);
      const binding = await enqueueProjectSkillSource(db, row);
      busyJobs.push(binding!.id);
      await db.update(projectSkillSources).set({ leaseToken: randomUUID(), leaseExpiresAt: expires,
        nextSyncAt: new Date(now.getTime() - (20 - index) * 1_000) }).where(eq(projectSkillSources.id, binding!.id));
    }
    const ready = await enqueueProjectSkillSource(db, await workspace('ready-import'));
    await db.update(projectSkillSources).set({ nextSyncAt: now }).where(eq(projectSkillSources.id, ready!.id));
    const worker = skillSourceSyncService(db, { context: async () => context });
    expect((await worker.tick(now)).imported).toBe(1);
    const [imported] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, ready!.id));
    expect(imported!.sourceId).toBeTruthy();
    for (const id of busyJobs) {
      const [job] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, id));
      expect(job).toMatchObject({ sourceId: null, leaseExpiresAt: expires, status: 'pending' });
    }

    const [template] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, imported!.sourceId!));
    await db.update(companySkillSources).set({ automaticUpdates: false });
    const readySourceId = randomUUID();
    await db.insert(companySkillSources).values(Array.from({ length: 11 }, (_, index) => ({
      ...template!, id: index === 10 ? readySourceId : randomUUID(), trackingRef: `fair-refresh-${index}`,
      accessScope: 'company' as const, automaticUpdates: true, nextSyncAt: new Date(now.getTime() - (20 - index) * 1_000),
      leaseToken: index === 10 ? null : randomUUID(), leaseExpiresAt: index === 10 ? null : expires,
    })));
    expect((await worker.tick(now)).checked).toBe(1);
    const [refreshed] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, readySourceId));
    expect(refreshed!.nextSyncAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it('releases interrupted initial imports so a new worker can recover them', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    files = { 'recovered/SKILL.md': md('recovered') }; commit = '1'.repeat(40);
    const row = await workspace('restart');
    const binding = await enqueueProjectSkillSource(db, row);
    let scanned!: () => void;
    const started = new Promise<void>(resolve => { scanned = resolve; });
    const blocking: SkillSourceContext = { ...context, read: () => {
      const fixture = context.read(null);
      fixture.openSnapshot = async (_input, options) => {
        scanned();
        await new Promise<void>((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
        });
        throw new Error('Unreachable');
      };
      return fixture;
    } };
    const worker = skillSourceSyncService(db, { context: async () => blocking });
    const sweep = worker.tick();
    await started;
    await worker.stop();
    await sweep;
    const [interrupted] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, binding!.id));
    expect(interrupted).toMatchObject({ status: 'pending', failureCount: 0, sourceId: null, leaseToken: null, lastError: null });
    expect((await skillSourceSyncService(db, { context: async () => context }).tick()).imported).toBe(1);
  });

  it('keeps deleted setup agents attributable and requires explicit connection repair', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    files = { 'owned/SKILL.md': md('owned') }; commit = '2'.repeat(40);
    const row = await workspace('deleted-owner');
    const [owner] = await db.insert(agents).values({ companyId, name: 'Source setup agent', adapterType: 'codex_local', status: 'idle' }).returning();
    await enqueueProjectSkillSource(db, row);
    const ownerContext: SkillSourceContext = { ...context, setup: { userId: 'local-board', localTrusted: true, agentId: owner!.id } };
    await skillSourceSyncService(db, { context: async () => ownerContext }).tick();
    const [binding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, row.id));
    const sourceId = binding!.sourceId!;
    await db.delete(agents).where(eq(agents.id, owner!.id));
    await db.update(companySkillSources).set({ nextSyncAt: new Date() }).where(eq(companySkillSources.id, sourceId));
    const [before] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, sourceId));
    expect(before!.refreshAgentId).toBe(owner!.id);
    await skillSourceSyncService(db).tick();
    const [failed] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, sourceId));
    expect(failed!.lastError).toContain('agent who connected');
    expect(failed!.failureCount).toBe(1);
    expect((await skillSourceService(db).detail(companyId, sourceId)).entries[0]!.skillId).toBeTruthy();
  });

  it('backs off a policy denial before acquiring a source lease', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    files = { 'policy/SKILL.md': md('policy') }; commit = '3'.repeat(40);
    const row = await workspace('policy-denial');
    await enqueueProjectSkillSource(db, row);
    await skillSourceSyncService(db, { context: async () => context }).tick();
    const [binding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, row.id));
    const now = new Date();
    await db.update(companySkillSources).set({ nextSyncAt: now }).where(eq(companySkillSources.id, binding!.sourceId!));
    const authorize = vi.fn(async () => { throw unprocessable('Automatic updates are denied by company policy.'); });
    const worker = skillSourceSyncService(db, { context: async () => ({ ...context, authorize }) });
    await worker.tick(now);
    const [failed] = await db.select().from(companySkillSources).where(eq(companySkillSources.id, binding!.sourceId!));
    expect(failed).toMatchObject({ failureCount: 1, leaseToken: null, lastError: 'Automatic updates are denied by company policy.' });
    expect(failed!.nextSyncAt.getTime()).toBeGreaterThan(now.getTime());
    await worker.tick(new Date(now.getTime() + 1000));
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it('uses bounded skill packages when a tracked repository outgrows the repository limit', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    files = { 'small/SKILL.md': md('small') }; commit = '4'.repeat(40);
    const row = await workspace('growing-repository');
    await enqueueProjectSkillSource(db, row);
    await skillSourceSyncService(db, { context: async () => context }).tick();
    const [binding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, row.id));
    const service = skillSourceService(db), original = await service.detail(companyId, binding!.sourceId!);
    expect(original.packageMode).toBe('repository');
    const skillId = original.entries[0]!.skillId!;
    files['small/SKILL.md'] = md('small updated'); commit = '5'.repeat(40);
    const growing: SkillSourceContext = { ...context, read: () => {
      const fixture = context.read(null), open = fixture.openSnapshot;
      fixture.openSnapshot = async (...args) => {
        const snapshot = await open(...args);
        for (let index = 0; index < 10000; index++) snapshot.entries.push({ path: `unrelated/${index}.txt`, type: 'blob', mode: '100644', sha: String(index + 1), size: 0 });
        return snapshot;
      };
      return fixture;
    } };
    const result = await service.refresh(companyId, original.id, growing);
    expect(result.source.packageMode).toBe('skills');
    expect(result.warnings.join(' ')).toContain('repository exceeds');
    expect(result.source.entries[0]!.skillId).toBe(skillId);
    expect(result.updated).toHaveLength(1);
    files = { 'small/SKILL.md': md('small with shared guide') + '\nRead [guide](../shared/guide.md).', 'shared/guide.md': 'Now fits in the repository package.' };
    commit = '6'.repeat(40);
    const complete = await service.refresh(companyId, original.id, context);
    expect(complete.source.packageMode).toBe('repository');
    expect(complete.source.entries.find(entry => entry.path === 'small/SKILL.md')!.skillId).toBe(skillId);
    expect((await companySkillService(db).readFile(companyId, skillId, '.paperclip-repository/shared/guide.md'))?.content)
      .toBe('Now fits in the repository package.');
  });

  it('enqueues repository changes atomically, leaves ordinary legacy edits alone and retains old references', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    const legacy = await workspace('lifecycle');
    const service = projectService(db, { captureWorkspaceUpdates: false });
    await service.updateWorkspace(legacy.projectId, legacy.id, { name: 'Renamed older workspace' });
    expect(await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, legacy.id))).toHaveLength(0);

    await expect(db.transaction(async tx => {
      await projectService(tx as unknown as typeof db, { captureWorkspaceUpdates: false }).createWorkspace(legacy.projectId,
        { repoUrl: 'https://github.com/acme/skills', defaultRef: 'rolled-back' });
      throw new Error('Required project audit failed');
    })).rejects.toThrow('Required project audit failed');
    expect(await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.defaultRef, 'rolled-back'))).toHaveLength(0);
    expect(await db.select().from(projectSkillSources).where(eq(projectSkillSources.trackingRef, 'rolled-back'))).toHaveLength(0);

    files = { 'lifecycle/SKILL.md': md('lifecycle') }; commit = '6'.repeat(40);
    const created = (await service.createWorkspace(legacy.projectId,
      { repoUrl: 'https://github.com/acme/skills', defaultRef: 'lifecycle-created' }))!;
    const worker = skillSourceSyncService(db, { context: async () => context });
    await worker.tick();
    const [originalBinding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, created.id));
    const source = await skillSourceService(db).detail(companyId, originalBinding!.sourceId!);
    const skillId = source.entries[0]!.skillId!;
    const versionId = (await companySkillService(db).getById(companyId, skillId))!.currentVersionId;

    await service.updateWorkspace(legacy.projectId, created.id, { defaultRef: 'lifecycle-next' });
    await worker.tick();
    const bindings = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, created.id));
    expect(bindings).toHaveLength(2);
    expect(bindings.find(binding => binding.id === originalBinding!.id)?.active).toBe(false);
    const current = bindings.find(binding => binding.active)!;
    expect(current.sourceId).not.toBe(source.id);
    const retained = (await companySkillService(db).getById(companyId, skillId))!;
    expect(retained.currentVersionId).toBe(versionId);
    const newSource = await skillSourceService(db).detail(companyId, current.sourceId!);
    expect(newSource.entries[0]!.skillId).not.toBe(skillId);

    await service.updateWorkspace(legacy.projectId, created.id, { defaultRef: 'lifecycle-next' });
    expect(await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, created.id))).toHaveLength(2);
    await service.removeWorkspace(legacy.projectId, created.id);
    expect(await skillSourceService(db).detail(companyId, current.sourceId!)).toMatchObject({ trackingActive: false });
    expect(await companySkillService(db).getById(companyId, skillId)).not.toBeNull();
  });

  it('lets API-key agents attach repositories without inventing a setup person', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    const project = await workspace('key-agent-parent');
    const [agent] = await db.insert(agents).values({ companyId, name: 'API-key project creator', adapterType: 'codex_local', status: 'idle' }).returning();
    const keyActor: AuthorizationActor = { type: 'agent', source: 'agent_key', agentId: agent!.id, companyId, onBehalfOfUserId: 'unverified-person' };
    const attached = await withSkillActor(keyActor, () => projectService(db, { captureWorkspaceUpdates: false }).createWorkspace(project.projectId,
      { repoUrl: 'https://github.com/acme/skills', defaultRef: 'key-agent' }));
    expect(attached).not.toBeNull();
    const [binding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, attached!.id));
    expect(binding).toMatchObject({ status: 'pending', refreshUserId: null, refreshAgentId: agent!.id, refreshLocalTrusted: false, sourceId: null });
    await detachProjectSkillSource(db, companyId, attached!.id);
  });

  it('follows a changed default branch while an explicit branch remains fixed', async () => {
    await db.update(companySkillSources).set({ automaticUpdates: false });
    let defaultBranch = 'main';
    const originalFiles = { 'workflow/SKILL.md': md('original default') }, nextFiles = { 'workflow/SKILL.md': md('new default') };
    const moving: SkillSourceContext = { ...context, read: () => {
      const reader = (async (url: string) => {
        if (url === '/repos/acme/skills') return { id: 42, full_name: 'acme/skills', default_branch: defaultBranch };
        if (url.startsWith('/repos/acme/skills/commits/')) return { sha: decodeURIComponent(url.split('/commits/')[1]!) === 'main' ? '7'.repeat(40) : '8'.repeat(40) };
        throw new Error('Unexpected request');
      }) as ReturnType<SkillSourceContext['read']>;
      reader.openSnapshot = async (input, options) => githubFixture(input.ref === 'main' ? originalFiles : nextFiles, {}, input.ref === 'main' ? '7'.repeat(40) : '8'.repeat(40)).openSnapshot(input, options);
      return reader;
    } };
    const implicit = await workspace('HEAD');
    await enqueueProjectSkillSource(db, implicit);
    const worker = skillSourceSyncService(db, { context: async () => moving });
    await worker.tick();
    const [defaultBinding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, implicit.id));
    const sourceService = skillSourceService(db);
    const original = await sourceService.detail(companyId, defaultBinding!.sourceId!);
    expect(original.trackingRef).toBe('HEAD');
    const skillId = original.entries[0]!.skillId!;
    const versionId = (await companySkillService(db).getById(companyId, skillId))!.currentVersionId;

    const explicit = await workspace('main');
    await enqueueProjectSkillSource(db, explicit);
    await worker.tick();
    const [fixedBinding] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, explicit.id));
    expect(fixedBinding!.sourceId).not.toBe(original.id);
    defaultBranch = 'next-default';
    await worker.tick(new Date(Date.now() + 6 * 60_000));
    expect(await sourceService.detail(companyId, original.id)).toMatchObject({ trackingRef: 'HEAD', lastScanCommit: '8'.repeat(40) });
    expect(await sourceService.detail(companyId, fixedBinding!.sourceId!)).toMatchObject({ trackingRef: 'main', lastScanCommit: '7'.repeat(40) });
    const latest = (await companySkillService(db).getById(companyId, skillId))!;
    expect(latest.currentVersionId).not.toBe(versionId);
    expect(latest.markdown).toBe(md('new default'));
    expect((await companySkillService(db).getVersion(companyId, skillId, versionId!))!.fileInventory[0]!.content).toBe(md('original default'));
    const repeated = await workspace('HEAD');
    await enqueueProjectSkillSource(db, repeated);
    await worker.tick();
    const [reused] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.workspaceId, repeated.id));
    expect(reused!.sourceId).toBe(original.id);
  });
});
