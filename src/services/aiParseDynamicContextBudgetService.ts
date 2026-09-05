import type {
  AIContextRequestableRef,
  AIParseDynamicContextBudgetReceipt,
  AIProviderPromptEnvelope,
  AIProviderPromptHistoryMessage
} from "../types/aiContext";
import type {
  AIContextRequestAlreadySuppliedRef,
  AIContextRequestResponseContract
} from "../types/aiContextRequest";

export type AIProviderTransportRequestableRef = Pick<
  AIContextRequestableRef,
  "refKind" | "refId" | "projectId" | "label" | "allowedContributionKinds"
>;

export type AIProviderTransportAlreadySuppliedRef = Pick<
  AIContextRequestAlreadySuppliedRef,
  "refKind" | "refId" | "projectId" | "contributionKind"
>;

export type AIProviderTransportContextRequestResponseContract = Omit<
  AIContextRequestResponseContract,
  "requestableRefs" | "alreadySuppliedRefs"
> & {
  requestableRefs: AIProviderTransportRequestableRef[];
  alreadySuppliedRefs: AIProviderTransportAlreadySuppliedRef[];
};

export type AIProviderTransportPromptEnvelope = Omit<
  AIProviderPromptEnvelope,
  "contextRequestResponseContract"
> & {
  contextRequestResponseContract?: AIProviderTransportContextRequestResponseContract;
};

function countCharacters(value: string): number {
  return Array.from(value).length;
}

export function toAIProviderTransportContextRequestResponseContract(
  contract: AIContextRequestResponseContract
): AIProviderTransportContextRequestResponseContract {
  return {
    contract: contract.contract,
    wrapperStart: contract.wrapperStart,
    wrapperEnd: contract.wrapperEnd,
    requestableRefs: contract.requestableRefs.map((reference) => ({
      refKind: reference.refKind,
      refId: reference.refId,
      projectId: reference.projectId,
      label: reference.label,
      allowedContributionKinds: [...reference.allowedContributionKinds]
    })),
    alreadySuppliedRefs: contract.alreadySuppliedRefs.map((reference) => ({
      refKind: reference.refKind,
      refId: reference.refId,
      projectId: reference.projectId,
      contributionKind: reference.contributionKind
    })),
    contributionKinds: contract.contributionKinds
  };
}

export function toAIProviderTransportPromptEnvelope(
  envelope: AIProviderPromptEnvelope
): AIProviderTransportPromptEnvelope {
  const contextRequestContract = envelope.contextRequestResponseContract;
  return {
    ...envelope,
    ...(contextRequestContract
      ? {
          contextRequestResponseContract:
            toAIProviderTransportContextRequestResponseContract(contextRequestContract)
        }
      : {})
  };
}

/**
 * Counts the provider-visible conversation carrier while excluding user-role
 * message bodies. Those bodies remain byte-for-byte present in the request but
 * are USER_EXPLICIT_CONTENT rather than software dynamic context.
 */
function conversationContinuityCharacters(
  history: readonly AIProviderPromptHistoryMessage[]
): number {
  if (history.length === 0) return 0;
  return history.reduce((total, message) => (
    total +
    countCharacters("\n\n") +
    countCharacters(`### ${message.role === "user" ? "User" : "Assistant"}\n`) +
    (message.role === "assistant" ? countCharacters(message.content) : 0)
  ), countCharacters("## Prior Canonical Conversation"));
}

export function measureAIParseDynamicContextBudget(
  envelope: AIProviderPromptEnvelope
): AIParseDynamicContextBudgetReceipt {
  const budget = envelope.parseDynamicContextBudget;
  if (
    envelope.constraintDescriptor.category !== "PARSE_DRAFT" ||
    !budget || budget.classification !== "PARSE_DYNAMIC_CONTEXT_BUDGET"
  ) {
    throw new Error("PARSE_DRAFT requires canonical dynamic-context budget metadata.");
  }
  const transportEnvelope = toAIProviderTransportPromptEnvelope(envelope);
  const contract = transportEnvelope.contextRequestResponseContract;
  const components = {
    researchContextCharacters: countCharacters(transportEnvelope.researchContext),
    conversationContinuityCharacters: conversationContinuityCharacters(
      transportEnvelope.conversationHistory
    ),
    requestableRefsCharacters: contract
      ? countCharacters(JSON.stringify(contract.requestableRefs))
      : 0,
    alreadySuppliedRefsCharacters: contract
      ? countCharacters(JSON.stringify(contract.alreadySuppliedRefs))
      : 0,
    quickAnalysisCapabilityCharacters: transportEnvelope.quickAnalysisContextCapability
      ? countCharacters(JSON.stringify(transportEnvelope.quickAnalysisContextCapability))
      : 0,
    contextRequestFollowupCharacters: transportEnvelope.contextRequestFollowupState
      ? countCharacters(JSON.stringify(transportEnvelope.contextRequestFollowupState))
      : 0,
    runScopedMetadataCharacters: budget.runScopedDynamicSegments.reduce(
      (total, segment) => total + countCharacters(segment),
      0
    )
  };
  const estimatedCharacters = Object.values(components).reduce(
    (total, characters) => total + characters,
    0
  );
  return {
    classification: "PARSE_DYNAMIC_CONTEXT_BUDGET",
    includedInputClass: "SOFTWARE_DYNAMIC_CONTEXT",
    excludedInputClasses: ["FIXED_SYSTEM_CONTENT", "USER_EXPLICIT_CONTENT"],
    maxCharacters: budget.maxCharacters,
    estimatedCharacters,
    status: estimatedCharacters <= budget.maxCharacters
      ? "WITHIN_GUARD"
      : "TECHNICAL_CAPACITY_OR_SAFETY_ERROR",
    components
  };
}
