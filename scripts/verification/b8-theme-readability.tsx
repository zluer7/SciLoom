// Controlled visual acceptance only. Imports production components, no copied HTML
// or business fixture writers; this module is not imported by any product entry.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n/I18nProvider";
import { OperationConfirmDialog } from "../../src/components/safety/OperationConfirmDialog";
import { ExperimentRunComparisonPanel } from "../../src/pages/Experiments/ExperimentRunComparisonPanel";
import { WriteFeedbackPanel } from "../../src/components/feedback/WriteFeedbackPanel";
import type { ExperimentRun } from "../../src/types";
import type { OperationImpactPreview } from "../../src/types/operationSafety";
import type { WriteFeedbackDisplayEntry } from "../../src/services/writeFeedbackDisplayService";
import { experimentRunService } from "../../src/services/experimentRunService";
import { experimentService } from "../../src/services/experimentService";
import type { Experiment } from "../../src/types";

export function mountReadabilitySurfaces(container: HTMLElement) {
  let setDialog: (open: boolean) => void = () => {};
  const preview: OperationImpactPreview = {
    operationId: "B8_TEST_ONLY_VISUAL", operation: "delete", target: { type: "experiment", title: "B8 TEST ONLY — blocked preview" },
    summary: "Controlled visual props; no object is created or deleted.", riskLevel: "high", executionKind: "soft-delete",
    isRecoverable: false, hasRestoreEntry: false, requiresUserConfirmation: true, canProceed: false,
    affectedEntityCount: 0, affectedItems: [], warnings: ["Review the operation before proceeding."],
    blockingReasons: ["This controlled preview cannot execute."], deepScanPerformed: false
  };
  const entries = ["success", "warning", "error"].map(severity => ({
    id: `B8_TEST_ONLY_${severity}`, severity, title: `${severity} — B8 controlled visual props`,
    summary: "Representative production feedback; no operation was performed.", details: [], affectedEntities: [], affectedScopes: []
  })) as WriteFeedbackDisplayEntry[];
  // Controlled read ports only for these nonexistent task-owned identifiers.
  // The production projector/table render actual record-shaped props, while
  // persistence and every ordinary business read retain their real owner.
  const runs = [1, 2].map(index => ({ id: `B8_TEST_ONLY_NOT_PERSISTED_RUN_${index}`, experimentId: "B8_TEST_ONLY_NOT_PERSISTED_EXPERIMENT", title: `B8 visual Run ${index}`,
    status: "planned", tags: [], conditionItems: [], variables: [], materials: [], customFields: [], methodSteps: [],
    conditionSummary: `Controlled condition ${index}`, createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z"
  })) as ExperimentRun[];
  const originalRunRead = experimentRunService.getRunById;
  const originalExperimentRead = experimentService.getExperimentById;
  experimentRunService.getRunById = async id => runs.find(run => run.id === id) ?? originalRunRead.call(experimentRunService, id);
  experimentService.getExperimentById = async id => id === "B8_TEST_ONLY_NOT_PERSISTED_EXPERIMENT"
    ? { id, title: "B8 controlled Experiment" } as Experiment
    : originalExperimentRead.call(experimentService, id);
  function Surfaces() {
    const [dialog, updateDialog] = useState(false);
    setDialog = updateDialog;
    return <I18nProvider>
      <WriteFeedbackPanel entries={entries} onDismiss={() => {}} />
      <ExperimentRunComparisonPanel experimentId="B8_TEST_ONLY_NOT_PERSISTED_EXPERIMENT" runs={runs} language="en-US" />
      <OperationConfirmDialog preview={dialog ? preview : null} onConfirm={() => { throw Error("Blocked visual fixture must never execute."); }} onCancel={() => updateDialog(false)} />
    </I18nProvider>;
  }
  const root = createRoot(container);
  root.render(<Surfaces />);
  return { setDialog: (open: boolean) => setDialog(open), unmount: () => {
    root.unmount();
    experimentRunService.getRunById = originalRunRead;
    experimentService.getExperimentById = originalExperimentRead;
  } };
}
