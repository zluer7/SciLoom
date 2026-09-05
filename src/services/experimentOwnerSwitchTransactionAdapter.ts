import { invoke } from "@tauri-apps/api/core";
import {
  type ExperimentOwnerSwitchPostVerify,
  type ExperimentOwnerSwitchDirectReadback,
  type ExperimentOwnerSwitchPostVerifyReadInput,
  type ExperimentOwnerSwitchReplacementInput,
  type ExperimentOutlineReplacement
} from "../types/experimentManuscriptAdapter";
import type { ManuscriptOutlineOwnerApplicationMapping } from "./manuscriptOutlineOwnerProjector";

export function buildExperimentSwitchOutlineReplacements(
  mapping: ManuscriptOutlineOwnerApplicationMapping
): readonly ExperimentOutlineReplacement[] {
  if (
    mapping.ownerType !== "experiment" ||
    mapping.channel !== "primary" ||
    mapping.ownerPayload.kind !== "direct-fields"
  ) {
    throw new Error("EXPERIMENT_SWITCH_APPLICATION_IDENTITY_INVALID");
  }
  return Object.freeze(mapping.orderedFieldApplications.map((application) =>
    Object.freeze(application.action === "set"
      ? { key: application.stableKey, action: "set" as const, value: application.value }
      : { key: application.stableKey, action: "clear" as const }
    ) as ExperimentOutlineReplacement
  ));
}

export interface ExperimentOwnerSwitchTransactionPort {
  commit(
    input: ExperimentOwnerSwitchReplacementInput
  ): Promise<ExperimentOwnerSwitchPostVerify>;
  readPostCommit(
    input: ExperimentOwnerSwitchPostVerifyReadInput
  ): Promise<ExperimentOwnerSwitchDirectReadback>;
}

export const experimentOwnerSwitchTransactionAdapter:
  ExperimentOwnerSwitchTransactionPort = Object.freeze({
    async commit(input: ExperimentOwnerSwitchReplacementInput) {
      return invoke<ExperimentOwnerSwitchPostVerify>(
        "commit_experiment_owner_switch_replacement",
        { input }
      );
    },
    async readPostCommit(input: ExperimentOwnerSwitchPostVerifyReadInput) {
      return invoke<ExperimentOwnerSwitchDirectReadback>(
        "read_experiment_owner_switch_post_verify",
        { input }
      );
    }
  });
