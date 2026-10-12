import type { CompanyUserDirectoryEntry } from "../api/access";

const LOCAL_BOARD_USER_ID = "local-board";

/** The synthetic local Board principal is not a person, so it is never shown as a creator. */
export function humanAgentCreatorUserId(createdByUserId: string | null | undefined): string | null {
  return createdByUserId && createdByUserId !== LOCAL_BOARD_USER_ID ? createdByUserId : null;
}

/**
 * Who created an agent only matters once more than one human shares the
 * company, so the label stays hidden on single-user instances. The local Board
 * principal does not count toward that threshold.
 */
export function resolveAgentCreatorLabel(
  createdByUserId: string | null | undefined,
  users: CompanyUserDirectoryEntry[] | undefined,
): string | null {
  const creatorUserId = humanAgentCreatorUserId(createdByUserId);
  if (!creatorUserId || !users) return null;
  const humans = users.filter((entry) => entry.principalId !== LOCAL_BOARD_USER_ID);
  if (humans.length < 2) return null;
  const creator = humans.find((entry) => entry.principalId === creatorUserId);
  if (!creator) return "Former member";
  return creator.user?.name?.trim() || creator.user?.email || "Unknown user";
}
