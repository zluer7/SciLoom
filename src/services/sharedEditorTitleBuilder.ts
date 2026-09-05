import type { Language } from "../i18n/translations";
import type { ManuscriptWindowRole } from "../types/sharedManuscriptSession";

export type SharedEditorTitleIdentityEvidence = Readonly<{
  ownerType: string;
  ownerId: string;
  channel: string;
  windowRole: ManuscriptWindowRole;
  fileRefId: string;
  sessionKey: string;
  lifecycleHandle: string;
  presentationEpoch: number;
  sessionGeneration: number;
}>;

export type SharedEditorTitleBuilderInput = Readonly<{
  businessTypeLabel: string;
  entityTitle?: string | null;
  channelLabel?: string;
  windowRole: ManuscriptWindowRole;
  fileLabel: string;
  currentRoleLabel: string;
  selectedRoleLabel: string;
  unnamedPrefix: string;
  footerSeparator: string;
  locale: Language;
  identity: SharedEditorTitleIdentityEvidence;
}>;

export type SharedEditorTitleBuilderResult = Readonly<{
  businessTypeLabel: string;
  entityTitleLabel: string;
  channelLabel?: string;
  roleLabel: string;
  fileLabel: string;
  footerLabel: string;
  fullAccessibleEntityTitle: string;
  validation: "VALID";
  identity: SharedEditorTitleIdentityEvidence;
}>;

export function buildSharedEditorTitle(
  input: SharedEditorTitleBuilderInput
): SharedEditorTitleBuilderResult | undefined {
  const businessTypeLabel = input.businessTypeLabel.trim();
  const channelLabel = input.channelLabel?.trim() || undefined;
  const fileLabel = input.fileLabel.trim();
  const currentRoleLabel = input.currentRoleLabel.trim();
  const selectedRoleLabel = input.selectedRoleLabel.trim();
  const unnamedPrefix = input.unnamedPrefix;
  const footerSeparator = input.footerSeparator;
  if (
    !businessTypeLabel ||
    !fileLabel ||
    !currentRoleLabel ||
    !selectedRoleLabel ||
    !unnamedPrefix.trim() ||
    !footerSeparator ||
    !input.locale ||
    !input.identity.sessionKey
  ) return undefined;
  const entityTitleLabel = input.entityTitle?.trim() || `${unnamedPrefix}${businessTypeLabel}`;
  const roleLabel = input.windowRole === "current" ? currentRoleLabel : selectedRoleLabel;
  return Object.freeze({
    businessTypeLabel,
    entityTitleLabel,
    ...(channelLabel ? { channelLabel } : {}),
    roleLabel,
    fileLabel,
    footerLabel: `${roleLabel}${footerSeparator}${fileLabel}`,
    fullAccessibleEntityTitle: entityTitleLabel,
    validation: "VALID",
    identity: input.identity
  });
}
