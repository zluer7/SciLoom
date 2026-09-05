import {
  QuickAnalysisEntryButton,
  type QuickAnalysisEntryCoordinatorPort
} from "../../components/ai/QuickAnalysisEntryButton";
import type { OutputEntityLayer } from "../../types/outputSelector";

export function OutputQuickAnalysisButton({
  ownerType,
  ownerId,
  projectId,
  ownerTitle,
  className,
  disabled,
  coordinator
}: {
  ownerType: OutputEntityLayer;
  ownerId: string;
  projectId: string;
  ownerTitle: string;
  className?: string;
  disabled?: boolean;
  coordinator?: QuickAnalysisEntryCoordinatorPort;
}) {
  return (
    <QuickAnalysisEntryButton
      className={className}
      coordinator={coordinator}
      disabled={disabled}
      expectedProjectOrScopeId={projectId}
      ownerLabel={ownerTitle}
      ownerRef={{ ownerType, ownerId, channel: "primary" }}
    />
  );
}
