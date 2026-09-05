import {
  QuickAnalysisEntryButton,
  type QuickAnalysisEntryCoordinatorPort
} from "../../components/ai/QuickAnalysisEntryButton";

export function ReviewQuickAnalysisButton({
  reviewId,
  projectId,
  reviewTitle,
  disabled,
  coordinator
}: {
  reviewId: string;
  projectId: string;
  reviewTitle: string;
  disabled?: boolean;
  coordinator?: QuickAnalysisEntryCoordinatorPort;
}) {
  return (
    <QuickAnalysisEntryButton
      coordinator={coordinator}
      disabled={disabled}
      expectedProjectOrScopeId={projectId}
      ownerLabel={reviewTitle}
      ownerRef={{ ownerType: "review", ownerId: reviewId, channel: "primary" }}
    />
  );
}
