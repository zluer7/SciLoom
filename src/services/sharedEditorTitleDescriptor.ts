import type { TranslationKey } from "../i18n/translations";

export type SharedEditorOwnerType =
  | "experiment"
  | "experimentRun"
  | "review"
  | "literature"
  | "resultItem"
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "researchOutput";

export type SharedEditorLiteratureChannel = "literature_outline" | "dedicated_notes";

export type OwnerDisplayDescriptor = Readonly<{
  ownerType: SharedEditorOwnerType;
  formalDisplayKey: TranslationKey;
  diagnosticIdentifier: string;
}>;

export type ChannelDisplayDescriptor = Readonly<{
  ownerType: "literature";
  channel: SharedEditorLiteratureChannel;
  formalDisplayKey: TranslationKey;
  showInCurrentTitle: true;
  showInIndependentTitle: true;
  diagnosticIdentifier: string;
}>;

const OWNER_DISPLAY_DESCRIPTORS = Object.freeze({
  experiment: Object.freeze({
    ownerType: "experiment",
    formalDisplayKey: "sharedEditorOwnerExperiment",
    diagnosticIdentifier: "shared-editor-owner:experiment"
  }),
  experimentRun: Object.freeze({
    ownerType: "experimentRun",
    formalDisplayKey: "sharedEditorOwnerExperimentRun",
    diagnosticIdentifier: "shared-editor-owner:experiment-run"
  }),
  review: Object.freeze({
    ownerType: "review",
    formalDisplayKey: "sharedEditorOwnerReview",
    diagnosticIdentifier: "shared-editor-owner:review"
  }),
  literature: Object.freeze({
    ownerType: "literature",
    formalDisplayKey: "sharedEditorOwnerLiterature",
    diagnosticIdentifier: "shared-editor-owner:literature"
  }),
  resultItem: Object.freeze({
    ownerType: "resultItem",
    formalDisplayKey: "outputLayer_resultItem",
    diagnosticIdentifier: "shared-editor-owner:result-item"
  }),
  finding: Object.freeze({
    ownerType: "finding",
    formalDisplayKey: "outputLayer_finding",
    diagnosticIdentifier: "shared-editor-owner:finding"
  }),
  outputCandidate: Object.freeze({
    ownerType: "outputCandidate",
    formalDisplayKey: "outputLayer_outputCandidate",
    diagnosticIdentifier: "shared-editor-owner:output-candidate"
  }),
  outputGap: Object.freeze({
    ownerType: "outputGap",
    formalDisplayKey: "outputLayer_outputGap",
    diagnosticIdentifier: "shared-editor-owner:output-gap"
  }),
  researchOutput: Object.freeze({
    ownerType: "researchOutput",
    formalDisplayKey: "outputLayer_researchOutput",
    diagnosticIdentifier: "shared-editor-owner:research-output"
  })
} satisfies Record<SharedEditorOwnerType, OwnerDisplayDescriptor>);

const LITERATURE_CHANNEL_DISPLAY_DESCRIPTORS = Object.freeze({
  literature_outline: Object.freeze({
    ownerType: "literature",
    channel: "literature_outline",
    formalDisplayKey: "sharedEditorChannelLiteratureOutline",
    showInCurrentTitle: true,
    showInIndependentTitle: true,
    diagnosticIdentifier: "shared-editor-channel:literature-outline"
  }),
  dedicated_notes: Object.freeze({
    ownerType: "literature",
    channel: "dedicated_notes",
    formalDisplayKey: "sharedEditorChannelDedicatedNotes",
    showInCurrentTitle: true,
    showInIndependentTitle: true,
    diagnosticIdentifier: "shared-editor-channel:dedicated-notes"
  })
} satisfies Record<SharedEditorLiteratureChannel, ChannelDisplayDescriptor>);

export function getOwnerDisplayDescriptor(ownerType: string) {
  return OWNER_DISPLAY_DESCRIPTORS[ownerType as SharedEditorOwnerType];
}

export function getChannelDisplayDescriptor(ownerType: string, channel: string) {
  if (ownerType !== "literature") return undefined;
  return LITERATURE_CHANNEL_DISPLAY_DESCRIPTORS[channel as SharedEditorLiteratureChannel];
}

export const sharedEditorTitleDescriptorAuthority = Object.freeze({
  owners: OWNER_DISPLAY_DESCRIPTORS,
  literatureChannels: LITERATURE_CHANNEL_DISPLAY_DESCRIPTORS,
  getOwner: getOwnerDisplayDescriptor,
  getChannel: getChannelDisplayDescriptor
});
