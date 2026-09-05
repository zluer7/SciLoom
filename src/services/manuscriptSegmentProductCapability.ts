import type { ManuscriptOutlineDescriptorLookupIdentity } from "./manuscriptOutlineParser";
import { isManuscriptSegmentProductIdentity } from "./manuscriptSegmentProductActivation";
import type { MarkdownTemplateScope } from "../types/markdownTemplate";

export type ManuscriptSegmentEntryKind = "current" | "independent";

export type ManuscriptSegmentProductCapability = Readonly<{
  entryKind: ManuscriptSegmentEntryKind;
  template: Readonly<{
    applicability: "SUPPORTED" | "NOT_APPLICABLE";
    scope?: MarkdownTemplateScope;
  }>;
  contextStructure: Readonly<{
    applicability: "SUPPORTED" | "NOT_APPLICABLE";
  }>;
  preview: Readonly<{ applicability: "SUPPORTED" }>;
  saveAsFrozenDraft: Readonly<{ applicability: "SUPPORTED" }>;
}>;

function templateScope(
  identity: ManuscriptOutlineDescriptorLookupIdentity
): MarkdownTemplateScope {
  switch (identity.ownerType) {
    case "experiment": return "experimentRecord";
    case "experimentRun": return "experimentRunRecord";
    case "literature": return "literatureRecord";
    case "review": return "reviewRecord";
    default: return "outputRecord";
  }
}

export function resolveManuscriptSegmentProductCapability(
  identity: ManuscriptOutlineDescriptorLookupIdentity,
  entryKind: ManuscriptSegmentEntryKind
): ManuscriptSegmentProductCapability {
  if (!isManuscriptSegmentProductIdentity(identity)) {
    throw new Error("MANUSCRIPT_SEGMENT_CAPABILITY_IDENTITY_UNSUPPORTED");
  }
  const current = entryKind === "current";
  return Object.freeze({
    entryKind,
    template: Object.freeze(current
      ? { applicability: "SUPPORTED" as const, scope: templateScope(identity) }
      : { applicability: "NOT_APPLICABLE" as const }),
    contextStructure: Object.freeze({
      applicability: current ? "SUPPORTED" as const : "NOT_APPLICABLE" as const
    }),
    preview: Object.freeze({ applicability: "SUPPORTED" as const }),
    saveAsFrozenDraft: Object.freeze({ applicability: "SUPPORTED" as const })
  });
}
