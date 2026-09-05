import { invoke } from "@tauri-apps/api/core";
import type { FileRefOwnerType, ManuscriptChannel } from "../types";
import type { ProvisionManagedOwnerResult } from "../types/provisioning";
import type { ExperimentManuscriptProvisioningResult } from "../types/experimentProvisioning";
import type { ExperimentRunManuscriptProvisioningResult } from "../types/experimentRunProvisioning";
import { createPathIdentityKey } from "./fileRefIdentity";
import {
  readValidatedPlanningAuthorityCommandPermit,
  type ValidatedPlanningAuthorityHandle
} from "./planningOwnerAuthorityPort";

export const MANUSCRIPT_PROVISIONING_MAINLINE_VERSION = "lp12-a3-mainline-v1" as const;

type MainlineScope = "primary" | "literature-aggregate";
type DurableStepScope =
  | "primary"
  | "literature-aggregate"
  | "literature_outline"
  | "dedicated_notes";
type DurableStepKind =
  | "ensure-directory"
  | "ensure-manuscript"
  | "register-folder-fileref"
  | "register-manuscript-fileref"
  | "establish-binding"
  | "converge-default-current"
  | "converge-owner-metadata";
type DurableEffect = "created" | "reused" | "updated" | "preserved";

export interface MainlineProvisioningIdentity {
  ownerType: FileRefOwnerType;
  ownerId: string;
  scope: MainlineScope;
  manuscriptChannel?: ManuscriptChannel;
  expectedDirectoryPath: string;
  expectedManuscripts: Array<{
    manuscriptChannel: ManuscriptChannel;
    path: string;
  }>;
  parentSharedIdentity?: string;
}

export interface MainlineObservedStep {
  stepKind: DurableStepKind;
  stepScope: DurableStepScope;
  effectOutcome: DurableEffect;
  observedIdentity: string;
  resourceRecordId?: string;
  readbackPath?: string;
}

export interface MainlineOperationView {
  operationId: string;
  rootOperationId: string;
  intent: string;
  operationStatus: string;
  resultClassification?: string;
  nextAction?: string;
  ready: boolean;
  resumed: boolean;
  canonicalResourceIdentityHash: string;
  canonicalPlacementIdentityHash: string;
  steps: Array<{
    stepKind: DurableStepKind;
    stepScope: DurableStepScope;
    boundary: string;
    effectOutcome: string;
    observedIdentityHash?: string;
    resourceRecordId?: string;
  }>;
}

export interface MainlineProvisioningAdapter {
  begin(input: Record<string, unknown>): Promise<MainlineOperationView>;
  finish(input: Record<string, unknown>): Promise<MainlineOperationView>;
}

const tauriAdapter: MainlineProvisioningAdapter = {
  begin: (input) => invoke("provisioning_mainline_begin", { input }),
  finish: (input) => invoke("provisioning_mainline_finish", { input })
};

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: unknown) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableSerialize(value))
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Text(value: string) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function orderedExpectedManuscripts(input: MainlineProvisioningIdentity) {
  const rank: Record<ManuscriptChannel, number> = {
    primary: 0,
    literature_outline: 1,
    dedicated_notes: 2
  };
  return [...input.expectedManuscripts]
    .sort((left, right) => rank[left.manuscriptChannel] - rank[right.manuscriptChannel]);
}

function canonicalPlacementIdentity(input: MainlineProvisioningIdentity) {
  return [
    createPathIdentityKey(input.expectedDirectoryPath),
    ...orderedExpectedManuscripts(input).map((item) => createPathIdentityKey(item.path))
  ].join("|");
}

function exactExpectedPaths(input: MainlineProvisioningIdentity) {
  return {
    expectedDirectoryPath: input.expectedDirectoryPath,
    expectedManuscriptPaths: orderedExpectedManuscripts(input)
  };
}

function canonicalResourceIdentity(input: MainlineProvisioningIdentity) {
  return {
    domain: "labpod.manuscript-provisioning-resource-v1",
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    scope: input.scope,
    manuscriptChannel: input.manuscriptChannel ?? null
  };
}

function stepIdentity(input: MainlineProvisioningIdentity, step: MainlineObservedStep) {
  const pathBackedStep = [
    "ensure-directory",
    "ensure-manuscript",
    "register-folder-fileref",
    "register-manuscript-fileref"
  ].includes(step.stepKind);
  return {
    domain: "labpod.manuscript-provisioning-effect-v1",
    resource: canonicalResourceIdentity(input),
    stepKind: step.stepKind,
    stepScope: step.stepScope,
    observedIdentity: pathBackedStep
      ? createPathIdentityKey(step.observedIdentity)
      : step.observedIdentity,
    resourceRecordId: step.resourceRecordId ?? null
  };
}

export function createManuscriptProvisioningMainlineCoordinator(
  adapter: MainlineProvisioningAdapter = tauriAdapter
) {
  return {
    async begin(
      identity: MainlineProvisioningIdentity,
      permit: ValidatedPlanningAuthorityHandle
    ) {
      const authority = readValidatedPlanningAuthorityCommandPermit(permit);
      const expectedPaths = exactExpectedPaths(identity);
      return adapter.begin({
        ownerType: identity.ownerType,
        ownerId: identity.ownerId,
        scopeKind: identity.scope === "literature-aggregate" ? "literature-aggregate" : "channel",
        manuscriptChannel: identity.scope === "literature-aggregate"
          ? null
          : identity.manuscriptChannel ?? "primary",
        canonicalResourceIdentityHash: await sha256(canonicalResourceIdentity(identity)),
        canonicalPlacementIdentityHash: await sha256Text(canonicalPlacementIdentity(identity)),
        parentSharedIdentityHash: identity.parentSharedIdentity
          ? await sha256({
              domain: "labpod.manuscript-provisioning-parent-v1",
              identity: identity.parentSharedIdentity
            })
          : null,
        ...expectedPaths,
        authority
      });
    },

    async finish(
      identity: MainlineProvisioningIdentity,
      operationId: string,
      ready: boolean,
      causeCode: string | undefined,
      steps: MainlineObservedStep[],
      permit: ValidatedPlanningAuthorityHandle,
      effectOutcomeUnknown = false
    ) {
      const authority = readValidatedPlanningAuthorityCommandPermit(permit);
      const expectedPaths = exactExpectedPaths(identity);
      return adapter.finish({
        operationId,
        ready,
        effectOutcomeUnknown,
        causeCode: causeCode ?? null,
        steps: await Promise.all(steps.map(async (step) => ({
          stepKind: step.stepKind,
          stepScope: step.stepScope,
          effectOutcome: step.effectOutcome,
          observedIdentityHash: await sha256(stepIdentity(identity, step)),
          resourceRecordId: step.resourceRecordId ?? null,
          readbackPath: step.readbackPath ?? null
        }))),
        ...expectedPaths,
        authority
      });
    }
  };
}

export const manuscriptProvisioningMainlineCoordinator =
  createManuscriptProvisioningMainlineCoordinator();

function stateEffect(created: boolean | undefined): DurableEffect {
  return created ? "created" : "reused";
}

export function observedManagedPrimarySteps(
  result: ProvisionManagedOwnerResult,
  scope: DurableStepScope = "primary"
): MainlineObservedStep[] {
  const steps: MainlineObservedStep[] = [];
  const completed = new Set(result.completedSteps);
  if ((completed.has("directory") || completed.has("workspace")) && result.absoluteFolderPath) {
    steps.push({
      stepKind: "ensure-directory",
      stepScope: scope,
      effectOutcome: stateEffect(result.createdFolder),
      observedIdentity: result.absoluteFolderPath,
      readbackPath: result.absoluteFolderPath
    });
  }
  if (completed.has("default-manuscript-file") && result.bodyPath) {
    steps.push({
      stepKind: "ensure-manuscript",
      stepScope: scope,
      effectOutcome: stateEffect(result.createdBody),
      observedIdentity: result.bodyPath,
      readbackPath: result.bodyPath
    });
  }
  if (completed.has("default-folder-file-ref") && result.defaultFolderFileRef) {
    steps.push({
      stepKind: "register-folder-fileref",
      stepScope: scope,
      effectOutcome: result.folderFileRefState === "created" ? "created" : "reused",
      observedIdentity: result.defaultFolderFileRef.pathIdentityKey,
      resourceRecordId: result.defaultFolderFileRef.id,
      readbackPath: result.defaultFolderFileRef.path
    });
  }
  if (completed.has("default-manuscript-file-ref") && result.defaultManuscriptFileRef) {
    steps.push({
      stepKind: "register-manuscript-fileref",
      stepScope: scope,
      effectOutcome: result.manuscriptFileRefState === "created" ? "created" : "reused",
      observedIdentity: result.defaultManuscriptFileRef.pathIdentityKey,
      resourceRecordId: result.defaultManuscriptFileRef.id,
      readbackPath: result.defaultManuscriptFileRef.path
    });
  }
  if (completed.has("binding") && result.binding) {
    const bindingState = result.bindingState === "created" ? "created" : "reused";
    steps.push({
      stepKind: "establish-binding",
      stepScope: scope,
      effectOutcome: bindingState,
      observedIdentity: result.binding.id,
      resourceRecordId: result.binding.id
    });
    if (
      result.binding.defaultFolderFileRefId &&
      result.binding.defaultManuscriptFileRefId &&
      result.binding.currentFileRefId
    ) {
      steps.push({
        stepKind: "converge-default-current",
        stepScope: scope,
        effectOutcome: result.currentState === "initialized" ? "updated" : "preserved",
        observedIdentity: [
          result.binding.defaultFolderFileRefId,
          result.binding.defaultManuscriptFileRefId,
          result.binding.currentFileRefId
        ].join("|")
      });
      steps.push({
        stepKind: "converge-owner-metadata",
        stepScope: scope,
        effectOutcome: "preserved",
        observedIdentity: `${result.ownerType}|${result.ownerId}`
      });
    }
  }
  return steps;
}

export function observedExperimentPrimarySteps(
  result: ExperimentManuscriptProvisioningResult | ExperimentRunManuscriptProvisioningResult
): MainlineObservedStep[] {
  const steps: MainlineObservedStep[] = [];
  const completed = new Set(result.completedSteps);
  if ((completed.has("workspace") || completed.has("directory")) && result.workspacePathIdentity) {
    steps.push({
      stepKind: "ensure-directory",
      stepScope: "primary",
      effectOutcome: result.physicalDirectoryState === "created" ? "created" : "reused",
      observedIdentity: result.workspacePathIdentity,
      readbackPath: result.workspacePathIdentity
    });
  }
  if (completed.has("default-manuscript-file") && result.defaultFilePath) {
    steps.push({
      stepKind: "ensure-manuscript",
      stepScope: "primary",
      effectOutcome: result.physicalFileState === "created" ? "created" : "reused",
      observedIdentity: result.defaultFilePath,
      readbackPath: result.defaultFilePath
    });
  }
  if (completed.has("default-folder-file-ref") && result.defaultFolderFileRefId) {
    steps.push({
      stepKind: "register-folder-fileref",
      stepScope: "primary",
      effectOutcome: result.folderFileRefState === "created" ? "created" : "reused",
      observedIdentity: result.workspacePathIdentity ?? result.defaultFolderFileRefId,
      resourceRecordId: result.defaultFolderFileRefId,
      readbackPath: result.workspacePathIdentity
    });
  }
  if (completed.has("default-manuscript-file-ref") && result.defaultManuscriptFileRefId) {
    steps.push({
      stepKind: "register-manuscript-fileref",
      stepScope: "primary",
      effectOutcome: result.manuscriptFileRefState === "created" ? "created" : "reused",
      observedIdentity: result.defaultFilePath ?? result.defaultManuscriptFileRefId,
      resourceRecordId: result.defaultManuscriptFileRefId,
      readbackPath: result.defaultFilePath
    });
  }
  if (completed.has("binding") && result.bindingId) {
    steps.push({
      stepKind: "establish-binding",
      stepScope: "primary",
      effectOutcome: result.bindingState === "created" ? "created" : "reused",
      observedIdentity: result.bindingId,
      resourceRecordId: result.bindingId
    });
    if (result.defaultFolderFileRefId && result.defaultManuscriptFileRefId && result.currentFileRefId) {
      steps.push({
        stepKind: "converge-default-current",
        stepScope: "primary",
        effectOutcome: result.currentState === "initialized" ? "updated" : "preserved",
        observedIdentity: [
          result.defaultFolderFileRefId,
          result.defaultManuscriptFileRefId,
          result.currentFileRefId
        ].join("|")
      });
      steps.push({
        stepKind: "converge-owner-metadata",
        stepScope: "primary",
        effectOutcome: "preserved",
        observedIdentity: `${result.ownerType}|${result.ownerId}`
      });
    }
  }
  return steps;
}
