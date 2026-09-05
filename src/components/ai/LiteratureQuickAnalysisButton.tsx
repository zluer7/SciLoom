import {
  QuickAnalysisEntryButton,
  type QuickAnalysisEntryCoordinatorPort
} from "./QuickAnalysisEntryButton";

export type LiteratureQuickAnalysisChannel =
  | "literature_outline"
  | "dedicated_notes";

export function LiteratureQuickAnalysisButton({
  literatureId,
  literatureTitle,
  channel,
  expectedProjectOrScopeId,
  className,
  disabled,
  coordinator
}: {
  literatureId: string;
  literatureTitle: string;
  channel: LiteratureQuickAnalysisChannel;
  expectedProjectOrScopeId?: string;
  className?: string;
  disabled?: boolean;
  coordinator?: QuickAnalysisEntryCoordinatorPort;
}) {
  return (
    <QuickAnalysisEntryButton
      className={className}
      coordinator={coordinator}
      disabled={disabled}
      expectedProjectOrScopeId={expectedProjectOrScopeId}
      ownerLabel={literatureTitle}
      ownerRef={{ ownerType: "literature", ownerId: literatureId, channel }}
    />
  );
}
