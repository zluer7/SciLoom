import {
  QuickAnalysisEntryButton,
  type QuickAnalysisEntryCoordinatorPort
} from "../../components/ai/QuickAnalysisEntryButton";

export function ExperimentRunQuickAnalysisButton({
  runId,
  projectId,
  runTitle,
  coordinator
}: {
  runId: string;
  projectId: string;
  runTitle: string;
  coordinator?: QuickAnalysisEntryCoordinatorPort;
}) {
  return (
    <QuickAnalysisEntryButton
      coordinator={coordinator}
      expectedProjectOrScopeId={projectId}
      ownerLabel={runTitle}
      ownerRef={{
        ownerType: "experimentRun",
        ownerId: runId,
        channel: "primary"
      }}
    />
  );
}
