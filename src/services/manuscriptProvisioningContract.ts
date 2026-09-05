import type {
  LiteratureProvisioningAggregateInput,
  LiteratureProvisioningAggregateResult,
  LiteratureProvisioningChannel,
  ManuscriptProvisioningCreateOutcome,
  ManuscriptProvisioningFactKind,
  ManuscriptProvisioningIssue,
  ManuscriptProvisioningIssueKind,
  ManuscriptProvisioningIntent,
  ManuscriptProvisioningKey,
  ManuscriptProvisioningMandatoryFacts,
  ManuscriptProvisioningMutationIntent,
  ManuscriptProvisioningOwnerChannelContract,
  ManuscriptProvisioningReadinessFact,
  ManuscriptProvisioningReadinessFacts,
  ManuscriptProvisioningReadinessState,
  ManuscriptProvisioningResult,
  ManuscriptProvisioningVerifiedCapability,
  ManuscriptResourceReadiness,
  OwnerCreateError,
  RunParentPlacementFactKind
} from "../types/manuscriptProvisioning";
import { assertValidManuscriptChannelForOwner } from "../types/manuscriptChannel";

export {
  MANUSCRIPT_PROVISIONING_FACT_AUTHORITIES,
  MANUSCRIPT_PROVISIONING_INTENTS,
  MANUSCRIPT_PROVISIONING_PHASES
} from "../types/manuscriptProvisioning";

export const FILE_REF_DELETED_IDENTITY_ERROR_CODE = "FILE_REF_DELETED_IDENTITY";

const DEFAULT_RESOURCE_FACTS = Object.freeze([
  "default-folder-identity",
  "default-folder-exists",
  "default-folder-actual-type",
  "default-folder-contained",
  "default-folder-no-escape",
  "default-manuscript-identity",
  "default-manuscript-exists",
  "default-manuscript-actual-type",
  "default-manuscript-contained",
  "default-manuscript-no-escape",
  "default-binding"
] as const satisfies readonly ManuscriptProvisioningFactKind[]);

const CURRENT_RESOURCE_FACTS = Object.freeze([
  "current-manuscript-identity",
  "current-manuscript-exists",
  "current-manuscript-actual-type",
  "current-manuscript-contained",
  "current-manuscript-no-escape",
  "current-binding"
] as const satisfies readonly ManuscriptProvisioningFactKind[]);

export const RUN_PARENT_PLACEMENT_FACTS = Object.freeze([
  "parent-experiment-active",
  "parent-default-folder-identity",
  "parent-default-folder-exists",
  "parent-default-folder-actual-type",
  "parent-default-folder-contained",
  "parent-default-folder-no-escape",
  "child-placement-unique"
] as const satisfies readonly RunParentPlacementFactKind[]);

const COMMON_MANDATORY_FACTS = Object.freeze({
  readReady: Object.freeze([...CURRENT_RESOURCE_FACTS, "read-permission"]),
  writeReady: Object.freeze([
    "default-folder-identity",
    "default-folder-exists",
    "default-folder-actual-type",
    "default-folder-contained",
    "default-folder-no-escape",
    "write-permission"
  ]),
  defaultResourceReady: DEFAULT_RESOURCE_FACTS,
  currentResourceReady: CURRENT_RESOURCE_FACTS
} satisfies ManuscriptProvisioningMandatoryFacts);

const RUN_MANDATORY_FACTS = Object.freeze({
  ...COMMON_MANDATORY_FACTS,
  defaultResourceReady: Object.freeze([
    ...RUN_PARENT_PLACEMENT_FACTS,
    ...DEFAULT_RESOURCE_FACTS
  ])
} satisfies ManuscriptProvisioningMandatoryFacts);

const repairable = Object.freeze(["default-folder", "default-manuscript"] as const);

function ownerContract(
  value: Omit<
    ManuscriptProvisioningOwnerChannelContract,
    "trigger" | "repairableMissingResources" | "mandatoryFacts"
  > & { mandatoryFacts?: ManuscriptProvisioningMandatoryFacts }
): ManuscriptProvisioningOwnerChannelContract {
  return Object.freeze({
    ...value,
    trigger: "create-time",
    repairableMissingResources: repairable,
    mandatoryFacts: value.mandatoryFacts ?? COMMON_MANDATORY_FACTS
  });
}

export const MANUSCRIPT_PROVISIONING_OWNER_CHANNEL_CONTRACTS = Object.freeze([
  ownerContract({
    ownerType: "experiment",
    manuscriptChannel: "primary",
    defaultFilename: "experiment.md",
    migrationOrder: 1,
    parentPlacement: "none",
    sharedFolderGroup: "none"
  }),
  ownerContract({
    ownerType: "experimentRun",
    manuscriptChannel: "primary",
    defaultFilename: "experiment-run.md",
    migrationOrder: 2,
    parentPlacement: "experiment-default-folder",
    sharedFolderGroup: "none",
    mandatoryFacts: RUN_MANDATORY_FACTS
  }),
  ownerContract({
    ownerType: "review",
    manuscriptChannel: "primary",
    defaultFilename: "review.md",
    migrationOrder: 3,
    parentPlacement: "none",
    sharedFolderGroup: "none"
  }),
  ownerContract({
    ownerType: "resultItem",
    manuscriptChannel: "primary",
    defaultFilename: "result-item.md",
    migrationOrder: 4,
    parentPlacement: "none",
    sharedFolderGroup: "none"
  }),
  ownerContract({
    ownerType: "finding",
    manuscriptChannel: "primary",
    defaultFilename: "finding.md",
    migrationOrder: 4,
    parentPlacement: "none",
    sharedFolderGroup: "none"
  }),
  ownerContract({
    ownerType: "outputCandidate",
    manuscriptChannel: "primary",
    defaultFilename: "output-candidate.md",
    migrationOrder: 4,
    parentPlacement: "none",
    sharedFolderGroup: "none"
  }),
  ownerContract({
    ownerType: "outputGap",
    manuscriptChannel: "primary",
    defaultFilename: "output-gap.md",
    migrationOrder: 4,
    parentPlacement: "none",
    sharedFolderGroup: "none"
  }),
  ownerContract({
    ownerType: "researchOutput",
    manuscriptChannel: "primary",
    defaultFilename: "research-output.md",
    migrationOrder: 4,
    parentPlacement: "none",
    sharedFolderGroup: "none"
  }),
  ownerContract({
    ownerType: "literature",
    manuscriptChannel: "literature_outline",
    defaultFilename: "literature-outline.md",
    migrationOrder: 5,
    parentPlacement: "none",
    sharedFolderGroup: "literature"
  }),
  ownerContract({
    ownerType: "literature",
    manuscriptChannel: "dedicated_notes",
    defaultFilename: "dedicated-notes.md",
    migrationOrder: 5,
    parentPlacement: "none",
    sharedFolderGroup: "literature"
  })
] as const satisfies readonly ManuscriptProvisioningOwnerChannelContract[]);

export function buildManuscriptProvisioningKey(
  input: ManuscriptProvisioningKey
): ManuscriptProvisioningKey {
  const ownerId = input.ownerId.trim();
  if (!ownerId) throw new Error("MANUSCRIPT_PROVISIONING_OWNER_ID_REQUIRED");
  const manuscriptChannel = assertValidManuscriptChannelForOwner(
    input.ownerType,
    input.manuscriptChannel
  );
  return Object.freeze({
    ownerType: input.ownerType,
    ownerId,
    manuscriptChannel
  });
}

export function isManuscriptProvisioningMutationIntent(
  intent: string
): intent is ManuscriptProvisioningMutationIntent {
  return intent === "create-default"
    || intent === "retry"
    || intent === "repair"
    || intent === "recover";
}

function readinessState(
  value: ManuscriptProvisioningReadinessFact | ManuscriptProvisioningReadinessState | undefined
): ManuscriptProvisioningReadinessState | undefined {
  return typeof value === "string" ? value : value?.state;
}

export function combineManuscriptReadiness(
  values: readonly (
    | ManuscriptProvisioningReadinessFact
    | ManuscriptProvisioningReadinessState
    | undefined
  )[]
): ManuscriptProvisioningReadinessState {
  if (values.length === 0) return "not-verified";
  const states = values.map(readinessState);
  if (states.some((state) => state === "not-ready")) return "not-ready";
  if (states.some((state) => state !== "ready")) return "not-verified";
  return "ready";
}

function combineMandatoryFacts(
  required: readonly ManuscriptProvisioningFactKind[],
  facts: ManuscriptProvisioningReadinessFacts
): ManuscriptProvisioningReadinessState {
  return combineManuscriptReadiness(required.map((kind) => facts[kind]));
}

export function evaluateManuscriptResourceReadiness(
  descriptor: ManuscriptProvisioningOwnerChannelContract,
  intent: ManuscriptProvisioningIntent,
  facts: ManuscriptProvisioningReadinessFacts
): ManuscriptResourceReadiness {
  return Object.freeze({
    intent,
    readReady: combineMandatoryFacts(descriptor.mandatoryFacts.readReady, facts),
    writeReady: combineMandatoryFacts(descriptor.mandatoryFacts.writeReady, facts),
    defaultResourceReady: combineMandatoryFacts(
      descriptor.mandatoryFacts.defaultResourceReady,
      facts
    ),
    currentResourceReady: combineMandatoryFacts(
      descriptor.mandatoryFacts.currentResourceReady,
      facts
    )
  });
}

const VERIFIED_CAPABILITY_FIELD = Object.freeze({
  read: "readReady",
  write: "writeReady",
  "default-resource": "defaultResourceReady",
  "current-resource": "currentResourceReady"
} as const satisfies Record<
  ManuscriptProvisioningVerifiedCapability,
  keyof ManuscriptResourceReadiness
>);

type CompletedProvisioningResult = Extract<
  ManuscriptProvisioningResult,
  { status: "completed" }
>;

export function createCompletedManuscriptProvisioningResult(
  input: Omit<
    CompletedProvisioningResult,
    "status" | "phase" | "finalVerification" | "verifiedCapabilityReadiness"
  >
): CompletedProvisioningResult {
  if (input.readiness.intent !== input.intent) {
    throw new Error("MANUSCRIPT_PROVISIONING_READINESS_INTENT_MISMATCH");
  }
  const readinessField = VERIFIED_CAPABILITY_FIELD[input.verifiedCapability];
  if (input.readiness[readinessField] !== "ready") {
    throw new Error("MANUSCRIPT_PROVISIONING_REQUIRED_CAPABILITY_NOT_READY");
  }
  return Object.freeze({
    ...input,
    status: "completed",
    phase: "completed",
    finalVerification: "passed",
    verifiedCapabilityReadiness: "ready"
  });
}

function issue(
  classification: ManuscriptProvisioningIssue["classification"],
  causeCode: string
): ManuscriptProvisioningIssue {
  switch (classification) {
    case "retryable":
      return {
        classification,
        code: causeCode,
        originalCauseCode: causeCode,
        retryable: true,
        nextAction: "retry"
      };
    case "repair-required":
      return {
        classification,
        code: causeCode,
        originalCauseCode: causeCode,
        retryable: false,
        nextAction: "repair"
      };
    case "provisioning-recovery-required":
      return {
        classification,
        code: causeCode,
        originalCauseCode: causeCode,
        retryable: false,
        nextAction: "recover"
      };
    case "lifecycle-decision-required":
      return {
        classification,
        code: causeCode,
        originalCauseCode: causeCode,
        retryable: false,
        nextAction: "lifecycle-decision"
      };
    case "blocked":
      return {
        classification,
        code: causeCode,
        originalCauseCode: causeCode,
        retryable: false,
        nextAction: "stop"
      };
  }
}

export function classifyManuscriptProvisioningIssue(input: {
  kind: ManuscriptProvisioningIssueKind;
  causeCode: string;
}): ManuscriptProvisioningIssue {
  switch (input.kind) {
    case "transient":
      return issue("retryable", input.causeCode);
    case "canonical-resource-missing":
      return issue("repair-required", input.causeCode);
    case "physical-only-partial":
    case "file-ref-registered-partial":
    case "binding-written-not-verified":
    case "multi-channel-partial":
    case "parent-ready-child-failed":
      return issue("provisioning-recovery-required", input.causeCode);
    case "deleted-file-ref-identity":
    case "owner-deleted":
    case "parent-deleted":
    case "identity-conflict":
      return issue("lifecycle-decision-required", input.causeCode);
    case "wrong-type":
    case "path-conflict":
    case "symlink-escape":
    case "unknown-existing-file":
    case "non-empty-existing-file":
    case "ownership-unconfirmed":
    case "non-canonical-artifact":
      return issue("blocked", input.causeCode);
  }
}

export function createOwnerCreateFailed(
  error: OwnerCreateError
): ManuscriptProvisioningCreateOutcome<never> {
  return Object.freeze({ status: "owner-create-failed", error: { ...error } });
}

export function createOwnerCreated<TOwner>(
  owner: TOwner,
  provisioning: ManuscriptProvisioningResult
): ManuscriptProvisioningCreateOutcome<TOwner> {
  return Object.freeze({ status: "owner-created", owner, provisioning });
}

export function evaluateExperimentRunParentPlacementReadiness(
  facts: ManuscriptProvisioningReadinessFacts
): ManuscriptProvisioningReadinessState {
  return combineMandatoryFacts(RUN_PARENT_PLACEMENT_FACTS, facts);
}

function unfinishedLiteratureChannels(
  input: LiteratureProvisioningAggregateInput
): LiteratureProvisioningChannel[] {
  return (["literature_outline", "dedicated_notes"] as const).filter((channel) => {
    const child = input.children[channel];
    return child.state !== "completed"
      || child.defaultResourceReadiness !== "ready"
      || child.finalVerification !== "passed";
  });
}

export function evaluateLiteratureProvisioningAggregate(
  input: LiteratureProvisioningAggregateInput
): LiteratureProvisioningAggregateResult {
  const channels = ["literature_outline", "dedicated_notes"] as const;
  const issues = channels.flatMap((channel) => [...input.children[channel].issues]);
  const retryChannels = unfinishedLiteratureChannels(input);
  if (issues.some((item) => item.classification === "lifecycle-decision-required")) {
    return { status: "lifecycle-decision-required", retryChannels: [], issues };
  }
  if (
    input.sharedFolderIdentity.state === "not-ready"
    || issues.some((item) => item.classification === "blocked")
  ) {
    return { status: "blocked", retryChannels: [], issues };
  }
  if (
    input.sharedFolderIdentity.state === "ready"
    && retryChannels.length === 0
  ) {
    return { status: "completed", retryChannels: [], issues };
  }
  return {
    status: "provisioning-recovery-required",
    retryChannels,
    issues
  };
}
