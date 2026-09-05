import { invoke } from "@tauri-apps/api/core";
import type {
  ExperimentRunSwitchPostVerifyResult,
  ExperimentRunSwitchRecoveryDetail,
  ExperimentRunSwitchRecoveryPhaseInput,
  ExperimentRunSwitchRecoveryPrepareInput,
  ExperimentRunSwitchRecoveryRecord
} from "../types/experimentRunManuscriptSwitch";

export interface ExperimentRunSwitchRecoveryPort {
  prepare(input: ExperimentRunSwitchRecoveryPrepareInput): Promise<ExperimentRunSwitchRecoveryRecord>;
  get(operationId: string): Promise<ExperimentRunSwitchRecoveryRecord>;
  getDetail(operationId: string): Promise<ExperimentRunSwitchRecoveryDetail>;
  list(runId: string): Promise<ExperimentRunSwitchRecoveryRecord[]>;
  discoverAll(): Promise<ExperimentRunSwitchRecoveryRecord[]>;
  updatePhase(input: ExperimentRunSwitchRecoveryPhaseInput): Promise<ExperimentRunSwitchRecoveryRecord>;
  postVerify(operationId: string): Promise<ExperimentRunSwitchPostVerifyResult>;
  completeDatabase(operationId: string, oldCurrentPostRevision: string, updatedAt: string): Promise<ExperimentRunSwitchPostVerifyResult>;
  safeCancel(operationId: string, observedOldCurrentRevision: string, occurredAt: string): Promise<ExperimentRunSwitchRecoveryRecord>;
}

export const experimentRunSwitchRecoveryAdapter: ExperimentRunSwitchRecoveryPort = Object.freeze({
  prepare: (input: ExperimentRunSwitchRecoveryPrepareInput) => invoke<ExperimentRunSwitchRecoveryRecord>("prepare_experiment_run_switch_recovery", { input }),
  get: (operationId: string) => invoke<ExperimentRunSwitchRecoveryRecord>("get_experiment_run_switch_recovery", { operationId }),
  getDetail: (operationId: string) => invoke<ExperimentRunSwitchRecoveryDetail>("get_experiment_run_switch_recovery_detail", { operationId }),
  list: (runId: string) => invoke<ExperimentRunSwitchRecoveryRecord[]>("list_experiment_run_switch_recoveries", { runId }),
  discoverAll: () => invoke<ExperimentRunSwitchRecoveryRecord[]>("discover_experiment_run_switch_recoveries"),
  updatePhase: (input: ExperimentRunSwitchRecoveryPhaseInput) => invoke<ExperimentRunSwitchRecoveryRecord>("update_experiment_run_switch_recovery_phase", { input }),
  postVerify: (operationId: string) => invoke<ExperimentRunSwitchPostVerifyResult>("post_verify_experiment_run_switch_recovery", { operationId }),
  completeDatabase: (operationId: string, oldCurrentPostRevision: string, updatedAt: string) => invoke<ExperimentRunSwitchPostVerifyResult>(
    "complete_experiment_run_switch_recovery",
    { operationId, oldCurrentPostRevision, updatedAt }
  ),
  safeCancel: (operationId: string, observedOldCurrentRevision: string, occurredAt: string) => invoke<ExperimentRunSwitchRecoveryRecord>(
    "safe_cancel_experiment_run_switch_recovery",
    { operationId, observedOldCurrentRevision, occurredAt }
  )
});
