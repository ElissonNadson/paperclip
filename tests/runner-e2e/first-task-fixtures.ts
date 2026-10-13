import { normalizePaperclipOperationalSkillPreference } from "../../packages/adapter-utils/src/server-utils.js";
import type { RunnerApi } from "./api.js";
import { deleteDaytonaEnvironment, installFixtureDaytonaProvider, type LiveFixtureValues } from "./live-fixtures.js";
import { isImmutableDaytonaImage } from "./catalog.js";
import type { CredentialName, MatrixExecution } from "./types.js";

export const MANAGED_FIRST_TASK_CELL = "confirmation-replies.runner-codex.daytona.task-card-accept";
export function isManagedFirstTask(execution: Pick<MatrixExecution, "id">): boolean {
  return execution.id === MANAGED_FIRST_TASK_CELL;
}

export async function provisionFirstTaskFixtures(input: {
  api: Pick<RunnerApi, "get" | "patch" | "postSensitive"> & Partial<Pick<RunnerApi, "post" | "delete">>;
  execution: MatrixExecution;
  nonce: string;
  daytonaImage?: string;
  company: LiveFixtureValues["company"];
  credentials: Partial<Record<CredentialName, string>>;
}): Promise<LiveFixtureValues> {
  const { api, execution, nonce, company, credentials } = input;
  const managed = isManagedFirstTask(execution);
  if (
    !["first-task", "completion-updates", "confirmation-replies"].includes(execution.suite.id) || execution.task.flow !== "first_task" ||
    (execution.environment.id !== "local" && !managed) ||
    ![
      "legacy-codex",
      "legacy-claude",
      "runner-codex",
      "runner-acpx-claude",
    ].includes(execution.profile.id)
  ) {
    throw new Error(
      "First-task fixtures require a supported local onboarding profile",
    );
  }
  if (managed && (!isImmutableDaytonaImage(input.daytonaImage) || !api.post || !api.delete)) {
    throw new Error("Managed onboarding requires the immutable image and normal environment create/cleanup APIs");
  }
  const required = managed ? [execution.profile.credential, "DAYTONA_API_KEY" as const] : [execution.profile.credential];
  for (const name of required) if (!credentials[name]) throw new Error(`Missing credential ${name}`);
  await api.patch(`/api/companies/${company.id}`, { budgetMonthlyCents: 500 });
  let localEnvironment: LiveFixtureValues["environment"] | undefined;
  if (!managed) {
    const environments = await api.get<Array<LiveFixtureValues["environment"]>>(`/api/companies/${company.id}/environments?driver=local`);
    localEnvironment = environments.find(candidate => candidate.driver === "local");
    if (!localEnvironment) throw new Error("Onboarding fixture local environment missing");
  }
  const secretRefs: LiveFixtureValues["secretRefs"] = {};
  for (const name of required) {
    const secret = await api.postSensitive<{ id: string }>(`/api/companies/${company.id}/secrets`, {
      name: `First task ${name}`, key: name, value: credentials[name],
    });
    secretRefs[name] = { type: "secret_ref", secretId: secret.id, version: "latest" };
  }
  let environment: LiveFixtureValues["environment"];
  let teardown = async () => {};
  if (managed) {
    const remoteApi = api as Pick<RunnerApi, "post" | "delete">;
    await installFixtureDaytonaProvider(remoteApi, execution);
    environment = await remoteApi.post<LiveFixtureValues["environment"]>(`/api/companies/${company.id}/environments`,
      execution.environment.buildEnvironment({ secretRefs, daytonaImage: input.daytonaImage, executionId: nonce }));
    teardown = () => deleteDaytonaEnvironment(remoteApi, environment.id);
    try {
      await api.patch("/api/instance/settings", { defaultEnvironmentId: environment.id });
      await api.patch("/api/instance/settings/experimental", { enableManagedSandboxOnly: true });
    } catch (error) {
      try { await teardown(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Managed onboarding fixture setup and cleanup failed"); }
      throw error;
    }
  } else environment = localEnvironment!;

  return {
    company,
    environment,
    secretRefs,
    agent: { id: "", name: `Garden lead ${nonce}`, companyId: company.id },
    ...(managed ? { setupLeases: [], setupQualification: { recorded: false, adapterType: null, platformResponses: 0, adapterResponses: 0 } } : {}),
    teardown,
  };
}

export function firstTaskNativeRuntimePatch(
  execution: MatrixExecution,
  fixtures: LiveFixtureValues,
  agent: Record<string, any>,
) {
  if (!["runner-codex", "runner-acpx-claude"].includes(execution.profile.id))
    throw new Error("Unsupported native first-task profile");
  const built = execution.profile.buildAgent({
    environmentId: fixtures.environment.id,
    environmentFixtureId: "local",
    workspacePath: agent.adapterConfig?.cwd ?? "",
    secretRefs: fixtures.secretRefs,
    executionId: execution.id,
  });
  const config = {
    ...agent.adapterConfig,
    ...(built.adapterConfig as Record<string, unknown>),
  };
  // Preserve the wizard's model choice (including its unset provider default).
  if (agent.adapterConfig?.model == null) delete config.model;
  else config.model = agent.adapterConfig.model;
  return {
    adapterType: "paperclip_runner",
    adapterConfig: normalizePaperclipOperationalSkillPreference(
      "paperclip_runner",
      config,
    ),
  };
}
