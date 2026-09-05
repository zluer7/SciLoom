import {
  QuickAnalysisEntryButton,
  type QuickAnalysisEntryCoordinatorPort
} from "../../components/ai/QuickAnalysisEntryButton";

export type ExperimentQuickAnalysisCoordinatorPort = QuickAnalysisEntryCoordinatorPort;

export function ExperimentQuickAnalysisButton({
  experimentId,
  projectId,
  experimentTitle,
  coordinator
}: {
  experimentId: string;
  projectId: string;
  experimentTitle: string;
  ui(source: string): string;
  coordinator?: ExperimentQuickAnalysisCoordinatorPort;
}) {
  return (
    <QuickAnalysisEntryButton
      coordinator={coordinator}
      expectedProjectOrScopeId={projectId}
      ownerLabel={experimentTitle}
      ownerRef={{
        ownerType: "experiment",
        ownerId: experimentId,
        channel: "primary"
      }}
    />
  );
}
