import type {
  AIParseDraftSourceSnapshot,
  AIStandardResult,
  AIStandardResultAction,
  AIStandardResultAggregateRootReceipt,
  AIStandardResultEffectReceipt,
  AIStandardResultLeafEffectReceipt,
  AIStandardResultManuscriptEffect,
  AIStandardResultManuscriptOutcome,
  AIStandardResultTarget,
  AIStandardResultValidationIssue
} from "../types/aiStandardResult";
import type { AIContextSourceRef } from "../types/aiContext";
import {
  AIExperimentEffectNoEffectError,
  AIExperimentEffectUnknownError,
  invokeAIExperimentStandardResultEffect,
  readAIExperimentStandardResultEffect,
  validateAIExperimentStandardResultProposal
} from "./aiExperimentStandardResultAdapter";
import {
  getPreparedAIExperimentManuscriptAuthorizationId,
  invokeAIExperimentManuscriptStandardResultEffect,
  prepareAIExperimentManuscriptTargetAcceptance,
  validateAIExperimentManuscriptStandardResultProposal
} from "./aiExperimentManuscriptStandardResultAdapter";
import {
  invokeAIReviewCreateStandardResultEffect,
  AIReviewCreateEffectUnknownError,
  AIReviewUpdateEffectUnknownError,
  invokeAIReviewUpdateStandardResultEffect,
  readAIReviewCreateStandardResultEffect,
  readAIReviewUpdateStandardResultEffect,
  validateAIReviewStandardResultProposal
} from "./aiReviewStandardResultAdapter";
import {
  invokeAIReviewManuscriptStandardResultEffect,
  readAIReviewManuscriptStandardResultEffect,
  validateAIReviewManuscriptStandardResultProposal
} from "./aiReviewManuscriptStandardResultAdapter";
import {
  invokeAITaskStandardResultEffect,
  validateAITaskStandardResultProposal
} from "./aiTaskStandardResultAdapter";
import {
  AIExperimentRunEffectNoEffectError,
  AIExperimentRunEffectUnknownError,
  invokeAIExperimentRunStandardResultEffect,
  readAIExperimentRunStandardResultEffect,
  validateAIExperimentRunStandardResultProposal
} from "./aiExperimentRunStandardResultAdapter";
import {
  getPreparedAIExperimentRunManuscriptAuthorizationId,
  invokeAIExperimentRunManuscriptStandardResultEffect,
  prepareAIExperimentRunManuscriptTargetAcceptance,
  validateAIExperimentRunManuscriptStandardResultProposal
} from "./aiExperimentRunManuscriptStandardResultAdapter";
import {
  AILiteratureEffectNoEffectError,
  AILiteratureEffectUnknownError,
  invokeAILiteratureStandardResultEffect,
  readAILiteratureStandardResultEffect,
  validateAILiteratureStandardResultProposal
} from "./aiLiteratureStandardResultAdapter";
import {
  getPreparedAILiteratureManuscriptAuthorizationId,
  invokeAILiteratureDedicatedNotesManuscriptStandardResultEffect,
  invokeAILiteratureOutlineManuscriptStandardResultEffect,
  prepareAILiteratureDedicatedNotesManuscriptTargetAcceptance,
  prepareAILiteratureOutlineManuscriptTargetAcceptance,
  validateAILiteratureDedicatedNotesManuscriptStandardResultProposal,
  validateAILiteratureOutlineManuscriptStandardResultProposal
} from "./aiLiteratureOutlineManuscriptStandardResultAdapter";
import { validateAIQuickAnalysisManuscriptStandardResultProposal } from "./aiQuickAnalysisManuscriptStandardResultAdapter";
import {
  AIOutputsEffectNoEffectError,
  AIOutputsEffectUnknownError,
  invokeAIOutputsStandardResultEffect,
  isAIOutputsModule,
  readAIOutputsStandardResultEffect,
  validateAIOutputsStandardResultProposal
} from "./aiOutputsStandardResultAdapter";
import {
  invokeAIRouteStandardResultEffect,
  validateAIRouteStandardResultProposal
} from "./aiRouteStandardResultAdapter";
import {
  attachAIStandardResultManuscriptEffects,
  canonicalAIStandardResultFingerprint,
  internalAIStandardResultManuscriptEffectId,
  readAIStandardResultBlockingValidationIssues,
  readAIStandardResultManuscriptEffects,
  stripAIStandardResultManuscriptEffects
} from "./aiStandardResultService";
import {
  applyStandardOperationCandidateEffect,
  readStandardOperationCandidateEffect
} from "./standardOperationCandidateApplicationService";

export type AIStandardResultAdapterValidation = {
  executable: boolean;
  normalizedPayload: Record<string, unknown>;
  validationIssues: AIStandardResultValidationIssue[];
  targetSnapshotFingerprint?: string;
  resolvedTarget?: AIStandardResultTarget;
};

export type AIStandardResultFormalEffectOutcome =
  | { kind: "settled"; receipt: AIStandardResultEffectReceipt }
  | { kind: "pending"; code: string; message: string }
  | { kind: "no_effect_failure"; code: string; message: string };

async function validateAIStandardResultSingleProposal(input: {
  action: AIStandardResultAction;
  target: AIStandardResultTarget;
  source?: AIParseDraftSourceSnapshot;
  frozenContextSourceRefs?: readonly AIContextSourceRef[];
  payload: unknown;
  expectedProjectId: string;
  expectedTargetSnapshotFingerprint?: string;
  fallbackSections?: readonly string[];
}): Promise<AIStandardResultAdapterValidation> {
  if (input.target.module === "route") {
    return validateAIRouteStandardResultProposal(input);
  }
  if (input.target.module === "task") {
    return validateAITaskStandardResultProposal(input);
  }
  if (input.target.module === "experiment") {
    if (input.action === "NEW_MANUSCRIPT") {
      return validateAIExperimentManuscriptStandardResultProposal({
        target: input.target,
        source: input.source,
        payload: input.payload,
        expectedProjectId: input.expectedProjectId,
        expectedTargetSnapshotFingerprint: input.expectedTargetSnapshotFingerprint
      });
    }
    return validateAIExperimentStandardResultProposal(input);
  }
  if (input.target.module === "experimentRun") {
    if (input.action === "NEW_MANUSCRIPT") {
      return validateAIExperimentRunManuscriptStandardResultProposal({
        target: input.target,
        source: input.source,
        payload: input.payload,
        expectedProjectId: input.expectedProjectId,
        expectedTargetSnapshotFingerprint: input.expectedTargetSnapshotFingerprint
      });
    }
    return validateAIExperimentRunStandardResultProposal(input);
  }
  if (input.target.module === "literature") {
    if (input.action === "NEW_MANUSCRIPT") {
      const exactInput = {
        target: input.target,
        source: input.source,
        payload: input.payload,
        expectedProjectId: input.expectedProjectId,
        expectedTargetSnapshotFingerprint: input.expectedTargetSnapshotFingerprint
      };
      if (input.target.manuscriptChannel === "literature_outline") {
        return validateAILiteratureOutlineManuscriptStandardResultProposal(exactInput);
      }
      if (input.target.manuscriptChannel === "dedicated_notes") {
        return validateAILiteratureDedicatedNotesManuscriptStandardResultProposal(exactInput);
      }
      return {
        executable: false,
        normalizedPayload: {},
        validationIssues: [{
          code: "LITERATURE_MANUSCRIPT_CHANNEL_UNSUPPORTED",
          message: "Literature NEW_MANUSCRIPT requires exactly literature_outline or dedicated_notes.",
          field: "target.manuscriptChannel"
        }]
      };
    }
    return validateAILiteratureStandardResultProposal(input);
  }
  if (isAIOutputsModule(input.target.module)) {
    return input.action === "NEW_MANUSCRIPT"
      ? validateAIQuickAnalysisManuscriptStandardResultProposal(input)
      : validateAIOutputsStandardResultProposal({
          ...input,
          frozenContextSourceRefs: input.frozenContextSourceRefs
        });
  }
  if (input.target.module === "review" && input.action === "NEW_MANUSCRIPT") {
    return validateAIReviewManuscriptStandardResultProposal({
      target: input.target,
      payload: input.payload,
      expectedProjectId: input.expectedProjectId,
      expectedTargetSnapshotFingerprint: input.expectedTargetSnapshotFingerprint
    });
  }
  if (input.target.module === "review") return validateAIReviewStandardResultProposal(input);
  return {
    executable: false,
    normalizedPayload: {},
    validationIssues: [{
      code: "STANDARD_RESULT_TARGET_UNSUPPORTED",
      message: "The Standard Result target has no canonical adapter."
    }]
  };
}

async function invokeAIStandardResultSingleFormalEffect(input: {
  result: AIStandardResult;
  normalizedPayload: Record<string, unknown>;
  invocationMode?: "initial" | "continuation";
}): Promise<AIStandardResultFormalEffectOutcome> {
  const { result } = input;
  if (result.target.module === "route") {
    if (result.action !== "CREATE" && result.action !== "UPDATE") {
      return {
        kind: "no_effect_failure",
        code: "STANDARD_RESULT_NON_EXECUTABLE",
        message: `${result.action} has no Route formal-effect executor.`
      };
    }
    const receipt = await invokeAIRouteStandardResultEffect({
      action: result.action,
      target: result.target,
      normalizedPayload: input.normalizedPayload
    });
    return { kind: "settled", receipt };
  }
  if (result.target.module === "task") {
    if (result.action !== "CREATE" && result.action !== "UPDATE") {
      return {
        kind: "no_effect_failure",
        code: "STANDARD_RESULT_NON_EXECUTABLE",
        message: `${result.action} has no Task formal-effect executor.`
      };
    }
    const receipt = await invokeAITaskStandardResultEffect({
      action: result.action,
      target: result.target,
      normalizedPayload: input.normalizedPayload
    });
    return { kind: "settled", receipt };
  }
  if (result.target.module === "experiment") {
    if (result.action === "NEW_MANUSCRIPT") {
      return invokeAIExperimentManuscriptStandardResultEffect({
        result,
        normalizedPayload: input.normalizedPayload,
        invocationMode: input.invocationMode ?? "initial"
      });
    }
    if (result.action !== "CREATE" && result.action !== "UPDATE") {
      return {
        kind: "no_effect_failure",
        code: "STANDARD_RESULT_NON_EXECUTABLE",
        message: `${result.action} has no Experiment formal-effect executor.`
      };
    }
    try {
      const receipt = await invokeAIExperimentStandardResultEffect({
        result,
        normalizedPayload: input.normalizedPayload
      });
      return { kind: "settled", receipt };
    } catch (error) {
      if (error instanceof AIExperimentEffectUnknownError) {
        return {
          kind: "pending",
          code: "EXPERIMENT_EFFECT_PENDING",
          message: error.message
        };
      }
      if (error instanceof AIExperimentEffectNoEffectError) {
        return {
          kind: "no_effect_failure",
          code: error.code,
          message: error.message
        };
      }
      throw error;
    }
  }
  if (result.target.module === "experimentRun") {
    if (result.action === "NEW_MANUSCRIPT") {
      return invokeAIExperimentRunManuscriptStandardResultEffect({
        result,
        normalizedPayload: input.normalizedPayload,
        invocationMode: input.invocationMode ?? "initial"
      });
    }
    if (result.action !== "CREATE" && result.action !== "UPDATE") {
      return {
        kind: "no_effect_failure",
        code: "STANDARD_RESULT_NON_EXECUTABLE",
        message: `${result.action} has no ExperimentRun formal-effect executor.`
      };
    }
    try {
      const receipt = await invokeAIExperimentRunStandardResultEffect({
        result,
        normalizedPayload: input.normalizedPayload
      });
      return { kind: "settled", receipt };
    } catch (error) {
      if (error instanceof AIExperimentRunEffectUnknownError) {
        return {
          kind: "pending",
          code: "EXPERIMENT_RUN_EFFECT_PENDING",
          message: error.message
        };
      }
      if (error instanceof AIExperimentRunEffectNoEffectError) {
        return {
          kind: "no_effect_failure",
          code: error.code,
          message: error.message
        };
      }
      throw error;
    }
  }
  if (result.target.module === "literature") {
    if (result.action === "NEW_MANUSCRIPT") {
      const exactInput = {
        result,
        normalizedPayload: input.normalizedPayload,
        invocationMode: input.invocationMode ?? "initial"
      };
      if (result.target.manuscriptChannel === "literature_outline") {
        return invokeAILiteratureOutlineManuscriptStandardResultEffect(exactInput);
      }
      if (result.target.manuscriptChannel === "dedicated_notes") {
        return invokeAILiteratureDedicatedNotesManuscriptStandardResultEffect(exactInput);
      }
      return {
        kind: "no_effect_failure",
        code: "LITERATURE_MANUSCRIPT_CHANNEL_UNSUPPORTED",
        message: "Literature NEW_MANUSCRIPT has no wildcard or default channel executor."
      };
    }
    if (result.action !== "CREATE" && result.action !== "UPDATE") {
      return {
        kind: "no_effect_failure",
        code: "STANDARD_RESULT_NON_EXECUTABLE",
        message: `${result.action} has no Literature formal-effect executor.`
      };
    }
    try {
      const receipt = await invokeAILiteratureStandardResultEffect({
        result,
        normalizedPayload: input.normalizedPayload
      });
      return { kind: "settled", receipt };
    } catch (error) {
      if (error instanceof AILiteratureEffectUnknownError) {
        return {
          kind: "pending",
          code: "LITERATURE_EFFECT_PENDING",
          message: error.message
        };
      }
      if (error instanceof AILiteratureEffectNoEffectError) {
        return {
          kind: "no_effect_failure",
          code: error.code,
          message: error.message
        };
      }
      throw error;
    }
  }
  if (isAIOutputsModule(result.target.module)) {
    if (result.action === "NEW_MANUSCRIPT") {
      return {
        kind: "no_effect_failure",
        code: "QUICK_ANALYSIS_DERIVED_APPLICATION_REQUIRED",
        message: `${result.target.module} NEW_MANUSCRIPT requires the canonical derived Quick Analysis application coordinator.`
      };
    }
    if (result.action !== "CREATE" && result.action !== "UPDATE") {
      return {
        kind: "no_effect_failure",
        code: "STANDARD_RESULT_NON_EXECUTABLE",
        message: `${result.action} has no Outputs formal-effect executor.`
      };
    }
    try {
      const receipt = await invokeAIOutputsStandardResultEffect({
        result,
        normalizedPayload: input.normalizedPayload
      });
      return { kind: "settled", receipt };
    } catch (error) {
      if (error instanceof AIOutputsEffectUnknownError) {
        return {
          kind: "pending",
          code: "OUTPUT_EFFECT_PENDING",
          message: error.message
        };
      }
      if (error instanceof AIOutputsEffectNoEffectError) {
        return {
          kind: "no_effect_failure",
          code: error.code,
          message: error.message
        };
      }
      throw error;
    }
  }
  if (result.target.module !== "review") {
    return {
      kind: "no_effect_failure",
      code: "STANDARD_RESULT_TARGET_UNSUPPORTED",
      message: "The Standard Result target has no canonical formal-effect adapter."
    };
  }
  if (result.action === "CREATE") {
    try {
      const receipt = await invokeAIReviewCreateStandardResultEffect({
        target: result.target,
        normalizedPayload: input.normalizedPayload,
        resultId: result.id,
        authorizationId: result.authorizationId ?? ""
      });
      return { kind: "settled", receipt };
    } catch (error) {
      if (error instanceof AIReviewCreateEffectUnknownError) {
        return {
          kind: "pending",
          code: "REVIEW_CREATE_EFFECT_PENDING",
          message: error.message
        };
      }
      throw error;
    }
  }
  if (result.action === "UPDATE") {
    try {
      const receipt = await invokeAIReviewUpdateStandardResultEffect({
        target: result.target,
        normalizedPayload: input.normalizedPayload,
        resultId: result.id,
        authorizationId: result.authorizationId ?? ""
      });
      return { kind: "settled", receipt };
    } catch (error) {
      if (error instanceof AIReviewUpdateEffectUnknownError) {
        return {
          kind: "pending",
          code: "REVIEW_UPDATE_EFFECT_PENDING",
          message: error.message
        };
      }
      throw error;
    }
  }
  if (result.action === "NEW_MANUSCRIPT") {
    return invokeAIReviewManuscriptStandardResultEffect({
      target: result.target,
      normalizedPayload: input.normalizedPayload,
      resultId: result.id,
      occurredAt: result.confirmationStartedAt ?? new Date().toISOString()
    });
  }
  return {
    kind: "no_effect_failure",
    code: "STANDARD_RESULT_NON_EXECUTABLE",
    message: `${result.action} has no Review formal-effect executor in LP13-B1-A7.`
  };
}

/** Read-only same-operation recovery probe. It never dispatches a new business write. */
async function readAIStandardResultSingleFormalEffect(
  result: AIStandardResult
): Promise<AIStandardResultEffectReceipt | undefined> {
  if (result.target.module === "review" && result.action === "CREATE") {
    return readAIReviewCreateStandardResultEffect({
      target: result.target,
      resultId: result.id
    });
  }
  if (result.target.module === "review" && result.action === "UPDATE" && result.confirmedPayload) {
    const validation = await validateAIReviewStandardResultProposal({
      action: result.action,
      target: result.target,
      payload: result.confirmedPayload,
      expectedProjectId: result.source.projectId
    });
    if (!validation.executable || readAIStandardResultBlockingValidationIssues(validation.validationIssues).length > 0) return undefined;
    return readAIReviewUpdateStandardResultEffect({
      target: result.target,
      resultId: result.id,
      normalizedPayload: validation.normalizedPayload
    });
  }
  if (result.target.module === "experiment" && (result.action === "CREATE" || result.action === "UPDATE")) {
    return readAIExperimentStandardResultEffect({ result });
  }
  if (result.target.module === "experimentRun" && (result.action === "CREATE" || result.action === "UPDATE")) {
    return readAIExperimentRunStandardResultEffect({ result });
  }
  if (result.target.module === "literature" && (result.action === "CREATE" || result.action === "UPDATE")) {
    return readAILiteratureStandardResultEffect({ result });
  }
  if (
    isAIOutputsModule(result.target.module) &&
    (result.action === "CREATE" || result.action === "UPDATE") &&
    result.confirmedPayload
  ) {
    return readAIOutputsStandardResultEffect({
      result,
      normalizedPayload: result.confirmedPayload
    });
  }
  return undefined;
}

function parentBusinessEffectRequested(input: {
  action: AIStandardResultAction;
  businessPayload: Record<string, unknown>;
}): boolean {
  return input.action === "CREATE" ||
    input.action === "DELETE_SUGGESTION" ||
    input.action === "UPDATE" && Object.keys(input.businessPayload).length > 0;
}

function internalManuscriptTarget(input: {
  parentTarget: AIStandardResultTarget;
  entityId: string;
  channel: AIStandardResultManuscriptEffect["channel"];
}): AIStandardResultTarget {
  const { parentTarget, entityId, channel } = input;
  return {
    ...parentTarget,
    entityId,
    manuscriptChannel: channel
  } as AIStandardResultTarget;
}

function generatedOwnerSource(input: {
  parent: AIStandardResult;
  entityId: string;
  businessReceipt?: AIStandardResultEffectReceipt;
}): AIParseDraftSourceSnapshot {
  const source = structuredClone(input.parent.source);
  if (input.parent.action !== "CREATE") return source;
  if (input.parent.target.module === "review") {
    source.selectedReviewIds = [input.entityId];
    return source;
  }
  if (input.parent.target.module === "experiment") {
    source.selectedExperimentIds = [input.entityId];
    return source;
  }
  if (input.parent.target.module === "experimentRun") {
    const readbackParent = input.businessReceipt?.canonicalReadback.experimentId;
    const parentExperimentId = typeof readbackParent === "string" && readbackParent.trim()
      ? readbackParent
      : input.parent.target.parentExperimentId;
    source.selectedExperimentRunIds = [input.entityId];
    if (parentExperimentId) {
      source.selectedExperimentIds = [parentExperimentId];
      source.experimentRunParentRelations = [{
        runId: input.entityId,
        parentExperimentId,
        projectId: input.parent.target.projectId,
        selectionOrder: 0
      }];
    }
    return source;
  }
  if (input.parent.target.module === "literature") {
    source.selectedLiteratureIds = [input.entityId];
    source.literatureAssociationTuples = [{
      literatureId: input.entityId,
      projectAssociationKind: "projectless",
      canonicalProjectId: null,
      lifecycleEligibility: "eligible",
      conversationProjectEligibilityDisposition: "allowed_global_projectless",
      selectionOrder: 0,
      normalizedProjectionFingerprint: canonicalAIStandardResultFingerprint({
        literatureId: input.entityId,
        canonicalProjectId: null,
        generatedByParentResultId: input.parent.id
      })
    }];
    source.literatureSelectionAggregateEligibility = "ALLOWED";
  }
  return source;
}

/**
 * Builds the minimum adapter-only carrier required by the existing writer. It
 * is never persisted, listed, or exposed as a formal operation card.
 */
export function buildAIStandardResultInternalManuscriptEffect(input: {
  parent: AIStandardResult;
  effect: AIStandardResultManuscriptEffect;
  entityId: string;
  businessReceipt?: AIStandardResultEffectReceipt;
}): AIStandardResult {
  const payload = { body: input.effect.body };
  const fingerprint = canonicalAIStandardResultFingerprint(payload);
  return {
    ...input.parent,
    id: internalAIStandardResultManuscriptEffectId(input.parent.id, input.effect.channel),
    category: "MANUSCRIPT_RESULT",
    action: "NEW_MANUSCRIPT",
    target: internalManuscriptTarget({
      parentTarget: input.parent.target,
      entityId: input.entityId,
      channel: input.effect.channel
    }),
    source: generatedOwnerSource({
      parent: input.parent,
      entityId: input.entityId,
      businessReceipt: input.businessReceipt
    }),
    originalPayload: payload,
    visiblePayload: payload,
    visiblePayloadFingerprint: fingerprint,
    validationIssues: [],
    disposition: "PENDING",
    confirmedPayload: payload,
    confirmedPayloadFingerprint: fingerprint,
    targetSnapshotFingerprint: undefined,
    effectReceipt: undefined,
    failureCode: undefined,
    failureMessage: undefined
  };
}

function parentStaleIssue(target: AIStandardResultTarget): AIStandardResultValidationIssue {
  if (target.module === "experiment") {
    return {
      code: "EXPERIMENT_MANUSCRIPT_TARGET_STALE",
      message: "The Experiment business/manuscript target changed after Parse Draft."
    };
  }
  if (target.module === "experimentRun") {
    return {
      code: "EXPERIMENT_RUN_MANUSCRIPT_TARGET_STALE",
      message: "The ExperimentRun business/manuscript target changed after Parse Draft."
    };
  }
  if (target.module === "literature") {
    return {
      code: "LITERATURE_OUTLINE_MANUSCRIPT_TARGET_STALE",
      message: "The Literature business/manuscript target changed after Parse Draft."
    };
  }
  return {
    code: "REVIEW_MANUSCRIPT_TARGET_STALE",
    message: "The Review business/manuscript target changed after Parse Draft."
  };
}

export async function validateAIStandardResultProposal(input: {
  action: AIStandardResultAction;
  target: AIStandardResultTarget;
  source?: AIParseDraftSourceSnapshot;
  frozenContextSourceRefs?: readonly AIContextSourceRef[];
  payload: unknown;
  expectedProjectId: string;
  expectedTargetSnapshotFingerprint?: string;
  fallbackSections?: readonly string[];
}): Promise<AIStandardResultAdapterValidation> {
  if (input.action === "NEW_MANUSCRIPT") {
    return validateAIStandardResultSingleProposal(input);
  }
  const payload = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
    ? input.payload as Record<string, unknown>
    : {};
  const effects = readAIStandardResultManuscriptEffects(payload, {
    action: input.action,
    target: input.target
  });
  const businessPayload = stripAIStandardResultManuscriptEffects(payload);
  const businessRequested = parentBusinessEffectRequested({
    action: input.action,
    businessPayload
  });
  if (!businessRequested && effects.length === 0) {
    return {
      executable: false,
      normalizedPayload: {},
      validationIssues: [{
        code: "STANDARD_RESULT_PARENT_HAS_NO_EFFECT",
        message: "CREATE/UPDATE requires a canonical business effect or at least one explicit manuscript effect."
      }]
    };
  }
  if (input.action === "DELETE_SUGGESTION" || effects.length === 0) {
    return validateAIStandardResultSingleProposal({ ...input, payload: businessPayload });
  }

  const businessValidation: AIStandardResultAdapterValidation = businessRequested
    ? await validateAIStandardResultSingleProposal({
        ...input,
        payload: businessPayload,
        expectedTargetSnapshotFingerprint: undefined
      })
    : {
        executable: true,
        normalizedPayload: {},
        validationIssues: [],
        resolvedTarget: input.target
      };
  const effectTarget = businessValidation.resolvedTarget ?? input.target;
  const effectValidations: Array<{
    effect: AIStandardResultManuscriptEffect;
    validation: AIStandardResultAdapterValidation;
  }> = [];
  for (const effect of effects) {
    if (input.action === "CREATE") {
      effectValidations.push({
        effect,
        validation: {
          executable: true,
          normalizedPayload: { body: effect.body },
          validationIssues: []
        }
      });
      continue;
    }
    if (!effectTarget.entityId) {
      effectValidations.push({
        effect,
        validation: {
          executable: false,
          normalizedPayload: { body: effect.body },
          validationIssues: [{
            code: "STANDARD_RESULT_MANUSCRIPT_EFFECT_OWNER_REQUIRED",
            message: "UPDATE manuscript effects require the exact existing parent identity.",
            field: "target.entityId"
          }]
        }
      });
      continue;
    }
    effectValidations.push({
      effect,
      validation: {
        executable: true,
        normalizedPayload: { body: effect.body },
        validationIssues: [],
        targetSnapshotFingerprint: canonicalAIStandardResultFingerprint({
          kind: "STANDARD_OPERATION_MANAGED_MANUSCRIPT_TARGET",
          target: effectTarget,
          projectId: input.expectedProjectId,
          manuscriptChannel: effect.channel
        })
      }
    });
  }
  const normalizedEffects = effectValidations.map(({ effect, validation }) => ({
    channel: effect.channel,
    body: typeof validation.normalizedPayload.body === "string"
      ? validation.normalizedPayload.body
      : effect.body
  }));
  const fingerprintComponents = {
    business: businessValidation.targetSnapshotFingerprint ?? null,
    manuscriptEffects: effectValidations.map(({ effect, validation }) => ({
      channel: effect.channel,
      targetSnapshotFingerprint: validation.targetSnapshotFingerprint ?? null
    }))
  };
  const hasTargetFingerprint = Boolean(
    businessValidation.targetSnapshotFingerprint ||
    effectValidations.some(({ validation }) => validation.targetSnapshotFingerprint)
  );
  const targetSnapshotFingerprint = hasTargetFingerprint
    ? canonicalAIStandardResultFingerprint(fingerprintComponents)
    : undefined;
  const validationIssues = [
    ...businessValidation.validationIssues,
    ...effectValidations.flatMap(({ validation }) => validation.validationIssues)
  ];
  if (
    input.expectedTargetSnapshotFingerprint &&
    input.expectedTargetSnapshotFingerprint !== targetSnapshotFingerprint
  ) {
    validationIssues.push(parentStaleIssue(input.target));
  }
  const blockingIssues = readAIStandardResultBlockingValidationIssues(validationIssues);
  return {
    executable: businessValidation.executable &&
      effectValidations.every(({ validation }) => validation.executable) &&
      blockingIssues.length === 0,
    normalizedPayload: attachAIStandardResultManuscriptEffects(
      businessValidation.normalizedPayload,
      normalizedEffects
    ),
    validationIssues,
    ...(targetSnapshotFingerprint ? { targetSnapshotFingerprint } : {}),
    ...(businessValidation.resolvedTarget ? { resolvedTarget: businessValidation.resolvedTarget } : {})
  };
}

export type AIStandardResultManuscriptTargetAcceptanceOutcome =
  | { status: "accepted"; targetFileName: string }
  | { status: "canceled" }
  | { status: "not_required" };

export function preparedAIStandardResultManuscriptAuthorizationId(
  child: AIStandardResult
): string | undefined {
  if (child.target.module === "experiment") {
    return getPreparedAIExperimentManuscriptAuthorizationId(child);
  }
  if (child.target.module === "experimentRun") {
    return getPreparedAIExperimentRunManuscriptAuthorizationId(child);
  }
  if (child.target.module === "literature") {
    return getPreparedAILiteratureManuscriptAuthorizationId(child);
  }
  return undefined;
}

export async function prepareAIStandardResultManuscriptEffectTarget(input: {
  parent: AIStandardResult;
  effect: AIStandardResultManuscriptEffect;
  entityId: string;
  plannedAuthorizationId: string;
  businessReceipt?: AIStandardResultEffectReceipt;
}): Promise<AIStandardResultManuscriptTargetAcceptanceOutcome> {
  const child = buildAIStandardResultInternalManuscriptEffect({
    parent: input.parent,
    effect: input.effect,
    entityId: input.entityId,
    businessReceipt: input.businessReceipt
  });
  const validation = await validateAIStandardResultSingleProposal({
    action: child.action,
    target: child.target,
    source: child.source,
    payload: child.visiblePayload,
    expectedProjectId: child.source.projectId
  });
  if (!validation.executable || readAIStandardResultBlockingValidationIssues(validation.validationIssues).length > 0) {
    throw new Error(
      validation.validationIssues.map((candidate) => candidate.message).join(" ") ||
      "The internal manuscript effect is not mechanically executable."
    );
  }
  if (child.target.module === "review") return { status: "not_required" };
  if (child.target.module === "experiment") {
    return prepareAIExperimentManuscriptTargetAcceptance({
      result: child,
      normalizedPayload: validation.normalizedPayload,
      plannedAuthorizationId: input.plannedAuthorizationId
    });
  }
  if (child.target.module === "experimentRun") {
    return prepareAIExperimentRunManuscriptTargetAcceptance({
      result: child,
      normalizedPayload: validation.normalizedPayload,
      plannedAuthorizationId: input.plannedAuthorizationId
    });
  }
  if (child.target.module === "literature") {
    return child.target.manuscriptChannel === "literature_outline"
      ? prepareAILiteratureOutlineManuscriptTargetAcceptance({
          result: child,
          normalizedPayload: validation.normalizedPayload,
          plannedAuthorizationId: input.plannedAuthorizationId
        })
      : prepareAILiteratureDedicatedNotesManuscriptTargetAcceptance({
          result: child,
          normalizedPayload: validation.normalizedPayload,
          plannedAuthorizationId: input.plannedAuthorizationId
        });
  }
  throw new Error("The parent object has no canonical manuscript target acceptance path.");
}

function aggregateParentReceipt(input: {
  parent: AIStandardResult;
  businessRequested: boolean;
  businessReceipt?: AIStandardResultEffectReceipt;
  manuscriptOutcomes: AIStandardResultManuscriptOutcome[];
}): AIStandardResultEffectReceipt {
  const businessReceipt = input.businessReceipt as AIStandardResultLeafEffectReceipt | undefined;
  const ownerId = businessReceipt?.entityId ?? input.parent.target.entityId;
  if (!ownerId) throw new Error("A settled parent requires one exact canonical owner identity.");
  const settledTarget = {
    ...structuredClone(input.parent.target),
    entityId: ownerId
  } as AIStandardResultTarget;
  const manuscriptReceipts = input.manuscriptOutcomes.flatMap((outcome) =>
    outcome.outcome === "PROVEN_SUCCESS"
      ? [{ channel: outcome.channel, receipt: outcome.receipt }]
      : []
  );
  const outcomeClass = input.manuscriptOutcomes.some((outcome) =>
    outcome.outcome === "PROVEN_NO_EFFECT_FAILURE")
    ? "PROVEN_PARTIAL" as const
    : "FULL_SUCCESS" as const;
  const standardResultParentSettlement = {
    parentResultId: input.parent.id,
    productAction: input.parent.action,
    settledTarget,
    outcomeClass,
    requestedBusinessEffect: input.businessRequested,
    businessOutcome: input.businessRequested ? "PROVEN_SUCCESS" as const : "NOT_REQUESTED" as const,
    requestedManuscriptEffects: input.manuscriptOutcomes.map(({ channel }) => channel),
    settledEffectCount: (businessReceipt ? 1 : 0) + manuscriptReceipts.length,
    businessReceipt: businessReceipt ?? null,
    manuscriptReceipts,
    manuscriptOutcomes: input.manuscriptOutcomes
  };
  if (businessReceipt) {
    return {
      ...businessReceipt,
      standardResultParentSettlement
    } as AIStandardResultEffectReceipt;
  }
  return {
    module: input.parent.target.module,
    entityType: input.parent.target.entityType,
    entityId: ownerId,
    operation: "UPDATE",
    service: "aiStandardResultAdapterService.aggregateParentReceipt",
    canonicalReadback: {
      projectId: input.parent.target.projectId,
      parentResultId: input.parent.id,
      parentAction: "UPDATE",
      parentTarget: settledTarget,
      requestedBusinessEffect: false
    },
    standardResultParentSettlement
  } as AIStandardResultAggregateRootReceipt;
}

type AIStandardResultSingleEffectApplication = (input: {
  result: AIStandardResult;
  normalizedPayload: Record<string, unknown>;
  invocationMode?: "initial" | "continuation";
}) => Promise<AIStandardResultFormalEffectOutcome>;

/**
 * A same-batch CREATE may need an execution-only target projection after its
 * parent business effect settles. Candidate authorization and aggregate
 * settlement must still use the exact durable parent that the user confirmed.
 */
function resolveDurableParentResult(
  executionResult: AIStandardResult,
  durableParentResult?: AIStandardResult
): AIStandardResult {
  if (!durableParentResult) return executionResult;
  const correlated = durableParentResult.id === executionResult.id &&
    durableParentResult.conversationId === executionResult.conversationId &&
    durableParentResult.parseCallAttemptId === executionResult.parseCallAttemptId &&
    durableParentResult.batchId === executionResult.batchId &&
    durableParentResult.ordinal === executionResult.ordinal &&
    durableParentResult.category === executionResult.category &&
    durableParentResult.action === executionResult.action &&
    durableParentResult.target.module === executionResult.target.module &&
    durableParentResult.target.entityType === executionResult.target.entityType &&
    durableParentResult.target.projectId === executionResult.target.projectId &&
    durableParentResult.source.projectId === executionResult.source.projectId &&
    durableParentResult.authorizationId === executionResult.authorizationId &&
    durableParentResult.confirmationStartedAt === executionResult.confirmationStartedAt &&
    durableParentResult.visiblePayloadFingerprint === executionResult.visiblePayloadFingerprint &&
    durableParentResult.confirmedPayloadFingerprint === executionResult.confirmedPayloadFingerprint &&
    canonicalAIStandardResultFingerprint(durableParentResult.originalPayload) ===
      canonicalAIStandardResultFingerprint(executionResult.originalPayload) &&
    canonicalAIStandardResultFingerprint(durableParentResult.visiblePayload) ===
      canonicalAIStandardResultFingerprint(executionResult.visiblePayload) &&
    canonicalAIStandardResultFingerprint(durableParentResult.confirmedPayload) ===
      canonicalAIStandardResultFingerprint(executionResult.confirmedPayload);
  if (!correlated) {
    throw new Error(
      "The execution projection is not exactly correlated with the durable confirmed parent."
    );
  }
  return durableParentResult;
}

export async function invokeAIStandardResultFormalEffect(input: {
  result: AIStandardResult;
  /** Exact persisted parent; execution-only target enrichment never replaces it. */
  durableParentResult?: AIStandardResult;
  normalizedPayload: Record<string, unknown>;
  invocationMode?: "initial" | "continuation";
  /** Deterministic-test boundary; production always uses the defaults. */
  singleEffectApplication?: AIStandardResultSingleEffectApplication;
  /** Deterministic-test boundary for the already-selected business adapter. */
  singleEffectValidation?: typeof validateAIStandardResultSingleProposal;
  /** Deterministic-test boundary before the shared candidate writer. */
  candidateEffectApplication?: typeof applyStandardOperationCandidateEffect;
}): Promise<AIStandardResultFormalEffectOutcome> {
  const durableParent = resolveDurableParentResult(input.result, input.durableParentResult);
  const invokeSingle = input.singleEffectApplication ?? invokeAIStandardResultSingleFormalEffect;
  const validateSingle = input.singleEffectValidation ?? validateAIStandardResultSingleProposal;
  const applyCandidate = input.candidateEffectApplication ?? applyStandardOperationCandidateEffect;
  if (input.result.action === "NEW_MANUSCRIPT") {
    return invokeSingle(input);
  }
  const effects = readAIStandardResultManuscriptEffects(input.normalizedPayload, {
    action: input.result.action,
    target: input.result.target
  });
  if (effects.length === 0) return invokeSingle(input);
  const businessPayload = stripAIStandardResultManuscriptEffects(input.normalizedPayload);
  const businessRequested = parentBusinessEffectRequested({
    action: input.result.action,
    businessPayload
  });
  let businessReceipt: AIStandardResultEffectReceipt | undefined;
  if (businessRequested) {
    const currentBusinessValidation = await validateSingle({
      action: input.result.action,
      target: input.result.target,
      source: input.result.source,
      payload: businessPayload,
      expectedProjectId: input.result.source.projectId,
      expectedTargetSnapshotFingerprint: undefined
    });
    if (
      !currentBusinessValidation.executable ||
      readAIStandardResultBlockingValidationIssues(currentBusinessValidation.validationIssues).length > 0
    ) {
      return {
        kind: "no_effect_failure",
        code: "STANDARD_RESULT_PARENT_BUSINESS_REVALIDATION_FAILED",
        message: currentBusinessValidation.validationIssues.map((issue) => issue.message).join(" ") ||
          "The confirmed parent business effect no longer has an executable canonical target."
      };
    }
    const businessResult: AIStandardResult = {
      ...input.result,
      target: currentBusinessValidation.resolvedTarget ?? input.result.target,
      targetSnapshotFingerprint: currentBusinessValidation.targetSnapshotFingerprint
    };
    const business = await invokeSingle({
      ...input,
      result: businessResult,
      normalizedPayload: currentBusinessValidation.normalizedPayload
    });
    if (business.kind !== "settled") return business;
    businessReceipt = business.receipt;
  }
  const entityId = input.result.action === "CREATE"
    ? businessReceipt?.entityId
    : input.result.target.entityId;
  if (!entityId || !input.result.authorizationId) {
    return {
      kind: "no_effect_failure",
      code: "STANDARD_RESULT_MANUSCRIPT_EFFECT_OWNER_UNAVAILABLE",
      message: "The canonical parent effect did not produce the required manuscript owner identity."
    };
  }
  const manuscriptOutcomes: AIStandardResultManuscriptOutcome[] = [];
  for (let index = 0; index < effects.length; index += 1) {
    const effect = effects[index];
    const effectResultId = internalAIStandardResultManuscriptEffectId(
      input.result.id,
      effect.channel
    );
    const outcome = await applyCandidate({
      parent: durableParent,
      effect,
      effectResultId,
      ownerId: entityId,
      businessReceipt
    });
    if (outcome.kind === "terminal_effect_outcome_unknown") {
      return {
        kind: "pending",
        code: outcome.code,
        message: outcome.message
      };
    }
    if (outcome.kind === "no_effect_failure") {
      if (!businessReceipt && manuscriptOutcomes.length === 0) return outcome;
      manuscriptOutcomes.push({
        effectResultId,
        channel: effect.channel,
        outcome: "PROVEN_NO_EFFECT_FAILURE",
        receipt: null,
        failureCode: outcome.code,
        failureMessage: outcome.message
      });
      for (const unexecuted of effects.slice(index + 1)) {
        manuscriptOutcomes.push({
          effectResultId: internalAIStandardResultManuscriptEffectId(
            input.result.id,
            unexecuted.channel
          ),
          channel: unexecuted.channel,
          outcome: "NOT_REACHED",
          receipt: null,
          failureCode: null,
          failureMessage: null
        });
      }
      return {
        kind: "settled",
        receipt: aggregateParentReceipt({
          parent: durableParent,
          businessRequested,
          businessReceipt,
          manuscriptOutcomes
        })
      };
    }
    manuscriptOutcomes.push({
      effectResultId,
      channel: effect.channel,
      outcome: "PROVEN_SUCCESS",
      receipt: outcome.receipt as AIStandardResultLeafEffectReceipt,
      failureCode: null,
      failureMessage: null
    });
  }
  return {
    kind: "settled",
    receipt: aggregateParentReceipt({
      parent: durableParent,
      businessRequested,
      businessReceipt,
      manuscriptOutcomes
    })
  };
}

async function readAIStandardResultInternalManuscriptEffect(
  child: AIStandardResult,
  normalizedPayload: Record<string, unknown>
): Promise<AIStandardResultEffectReceipt | undefined> {
  if (child.target.module === "review") {
    return readAIReviewManuscriptStandardResultEffect({
      target: child.target,
      resultId: child.id,
      normalizedBody: normalizedPayload.body as string
    });
  }
  const outcome = await invokeAIStandardResultSingleFormalEffect({
    result: child,
    normalizedPayload,
    invocationMode: "continuation"
  });
  return outcome.kind === "settled" ? outcome.receipt : undefined;
}

/** Same-operation durable probe. It never starts a missing child operation. */
export async function readAIStandardResultFormalEffect(
  result: AIStandardResult,
  durableParentResult?: AIStandardResult
): Promise<AIStandardResultEffectReceipt | undefined> {
  const durableParent = resolveDurableParentResult(result, durableParentResult);
  const payload = result.confirmedPayload ?? result.visiblePayload;
  const effects = result.action === "NEW_MANUSCRIPT"
    ? []
    : readAIStandardResultManuscriptEffects(payload, {
        action: result.action,
        target: result.target
      });
  if (effects.length === 0) return readAIStandardResultSingleFormalEffect(result);
  if (!result.authorizationId || !result.confirmedPayload) return undefined;
  const businessPayload = stripAIStandardResultManuscriptEffects(payload);
  const businessRequested = parentBusinessEffectRequested({
    action: result.action,
    businessPayload
  });
  const businessResult: AIStandardResult = {
    ...result,
    confirmedPayload: businessPayload
  };
  const businessReceipt = businessRequested
    ? await readAIStandardResultSingleFormalEffect(businessResult)
    : undefined;
  if (businessRequested && !businessReceipt) return undefined;
  const entityId = result.action === "CREATE"
    ? businessReceipt?.entityId
    : result.target.entityId;
  if (!entityId) return undefined;
  const manuscriptOutcomes: AIStandardResultManuscriptOutcome[] = [];
  for (const effect of effects) {
    let child = buildAIStandardResultInternalManuscriptEffect({
      parent: result,
      effect,
      entityId,
      businessReceipt
    });
    child = { ...child, authorizationId: result.authorizationId };
    const shared = await readStandardOperationCandidateEffect({
      parent: durableParent,
      effect,
      effectResultId: child.id,
      ownerId: entityId,
      businessReceipt
    });
    let receipt = shared.kind === "settled" ? shared.receipt : undefined;
    if (!receipt) {
      const validation = await validateAIStandardResultSingleProposal({
        action: child.action,
        target: child.target,
        source: child.source,
        payload: child.confirmedPayload,
        expectedProjectId: child.source.projectId
      });
      if (
        !validation.executable ||
        readAIStandardResultBlockingValidationIssues(validation.validationIssues).length > 0
      ) return undefined;
      receipt = await readAIStandardResultInternalManuscriptEffect(child, validation.normalizedPayload);
    }
    if (!receipt) return undefined;
    manuscriptOutcomes.push({
      effectResultId: child.id,
      channel: effect.channel,
      outcome: "PROVEN_SUCCESS",
      receipt: receipt as AIStandardResultLeafEffectReceipt,
      failureCode: null,
      failureMessage: null
    });
  }
  return aggregateParentReceipt({
    parent: durableParent,
    businessRequested,
    businessReceipt,
    manuscriptOutcomes
  });
}

export function isAIStandardResultContinuable(result: AIStandardResult): boolean {
  const hasManagedManuscriptEffects = Boolean(
    result.confirmedPayload && result.action !== "NEW_MANUSCRIPT" &&
    readAIStandardResultManuscriptEffects(result.confirmedPayload, {
      action: result.action,
      target: result.target
    }).length > 0
  );
  return result.disposition === "PENDING" && Boolean(
    result.confirmationStartedAt && result.authorizationId && result.confirmedPayload &&
    (
      result.target.module === "review" &&
      (result.action === "CREATE" || result.action === "UPDATE" || result.action === "NEW_MANUSCRIPT") ||
      result.target.module === "experiment" &&
      (result.action === "CREATE" || result.action === "UPDATE" || result.action === "NEW_MANUSCRIPT") ||
      result.target.module === "experimentRun" &&
      (result.action === "CREATE" || result.action === "UPDATE" || result.action === "NEW_MANUSCRIPT") ||
      result.target.module === "literature" &&
      (result.action === "CREATE" || result.action === "UPDATE" || result.action === "NEW_MANUSCRIPT") ||
      isAIOutputsModule(result.target.module) &&
      (result.action === "CREATE" || result.action === "UPDATE") &&
      hasManagedManuscriptEffects
    )
  );
}

export const aiStandardResultAdapterService = {
  validate: validateAIStandardResultProposal,
  invoke: invokeAIStandardResultFormalEffect,
  readEffect: readAIStandardResultFormalEffect,
  isContinuable: isAIStandardResultContinuable
};
