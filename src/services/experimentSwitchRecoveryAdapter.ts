import { invoke } from "@tauri-apps/api/core";
import type {
  ExperimentSwitchRecoveryDetail,
  ExperimentSwitchRecoveryPhaseInput,
  ExperimentSwitchRecoveryPostVerifyResult,
  ExperimentSwitchRecoveryPrepareInput,
  ExperimentSwitchRecoveryRecord
} from "../types/experimentManuscriptSwitch";

export interface ExperimentSwitchRecoveryPort {
  prepare(input: ExperimentSwitchRecoveryPrepareInput): Promise<ExperimentSwitchRecoveryRecord>;
  get(operationId: string): Promise<ExperimentSwitchRecoveryRecord>;
  getDetail(operationId: string): Promise<ExperimentSwitchRecoveryDetail>;
  list(experimentId: string): Promise<ExperimentSwitchRecoveryRecord[]>;
  updatePhase(input: ExperimentSwitchRecoveryPhaseInput): Promise<ExperimentSwitchRecoveryRecord>;
  postVerify(operationId: string): Promise<ExperimentSwitchRecoveryPostVerifyResult>;
  completeDatabase(operationId: string, oldCurrentPostRevision: string, occurredAt: string): Promise<ExperimentSwitchRecoveryPostVerifyResult>;
  safeCancel(operationId: string, observedOldCurrentRevision: string, occurredAt: string): Promise<ExperimentSwitchRecoveryRecord>;
}

export const experimentSwitchRecoveryAdapter: ExperimentSwitchRecoveryPort = Object.freeze({
  prepare: (input: ExperimentSwitchRecoveryPrepareInput) => invoke<ExperimentSwitchRecoveryRecord>("prepare_experiment_switch_recovery", { input }),
  get: (operationId: string) => invoke<ExperimentSwitchRecoveryRecord>("get_experiment_switch_recovery", { operationId }),
  getDetail: (operationId: string) => invoke<ExperimentSwitchRecoveryDetail>("get_experiment_switch_recovery_detail", { operationId }),
  list: (experimentId: string) => invoke<ExperimentSwitchRecoveryRecord[]>("list_experiment_switch_recoveries", { experimentId }),
  updatePhase: (input: ExperimentSwitchRecoveryPhaseInput) => invoke<ExperimentSwitchRecoveryRecord>("update_experiment_switch_recovery_phase", { input }),
  postVerify: (operationId: string) => invoke<ExperimentSwitchRecoveryPostVerifyResult>("post_verify_experiment_switch_recovery", { operationId }),
  completeDatabase: (operationId: string, oldCurrentPostRevision: string, occurredAt: string) => invoke<ExperimentSwitchRecoveryPostVerifyResult>(
    "complete_experiment_switch_recovery",
    { operationId, oldCurrentPostRevision, occurredAt }
  ),
  safeCancel: (operationId: string, observedOldCurrentRevision: string, occurredAt: string) => invoke<ExperimentSwitchRecoveryRecord>(
    "safe_cancel_experiment_switch_recovery",
    { operationId, observedOldCurrentRevision, occurredAt }
  )
});
