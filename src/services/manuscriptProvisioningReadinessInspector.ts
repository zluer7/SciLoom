import type {
  EntityId,
  FileRef,
  FileRefAvailabilityResult,
  ManagedRootStatus,
  ManuscriptBindingIdentityResult,
  ManuscriptBindingSlot,
  ManuscriptIdentityResolvedFact,
  ManuscriptProvisioningFactKind,
  ManuscriptProvisioningMetadataOnlyProvenance,
  ManuscriptProvisioningOwnerChannelContract,
  ManuscriptProvisioningReadinessBlocker,
  ManuscriptProvisioningReadinessFact,
  ManuscriptProvisioningReadinessFacts,
  ManuscriptProvisioningReadinessInspection,
  ManuscriptProvisioningReadinessInspectionInput,
  ManuscriptProvisioningReadinessState,
  ManuscriptProvisioningEligibilityFact,
  ManuscriptOwnerLifecycleScope,
  ManuscriptResourceReadiness,
  LiteratureProvisioningReadinessInspection,
  LiteratureProvisioningReadinessInspectionInput
} from "../types";
import { MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES } from "../types";
import type { InspectFileRefAvailabilityInput } from "./fileRefService";
import { fileRefService } from "./fileRefService";
import { createPathIdentityKey } from "./fileRefIdentity";
import { managedRootConfigService } from "./managedRootConfigService";
import {
  buildManagedManuscriptPath,
  isPathWithinDirectory,
  isPathWithinRoot
} from "./managedPathService";
import { manuscriptBindingIdentityResolver } from "./manuscriptBindingIdentityResolver";
import {
  MANUSCRIPT_PROVISIONING_OWNER_CHANNEL_CONTRACTS,
  combineManuscriptReadiness,
  evaluateExperimentRunParentPlacementReadiness,
  evaluateManuscriptResourceReadiness
} from "./manuscriptProvisioningContract";
import { runWithProvisioningAuthority } from "./provisioningAuthorityGuard";
import { PLANNING_OWNER_ALLOWED_PROVISIONING_INTENTS } from "./planningOwnerAuthorityPort";

const BLOCKER = Object.freeze({
  bindingUnavailable: "MANUSCRIPT_BINDING_IDENTITY_NOT_VERIFIED",
  identityMissing: "MANUSCRIPT_FILE_REF_IDENTITY_MISSING",
  identityChanged: "MANUSCRIPT_FILE_REF_METADATA_CHANGED_AFTER_IDENTITY_RESOLUTION",
  rootUnavailable: "MANUSCRIPT_MANAGED_ROOT_NOT_VERIFIED",
  missing: "MANUSCRIPT_RESOURCE_MISSING",
  wrongType: "MANUSCRIPT_RESOURCE_WRONG_TYPE",
  physicalNotVerified: "MANUSCRIPT_RESOURCE_NOT_VERIFIED",
  outsideRoot: "MANUSCRIPT_RESOURCE_OUTSIDE_MANAGED_ROOT",
  escape: "MANUSCRIPT_RESOURCE_SYMLINK_JUNCTION_REPARSE_ESCAPE",
  canonicalPlacement: "MANUSCRIPT_PROVISIONING_CANONICAL_PLACEMENT_MISMATCH",
  readPermission: "MANUSCRIPT_READ_PERMISSION_NOT_VERIFIED",
  writePermission: "MANUSCRIPT_WRITE_PERMISSION_NOT_VERIFIED",
  parentActive: "MANUSCRIPT_RUN_PARENT_ACTIVE_NOT_VERIFIED",
  parentDeleted: "MANUSCRIPT_RUN_PARENT_DELETED",
  parentMissing: "MANUSCRIPT_RUN_PARENT_INPUT_MISSING",
  childPlacement: "MANUSCRIPT_RUN_CHILD_PLACEMENT_NOT_UNIQUE",
  sharedFolder: "LITERATURE_SHARED_FOLDER_IDENTITY_MISMATCH"
});

type MetadataProvenanceSource =
  | "binding-resolver"
  | "file-ref-metadata"
  | "native-path-metadata"
  | "path-placement-metadata"
  | "external-lifecycle-input"
  | "capability-not-proven-by-metadata";

export interface ManuscriptProvisioningReadinessInspectorDependencies {
  resolveBindingIdentity: typeof manuscriptBindingIdentityResolver.resolve;
  readActiveFileRef(id: EntityId): Promise<FileRef | undefined>;
  getManagedRootStatus(): Promise<ManagedRootStatus>;
  inspectPathMetadata(input: InspectFileRefAvailabilityInput): Promise<FileRefAvailabilityResult>;
  withOwnerAuthority<T>(
    key: ManuscriptProvisioningReadinessInspectionInput["request"]["key"],
    use: (facts: FormalOwnerAuthorityFacts) => Promise<T>
  ): Promise<T>;
  now(): string;
}

interface FormalOwnerAuthorityFacts {
  ownerScope: ManuscriptOwnerLifecycleScope;
  eligibility: ManuscriptProvisioningEligibilityFact;
}

type FormalReadinessInspectionInput = Omit<
  ManuscriptProvisioningReadinessInspectionInput,
  "ownerScope" | "eligibility" | "parentExperiment"
> & {
  parentExperiment?: { ownerId: EntityId };
};

type FormalLiteratureInspectionInput = Omit<
  LiteratureProvisioningReadinessInspectionInput,
  "ownerScope" | "eligibility"
>;

interface ResourceFactNames {
  identity: ManuscriptProvisioningFactKind;
  exists: ManuscriptProvisioningFactKind;
  actualType: ManuscriptProvisioningFactKind;
  contained: ManuscriptProvisioningFactKind;
  noEscape: ManuscriptProvisioningFactKind;
}

interface BoundResourceInspection {
  ref?: FileRef;
  canonicalPath?: string;
}

const DEFAULT_FOLDER_FACTS: ResourceFactNames = {
  identity: "default-folder-identity",
  exists: "default-folder-exists",
  actualType: "default-folder-actual-type",
  contained: "default-folder-contained",
  noEscape: "default-folder-no-escape"
};

const DEFAULT_MANUSCRIPT_FACTS: ResourceFactNames = {
  identity: "default-manuscript-identity",
  exists: "default-manuscript-exists",
  actualType: "default-manuscript-actual-type",
  contained: "default-manuscript-contained",
  noEscape: "default-manuscript-no-escape"
};

const CURRENT_MANUSCRIPT_FACTS: ResourceFactNames = {
  identity: "current-manuscript-identity",
  exists: "current-manuscript-exists",
  actualType: "current-manuscript-actual-type",
  contained: "current-manuscript-contained",
  noEscape: "current-manuscript-no-escape"
};

const PARENT_FOLDER_FACTS: ResourceFactNames = {
  identity: "parent-default-folder-identity",
  exists: "parent-default-folder-exists",
  actualType: "parent-default-folder-actual-type",
  contained: "parent-default-folder-contained",
  noEscape: "parent-default-folder-no-escape"
};

function metadataProvenance(
  source: MetadataProvenanceSource
): ManuscriptProvisioningMetadataOnlyProvenance {
  return {
    source,
    mode: "authoritative-read-only",
    contentReadScope: "metadata-only",
    markdownBytesRead: 0
  };
}

function fact(
  kind: ManuscriptProvisioningFactKind,
  state: ManuscriptProvisioningReadinessState,
  checkedAt: string,
  source: MetadataProvenanceSource,
  blockerCode?: string
): ManuscriptProvisioningReadinessFact {
  return {
    kind,
    state,
    checkedAt,
    provenance: metadataProvenance(source),
    ...(state === "ready" ? {} : { blockerCode: blockerCode ?? BLOCKER.physicalNotVerified })
  };
}

function emptySlot(slot: ManuscriptBindingSlot) {
  return { slot, fileRefId: null, status: "missing" as const, errors: [] };
}

function resolverFailure(
  input: FormalReadinessInspectionInput,
  ownerScope: ManuscriptOwnerLifecycleScope,
  manuscriptChannel: ManuscriptProvisioningReadinessInspectionInput["request"]["key"]["manuscriptChannel"]
): ManuscriptBindingIdentityResult {
  return {
    status: "error",
    identityResolved: false,
    key: {
      ownerType: input.request.key.ownerType,
      ownerId: input.request.key.ownerId,
      manuscriptChannel
    },
    ownerScope,
    slots: {
      defaultFolderFileRefId: emptySlot("defaultFolderFileRefId"),
      defaultManuscriptFileRefId: emptySlot("defaultManuscriptFileRefId"),
      currentFileRefId: emptySlot("currentFileRefId")
    },
    provenance: {
      binding: "sqlite.manuscript_bindings",
      fileRefs: "sqlite.file_refs.metadata",
      readMode: "authoritative-read-only",
      availability: "not-checked",
      fallback: "none"
    },
    warnings: [],
    errors: [MANUSCRIPT_BINDING_IDENTITY_ERROR_CODES.persistenceFailure]
  };
}

function identityFact(
  identity: ManuscriptBindingIdentityResult,
  checkedAt: string
): ManuscriptIdentityResolvedFact {
  const provenance = [
    identity.provenance.binding,
    identity.provenance.fileRefs,
    identity.provenance.readMode,
    `fallback:${identity.provenance.fallback}`
  ];
  if (identity.status === "resolved") {
    return {
      authority: "identity-resolved",
      status: "resolved",
      identityResolved: true,
      availability: "not-checked",
      checkedAt,
      provenance
    };
  }
  return {
    authority: "identity-resolved",
    status: identity.status,
    identityResolved: false,
    availability: "not-checked",
    checkedAt,
    provenance,
    causeCode: identity.errors[0]
  };
}

function descriptorFor(
  input: FormalReadinessInspectionInput
): ManuscriptProvisioningOwnerChannelContract {
  const descriptor = MANUSCRIPT_PROVISIONING_OWNER_CHANNEL_CONTRACTS.find(
    (candidate) => candidate.ownerType === input.request.key.ownerType
      && candidate.manuscriptChannel === input.request.key.manuscriptChannel
  );
  if (!descriptor) throw new Error("MANUSCRIPT_PROVISIONING_OWNER_CHANNEL_NOT_SUPPORTED");
  return descriptor;
}

function pathIdentityMatches(ref: FileRef) {
  try {
    return createPathIdentityKey(ref.path) === ref.pathIdentityKey;
  } catch {
    return false;
  }
}

function slotFailureState(identity: ManuscriptBindingIdentityResult) {
  return identity.status === "error" ? "not-verified" as const : "not-ready" as const;
}

function validateActiveRef(
  ref: FileRef,
  input: FormalReadinessInspectionInput,
  slot: ManuscriptBindingSlot,
  expectedResourceKind: "file" | "folder"
) {
  if (
    ref.deletedAt
    || ref.ownerType !== input.request.key.ownerType
    || ref.ownerId !== input.request.key.ownerId
    || ref.resourceKind !== expectedResourceKind
    || ref.fileRole !== (expectedResourceKind === "folder" ? "defaultFolder" : "manuscript")
    || (slot !== "currentFileRefId" && ref.locationMode !== "managed")
    || (slot === "currentFileRefId" && ref.locationMode !== "managed" && ref.locationMode !== "external")
    || (expectedResourceKind === "file" && ref.manuscriptChannel !== input.request.key.manuscriptChannel)
    || !pathIdentityMatches(ref)
  ) {
    return false;
  }
  return true;
}

function setUnverifiedPhysicalFacts(
  facts: ManuscriptProvisioningReadinessFacts,
  names: ResourceFactNames,
  checkedAt: string,
  blockerCode: string
) {
  facts[names.exists] = fact(names.exists, "not-verified", checkedAt, "native-path-metadata", blockerCode);
  facts[names.actualType] = fact(names.actualType, "not-verified", checkedAt, "native-path-metadata", blockerCode);
  facts[names.contained] = fact(names.contained, "not-verified", checkedAt, "native-path-metadata", blockerCode);
  facts[names.noEscape] = fact(names.noEscape, "not-verified", checkedAt, "native-path-metadata", blockerCode);
}

function applyPhysicalResult(
  facts: ManuscriptProvisioningReadinessFacts,
  names: ResourceFactNames,
  ref: FileRef,
  result: FileRefAvailabilityResult,
  managedRoot: string | undefined,
  checkedAt: string
): BoundResourceInspection {
  const source = "native-path-metadata" as const;
  switch (result.status) {
    case "available": {
      facts[names.exists] = fact(names.exists, "ready", checkedAt, source);
      facts[names.actualType] = fact(
        names.actualType,
        result.actualResourceKind === ref.resourceKind ? "ready" : "not-ready",
        checkedAt,
        source,
        BLOCKER.wrongType
      );
      if (ref.locationMode === "external") {
        facts[names.contained] = fact(names.contained, "ready", checkedAt, "path-placement-metadata");
        facts[names.noEscape] = fact(names.noEscape, "ready", checkedAt, "path-placement-metadata");
      } else {
        const contained = Boolean(
          managedRoot
          && result.canonicalPath
          && isPathWithinRoot(managedRoot, result.canonicalPath)
        );
        facts[names.contained] = fact(
          names.contained,
          contained ? "ready" : result.canonicalPath ? "not-ready" : "not-verified",
          checkedAt,
          "path-placement-metadata",
          result.canonicalPath ? BLOCKER.outsideRoot : BLOCKER.physicalNotVerified
        );
        facts[names.noEscape] = fact(
          names.noEscape,
          contained && !result.symlinkDetected ? "ready" : contained || result.canonicalPath ? "not-ready" : "not-verified",
          checkedAt,
          "path-placement-metadata",
          BLOCKER.escape
        );
      }
      return { ref, canonicalPath: result.canonicalPath };
    }
    case "missing":
      facts[names.exists] = fact(names.exists, "not-ready", checkedAt, source, result.errorCode ?? BLOCKER.missing);
      facts[names.actualType] = fact(names.actualType, "not-verified", checkedAt, source, BLOCKER.missing);
      facts[names.contained] = fact(names.contained, "not-verified", checkedAt, source, BLOCKER.missing);
      facts[names.noEscape] = fact(names.noEscape, "not-verified", checkedAt, source, BLOCKER.missing);
      return { ref };
    case "wrong_type":
      facts[names.exists] = fact(names.exists, "ready", checkedAt, source);
      facts[names.actualType] = fact(names.actualType, "not-ready", checkedAt, source, result.errorCode ?? BLOCKER.wrongType);
      facts[names.contained] = fact(names.contained, "not-verified", checkedAt, source, BLOCKER.wrongType);
      facts[names.noEscape] = fact(names.noEscape, "not-verified", checkedAt, source, BLOCKER.wrongType);
      return { ref };
    case "managed_placement_invalid":
      facts[names.exists] = fact(
        names.exists,
        result.actualResourceKind ? "ready" : "not-verified",
        checkedAt,
        source,
        BLOCKER.physicalNotVerified
      );
      facts[names.actualType] = fact(
        names.actualType,
        result.actualResourceKind === ref.resourceKind ? "ready" : result.actualResourceKind ? "not-ready" : "not-verified",
        checkedAt,
        source,
        BLOCKER.wrongType
      );
      facts[names.contained] = fact(names.contained, "not-ready", checkedAt, "path-placement-metadata", result.errorCode ?? BLOCKER.outsideRoot);
      facts[names.noEscape] = fact(names.noEscape, "not-ready", checkedAt, "path-placement-metadata", result.symlinkDetected ? BLOCKER.escape : result.errorCode ?? BLOCKER.outsideRoot);
      return { ref, canonicalPath: result.canonicalPath };
    case "unavailable":
    case "not_verified":
    case "metadata_deleted":
    case "metadata_not_found":
      setUnverifiedPhysicalFacts(facts, names, checkedAt, result.errorCode ?? BLOCKER.physicalNotVerified);
      return { ref };
  }
}

function blockersFromFacts(
  facts: ManuscriptProvisioningReadinessFacts
): ManuscriptProvisioningReadinessBlocker[] {
  return Object.values(facts).flatMap((item) => item && item.state !== "ready"
    ? [{
        factKind: item.kind,
        state: item.state,
        code: item.blockerCode ?? BLOCKER.physicalNotVerified
      }]
    : []);
}

function inspectionReadiness(
  value: ManuscriptResourceReadiness
): ManuscriptResourceReadiness & { intent: "inspect-readiness" } {
  if (value.intent !== "inspect-readiness") {
    throw new Error("MANUSCRIPT_READINESS_INSPECTION_INTENT_MISMATCH");
  }
  return value as ManuscriptResourceReadiness & { intent: "inspect-readiness" };
}

export function createManuscriptProvisioningReadinessInspector(
  dependencies: ManuscriptProvisioningReadinessInspectorDependencies
) {
  async function inspectOwnerChannelWithAuthority(
    input: FormalReadinessInspectionInput,
    authorityFacts: FormalOwnerAuthorityFacts
  ): Promise<ManuscriptProvisioningReadinessInspection> {
    if (input.request.intent !== "inspect-readiness") {
      throw new Error("MANUSCRIPT_READINESS_INSPECTION_INTENT_REQUIRED");
    }
    const descriptor = descriptorFor(input);
    const checkedAt = dependencies.now();
    let identity: ManuscriptBindingIdentityResult;
    try {
      const resolved = await dependencies.resolveBindingIdentity(input.request.key);
      identity = {
        ...resolved,
        ownerScope: authorityFacts.ownerScope
      };
    } catch {
      identity = resolverFailure(
        input,
        authorityFacts.ownerScope,
        descriptor.manuscriptChannel
      );
    }
    const facts: ManuscriptProvisioningReadinessFacts = {};
    let rootStatus: ManagedRootStatus;
    try {
      rootStatus = await dependencies.getManagedRootStatus();
    } catch {
      rootStatus = {
        status: "unconfigured",
        configuredRoot: null,
        managedRoot: null,
        access: "unavailable",
        durableState: "NOT_CONFIGURED",
        readinessState: "UNAVAILABLE",
        errorCode: "MANAGED_ROOT_UNCONFIGURED"
      };
    }

    async function inspectBoundResource(
      slotName: ManuscriptBindingSlot,
      names: ResourceFactNames,
      expectedResourceKind: "file" | "folder",
      validationInput: FormalReadinessInspectionInput = input,
      resourceIdentity: ManuscriptBindingIdentityResult = identity
    ): Promise<BoundResourceInspection> {
      const slot = resourceIdentity.slots[slotName];
      if (slot.status !== "resolved" || !slot.fileRefId) {
        const state = slotFailureState(resourceIdentity);
        const code = slot.errors[0] ?? resourceIdentity.errors[0] ?? BLOCKER.identityMissing;
        facts[names.identity] = fact(names.identity, state, checkedAt, "binding-resolver", code);
        setUnverifiedPhysicalFacts(facts, names, checkedAt, code);
        return {};
      }
      let ref: FileRef | undefined;
      try {
        ref = await dependencies.readActiveFileRef(slot.fileRefId);
      } catch {
        facts[names.identity] = fact(names.identity, "not-verified", checkedAt, "file-ref-metadata", BLOCKER.bindingUnavailable);
        setUnverifiedPhysicalFacts(facts, names, checkedAt, BLOCKER.bindingUnavailable);
        return {};
      }
      if (!ref || !validateActiveRef(ref, validationInput, slotName, expectedResourceKind)) {
        facts[names.identity] = fact(names.identity, "not-ready", checkedAt, "file-ref-metadata", ref ? BLOCKER.identityChanged : BLOCKER.identityMissing);
        setUnverifiedPhysicalFacts(facts, names, checkedAt, ref ? BLOCKER.identityChanged : BLOCKER.identityMissing);
        return { ref };
      }
      facts[names.identity] = fact(names.identity, "ready", checkedAt, "file-ref-metadata");
      const managedRoot = rootStatus.status === "configured" && rootStatus.managedRoot
        ? rootStatus.managedRoot
        : undefined;
      if (ref.locationMode === "managed" && !managedRoot) {
        facts[names.exists] = fact(names.exists, "not-verified", checkedAt, "native-path-metadata", BLOCKER.rootUnavailable);
        facts[names.actualType] = fact(names.actualType, "not-verified", checkedAt, "native-path-metadata", BLOCKER.rootUnavailable);
        facts[names.contained] = fact(
          names.contained,
          "not-ready",
          checkedAt,
          "path-placement-metadata",
          rootStatus.status === "invalid" ? rootStatus.errorCode : BLOCKER.rootUnavailable
        );
        facts[names.noEscape] = fact(names.noEscape, "not-verified", checkedAt, "path-placement-metadata", BLOCKER.rootUnavailable);
        return { ref };
      }
      let physical: FileRefAvailabilityResult;
      try {
        physical = await dependencies.inspectPathMetadata({
          path: ref.path,
          resourceKind: ref.resourceKind,
          locationMode: ref.locationMode,
          configuredRoot: managedRoot
        });
      } catch {
        physical = {
          status: "not_verified",
          path: ref.path,
          expectedResourceKind: ref.resourceKind,
          errorCode: BLOCKER.physicalNotVerified
        };
      }
      return applyPhysicalResult(facts, names, ref, physical, managedRoot, checkedAt);
    }

    const defaultFolder = await inspectBoundResource(
      "defaultFolderFileRefId",
      DEFAULT_FOLDER_FACTS,
      "folder"
    );
    const defaultManuscript = await inspectBoundResource(
      "defaultManuscriptFileRefId",
      DEFAULT_MANUSCRIPT_FACTS,
      "file"
    );
    await inspectBoundResource("currentFileRefId", CURRENT_MANUSCRIPT_FACTS, "file");

    const defaultBindingState = identity.status === "error"
      ? "not-verified"
      : identity.binding
        && facts[DEFAULT_FOLDER_FACTS.identity]?.state === "ready"
        && facts[DEFAULT_MANUSCRIPT_FACTS.identity]?.state === "ready"
        ? "ready"
        : "not-ready";
    const currentBindingState = identity.status === "error"
      ? "not-verified"
      : identity.binding && facts[CURRENT_MANUSCRIPT_FACTS.identity]?.state === "ready"
        ? "ready"
        : "not-ready";
    facts["default-binding"] = fact(
      "default-binding",
      defaultBindingState,
      checkedAt,
      "binding-resolver",
      identity.errors[0] ?? BLOCKER.bindingUnavailable
    );
    facts["current-binding"] = fact(
      "current-binding",
      currentBindingState,
      checkedAt,
      "binding-resolver",
      identity.errors[0] ?? BLOCKER.bindingUnavailable
    );

    if (defaultFolder.ref && defaultManuscript.ref) {
      let canonicalPlacement = false;
      try {
        canonicalPlacement = createPathIdentityKey(defaultManuscript.ref.path)
          === createPathIdentityKey(
            buildManagedManuscriptPath(defaultFolder.ref.path, descriptor.defaultFilename)
          );
      } catch {
        canonicalPlacement = false;
      }
      if (!canonicalPlacement) {
        facts["default-manuscript-contained"] = fact(
          "default-manuscript-contained",
          "not-ready",
          checkedAt,
          "path-placement-metadata",
          BLOCKER.canonicalPlacement
        );
      }
    }

    facts["read-permission"] = fact(
      "read-permission",
      "not-verified",
      checkedAt,
      "capability-not-proven-by-metadata",
      BLOCKER.readPermission
    );
    facts["write-permission"] = fact(
      "write-permission",
      "not-verified",
      checkedAt,
      "capability-not-proven-by-metadata",
      BLOCKER.writePermission
    );

    let parentPlacementReadiness: ManuscriptProvisioningReadinessState | undefined;
    if (descriptor.ownerType === "experimentRun") {
      const parent = input.parentExperiment;
      if (!parent) {
        for (const kind of [
          "parent-experiment-active",
          "parent-default-folder-identity",
          "parent-default-folder-exists",
          "parent-default-folder-actual-type",
          "parent-default-folder-contained",
          "parent-default-folder-no-escape",
          "child-placement-unique"
        ] as const) {
          facts[kind] = fact(kind, "not-verified", checkedAt, "external-lifecycle-input", BLOCKER.parentMissing);
        }
      } else {
        await dependencies.withOwnerAuthority({
          ownerType: "experiment",
          ownerId: parent.ownerId,
          manuscriptChannel: "primary"
        }, async (parentAuthority) => {
          facts["parent-experiment-active"] = fact(
            "parent-experiment-active",
            parentAuthority.ownerScope.status === "active"
              ? "ready"
              : parentAuthority.ownerScope.status === "deleted"
                ? "not-ready"
                : "not-verified",
            checkedAt,
            "external-lifecycle-input",
            parentAuthority.ownerScope.status === "deleted"
              ? BLOCKER.parentDeleted
              : BLOCKER.parentActive
          );
          let parentIdentity: ManuscriptBindingIdentityResult;
          const parentInspectionInput: FormalReadinessInspectionInput = {
            request: {
              intent: "inspect-readiness",
              requestedAt: input.request.requestedAt,
              key: {
                ownerType: "experiment",
                ownerId: parent.ownerId,
                manuscriptChannel: "primary"
              }
            }
          };
          try {
            const resolved = await dependencies.resolveBindingIdentity(
              parentInspectionInput.request.key
            );
            parentIdentity = {
              ...resolved,
              ownerScope: parentAuthority.ownerScope
            };
          } catch {
            parentIdentity = resolverFailure(
              parentInspectionInput,
              parentAuthority.ownerScope,
              "primary"
            );
          }
          const parentFolder = await inspectBoundResource(
            "defaultFolderFileRefId",
            PARENT_FOLDER_FACTS,
            "folder",
            parentInspectionInput,
            parentIdentity
          );
          const placementFactsReady = [
            facts["parent-default-folder-identity"],
            facts["parent-default-folder-exists"],
            facts["parent-default-folder-actual-type"],
            facts["parent-default-folder-contained"],
            facts["parent-default-folder-no-escape"],
            facts["default-folder-identity"],
            facts["default-folder-exists"],
            facts["default-folder-actual-type"],
            facts["default-folder-contained"],
            facts["default-folder-no-escape"]
          ].every((item) => item?.state === "ready");
          const unique = Boolean(
            placementFactsReady
            && parentFolder.canonicalPath
            && defaultFolder.canonicalPath
            && isPathWithinDirectory(parentFolder.canonicalPath, defaultFolder.canonicalPath)
          );
          facts["child-placement-unique"] = fact(
            "child-placement-unique",
            unique ? "ready" : placementFactsReady ? "not-ready" : "not-verified",
            checkedAt,
            "path-placement-metadata",
            BLOCKER.childPlacement
          );
        });
      }
      parentPlacementReadiness = evaluateExperimentRunParentPlacementReadiness(facts);
    }

    const readiness = inspectionReadiness(
      evaluateManuscriptResourceReadiness(descriptor, "inspect-readiness", facts)
    );
    return {
      authority: "resource-ready",
      key: input.request.key,
      descriptor,
      identity,
      identityFact: identityFact(identity, checkedAt),
      eligibility: authorityFacts.eligibility,
      facts,
      readiness,
      blockers: blockersFromFacts(facts),
      ...(parentPlacementReadiness ? { parentPlacementReadiness } : {}),
      inspectedAt: checkedAt,
      provenance: metadataProvenance("native-path-metadata")
    };
  }

  async function inspectOwnerChannel(
    input: FormalReadinessInspectionInput
  ): Promise<ManuscriptProvisioningReadinessInspection> {
    return dependencies.withOwnerAuthority(
      input.request.key,
      (authorityFacts) =>
        inspectOwnerChannelWithAuthority(input, authorityFacts)
    );
  }

  async function inspectLiterature(
    input: FormalLiteratureInspectionInput
  ): Promise<LiteratureProvisioningReadinessInspection> {
    // Both channel inspections share the same owner authority hierarchy.
    // Run them in channel order so independent leases cannot contend at the
    // shared owner boundary in the production authority manager.
    const outline = await inspectOwnerChannel({
        request: {
          intent: "inspect-readiness",
          requestedAt: input.requestedAt,
          key: {
            ownerType: "literature",
            ownerId: input.ownerId,
            manuscriptChannel: "literature_outline"
          }
        }
      });
    const notes = await inspectOwnerChannel({
        request: {
          intent: "inspect-readiness",
          requestedAt: input.requestedAt,
          key: {
            ownerType: "literature",
            ownerId: input.ownerId,
            manuscriptChannel: "dedicated_notes"
          }
        }
      });
    const inspectedAt = dependencies.now();
    const outlineFolder = outline.identity.slots.defaultFolderFileRefId;
    const notesFolder = notes.identity.slots.defaultFolderFileRefId;
    const sharedState: ManuscriptProvisioningReadinessState =
      outline.facts["default-folder-identity"]?.state !== "ready"
      || notes.facts["default-folder-identity"]?.state !== "ready"
        ? combineManuscriptReadiness([
            outline.facts["default-folder-identity"],
            notes.facts["default-folder-identity"]
          ])
        : outlineFolder.fileRefId === notesFolder.fileRefId
          ? "ready"
          : "not-ready";
    const sharedFolderIdentity = fact(
      "shared-folder-identity-match",
      sharedState,
      inspectedAt,
      "file-ref-metadata",
      BLOCKER.sharedFolder
    );
    const readiness = inspectionReadiness({
      intent: "inspect-readiness",
      readReady: combineManuscriptReadiness([
        outline.readiness.readReady,
        notes.readiness.readReady
      ]),
      writeReady: combineManuscriptReadiness([
        outline.readiness.writeReady,
        notes.readiness.writeReady,
        sharedFolderIdentity
      ]),
      defaultResourceReady: combineManuscriptReadiness([
        outline.readiness.defaultResourceReady,
        notes.readiness.defaultResourceReady,
        sharedFolderIdentity
      ]),
      currentResourceReady: combineManuscriptReadiness([
        outline.readiness.currentResourceReady,
        notes.readiness.currentResourceReady
      ])
    });
    return {
      authority: "resource-ready",
      ownerId: input.ownerId,
      channels: {
        literature_outline: outline,
        dedicated_notes: notes
      },
      sharedFolderIdentity,
      readiness,
      blockers: [
        ...outline.blockers,
        ...notes.blockers,
        ...(sharedFolderIdentity.state === "ready"
          ? []
          : [{
              factKind: sharedFolderIdentity.kind,
              state: sharedFolderIdentity.state,
              code: sharedFolderIdentity.blockerCode ?? BLOCKER.sharedFolder
            }])
      ],
      inspectedAt,
      provenance: metadataProvenance("native-path-metadata")
    };
  }

  return Object.freeze({ inspectOwnerChannel, inspectLiterature });
}

export const manuscriptProvisioningReadinessInspector =
  createManuscriptProvisioningReadinessInspector({
    resolveBindingIdentity: manuscriptBindingIdentityResolver.resolve,
    readActiveFileRef: fileRefService.getById,
    getManagedRootStatus: managedRootConfigService.getStatus,
    inspectPathMetadata: fileRefService.inspectFileRefAvailability,
    withOwnerAuthority: (key, use) =>
      runWithProvisioningAuthority({
        request: {
          intent: "provisioningRead",
          requestId: `readiness-${key.ownerType}-${key.ownerId}-${key.manuscriptChannel}`,
          ownerType: key.ownerType,
          ownerId: key.ownerId,
          scope: key.manuscriptChannel
        },
        write: (_permit, authority) => {
          const checkedAt = new Date().toISOString();
          return use({
            ownerScope: {
              status: authority.ownerLifecycle === "deleted" ? "deleted" : "active",
              source: "planning-owner-authority-port",
              verifiedAt: checkedAt
            },
            eligibility: {
              authority: "owner-lifecycle-eligibility",
              status: authority.derivedEligibility,
              allowedIntents: PLANNING_OWNER_ALLOWED_PROVISIONING_INTENTS,
              checkedAt,
              provenance: [
                "planning-owner-authority-port",
                `evidence:${authority.evidenceDigest}`
              ]
            }
          });
        }
      }),
    now: () => new Date().toISOString()
  });
