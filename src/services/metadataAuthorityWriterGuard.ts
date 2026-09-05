import type { FileRefOwnerType } from "../types/experiment";
import type { ValidatedPlanningAuthorityHandle } from "./planningOwnerAuthorityPort";
import { authorityWriterGuard } from "./authorityWriterGuard";

async function resolveProjectIdentityHint(
  _ownerType: FileRefOwnerType,
  _ownerId: string
) {
  return typeof window === "undefined"
    ? "isolated-authority-test-project"
    : undefined;
}

export async function runMetadataAuthorityWrite<T>(input: {
  domain: "fileRef" | "binding";
  operation: string;
  ownerType: FileRefOwnerType;
  ownerId: string;
  scope: string;
  permit?: ValidatedPlanningAuthorityHandle;
  write(permit: ValidatedPlanningAuthorityHandle): Promise<T>;
}) {
  const projectId = await resolveProjectIdentityHint(
    input.ownerType,
    input.ownerId
  );
  return authorityWriterGuard.run({
    request: {
      intent: "metadataWrite",
      requestId: `${input.operation}-${input.ownerType}-${input.ownerId}-${input.scope}`,
      projectId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      scope: input.scope
    },
    permit: input.permit,
    invalidation: {
      domain: input.domain,
      projectId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      scope: input.scope
    },
    write: input.write
  });
}

export function runManagedRootAuthorityWrite<T>(input: {
  operation: string;
  permit?: ValidatedPlanningAuthorityHandle;
  write(permit: ValidatedPlanningAuthorityHandle): Promise<T>;
}) {
  return authorityWriterGuard.run({
    request: {
      intent: "managedRootWrite",
      requestId: input.operation
    },
    permit: input.permit,
    invalidation: { domain: "managedRoot" },
    write: input.write
  });
}
