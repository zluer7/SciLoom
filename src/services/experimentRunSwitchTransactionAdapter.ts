import { invoke } from "@tauri-apps/api/core";
import {
  type ExperimentRunSwitchOutlineReplacement,
  type ExperimentRunSwitchTransactionInput,
  type ExperimentRunSwitchTransactionResult
} from "../types/experimentRunManuscriptSwitch";
import type { ManuscriptOutlineOwnerApplicationMapping } from "./manuscriptOutlineOwnerProjector";

export function buildExperimentRunSwitchOutlineReplacements(
  mapping: ManuscriptOutlineOwnerApplicationMapping
): readonly ExperimentRunSwitchOutlineReplacement[] {
  if (
    mapping.ownerType !== "experimentRun" ||
    mapping.channel !== "primary" ||
    mapping.ownerPayload.kind !== "direct-fields"
  ) {
    throw new Error("RUN_SWITCH_APPLICATION_IDENTITY_INVALID");
  }
  return Object.freeze(mapping.orderedFieldApplications.map((application) => {
    const prefix = "experimentRun.";
    if (!application.targetPersistenceIdentity.startsWith(prefix)) {
      throw new Error("RUN_SWITCH_APPLICATION_TARGET_INVALID");
    }
    const key = application.targetPersistenceIdentity.slice(prefix.length);
    return Object.freeze(application.action === "set"
      ? { key, action: "set" as const, value: application.value }
      : { key, action: "clear" as const }
    ) as ExperimentRunSwitchOutlineReplacement;
  }));
}

export interface ExperimentRunSwitchTransactionPort {
  commit(input: ExperimentRunSwitchTransactionInput): Promise<ExperimentRunSwitchTransactionResult>;
}

export const experimentRunSwitchTransactionAdapter: ExperimentRunSwitchTransactionPort =
  Object.freeze({
    async commit(input: ExperimentRunSwitchTransactionInput) {
      return invoke<ExperimentRunSwitchTransactionResult>(
        "commit_experiment_run_manuscript_switch",
        { input }
      );
    }
  });
