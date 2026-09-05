import type { ExperimentManuscriptOwnerType } from "../types/experimentManuscript";
import type { OutputManuscriptOwnerType } from "../types/outputManuscript";

export type ExperimentManuscriptOwnerOperation =
  | "formalSwitch"
  | "hardMetadataDelete"
  | "metadataLifecycle"
  | "sessionSave"
  | "businessDependencyWrite";
type OwnerOperationState = {
  exclusive?: Exclude<ExperimentManuscriptOwnerOperation, "sessionSave" | "businessDependencyWrite">;
  sessionSaveCount: number;
  businessDependencyWriteCount: number;
};
const active = new Map<string, OwnerOperationState>();

function key(ownerType: string, ownerId: string) {
  return `${ownerType}\u0000${ownerId}`;
}

export function getExperimentManuscriptOwnerOperation(ownerType: ExperimentManuscriptOwnerType, ownerId: string) {
  const state = active.get(key(ownerType, ownerId));
  return state?.exclusive
    ?? (state && state.sessionSaveCount > 0 ? "sessionSave" : undefined)
    ?? (state && state.businessDependencyWriteCount > 0 ? "businessDependencyWrite" : undefined);
}

function tryAcquireOwnerOperation(
  ownerType: string,
  ownerId: string,
  operation: ExperimentManuscriptOwnerOperation
) {
  const operationKey = key(ownerType, ownerId);
  const state = active.get(operationKey) ?? { sessionSaveCount: 0, businessDependencyWriteCount: 0 };
  if (operation === "sessionSave" || operation === "businessDependencyWrite") {
    if (state.exclusive === "hardMetadataDelete") return undefined;
    if (operation === "sessionSave") state.sessionSaveCount += 1;
    else state.businessDependencyWriteCount += 1;
  } else {
    if (state.exclusive || state.sessionSaveCount > 0 || state.businessDependencyWriteCount > 0) return undefined;
    state.exclusive = operation;
  }
  active.set(operationKey, state);
  let released = false;
  return () => {
    if (!released) {
      const current = active.get(operationKey);
      if (current) {
        if (operation === "sessionSave") current.sessionSaveCount = Math.max(0, current.sessionSaveCount - 1);
        else if (operation === "businessDependencyWrite") {
          current.businessDependencyWriteCount = Math.max(0, current.businessDependencyWriteCount - 1);
        }
        else if (current.exclusive === operation) current.exclusive = undefined;
        if (!current.exclusive && current.sessionSaveCount === 0 && current.businessDependencyWriteCount === 0) {
          active.delete(operationKey);
        }
      }
    }
    released = true;
  };
}

export function tryAcquireExperimentManuscriptOwnerOperation(
  ownerType: ExperimentManuscriptOwnerType,
  ownerId: string,
  operation: ExperimentManuscriptOwnerOperation
) {
  return tryAcquireOwnerOperation(ownerType, ownerId, operation);
}

export function tryAcquireCanonicalFormalSwitchOwnerOperation(
  ownerType: ExperimentManuscriptOwnerType | "literature" | "review" | OutputManuscriptOwnerType,
  ownerId: string
) {
  return tryAcquireOwnerOperation(ownerType, ownerId, "formalSwitch");
}
