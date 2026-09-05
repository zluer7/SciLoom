import { invoke } from "@tauri-apps/api/core";
import type { SaveAsFailureCode } from "../types/manuscriptSaveAs";
import type { CandidateCustodyRecord } from "./manuscriptSaveAsCandidateCustody";
import type { SaveAsOperationRecord } from "./manuscriptSaveAsOperationPort";

export const WINDOW_P_MISSING_BINDING_MESSAGE =
  "目标文件可能已经创建，但异常退出导致本次 Save As 未完成正式终态，系统未自动继续该操作。";

export interface WindowPMissingBindingContainmentDescriptor {
  policyId: "window_p_fail_closed_v1";
}

export type WindowPContainmentBlockingCode =
  | "SAVE_AS_RUNTIME_GENERATION_STALE"
  | "SAVE_AS_SOURCE_SNAPSHOT_INVALID";

export interface WindowPContainmentRecord {
  readonly policyId: "window_p_fail_closed_v1";
  readonly operation: Readonly<SaveAsOperationRecord>;
  readonly custody: Readonly<CandidateCustodyRecord>;
  readonly blockingCode: WindowPContainmentBlockingCode;
  readonly sourceProofComplete: boolean;
}

type WindowPContainmentDurableReadback = Omit<
  WindowPContainmentRecord,
  "policyId"
>;

export function windowPContainmentFeedbackMessage(
  blockingCode: WindowPContainmentBlockingCode
) {
  switch (blockingCode) {
    case "SAVE_AS_RUNTIME_GENERATION_STALE":
    case "SAVE_AS_SOURCE_SNAPSHOT_INVALID":
      return WINDOW_P_MISSING_BINDING_MESSAGE;
  }
}

export interface ManuscriptSaveAsWindowPContainment {
  contain(input: {
    operation: SaveAsOperationRecord;
    expectedCustody: CandidateCustodyRecord;
  }): Promise<WindowPContainmentRecord>;
}

function assertContained(
  result: WindowPContainmentDurableReadback
): WindowPContainmentRecord {
  const { operation, custody, blockingCode } = result;
  const validBlockingCode: SaveAsFailureCode = blockingCode;
  if (
    operation.stage !== "reconciliation_blocked" ||
    operation.reconciliationState !== "blocked" ||
    operation.blockingCode !== validBlockingCode ||
    custody.currentCustodyAuthority !== "resolved" ||
    custody.custodyState !== "process_generation_retired" ||
    custody.runtimeHandle != null
  ) {
    throw new Error("SAVE_AS_WINDOW_P_CONTAINMENT_RESPONSE_INVALID");
  }
  return Object.freeze({
    policyId: "window_p_fail_closed_v1",
    operation: Object.freeze({ ...operation }),
    custody: Object.freeze({ ...custody }),
    blockingCode,
    sourceProofComplete: result.sourceProofComplete
  });
}

export const manuscriptSaveAsWindowPContainment =
  Object.freeze<ManuscriptSaveAsWindowPContainment>({
    async contain({ operation, expectedCustody }) {
      if (
        operation.stage !== "p4_presentation_pending" ||
        !operation.targetFileRefId ||
        expectedCustody.operationId !== operation.operationId ||
        expectedCustody.receiptId.trim() === "" ||
        expectedCustody.currentCustodyAuthority !== "r3_authority" ||
        expectedCustody.custodyState !== "activated_held" ||
        !expectedCustody.runtimeHandle ||
        !expectedCustody.runtimeConsumerId ||
        expectedCustody.runtimeGeneration === undefined
      ) {
        throw new Error("SAVE_AS_WINDOW_P_CONTAINMENT_INPUT_INVALID");
      }
      const result = await invoke<WindowPContainmentDurableReadback>(
        "contain_pre_presentation_missing_binding_save_as",
        {
          input: {
            operationId: operation.operationId,
            expectedOperationRevision: operation.revision,
            expectedCustodyRevision: expectedCustody.revision,
            receiptId: expectedCustody.receiptId,
            ownerType: operation.ownerType,
            ownerId: operation.ownerId,
            channel: operation.channel,
            sourceFileRefId: operation.sourceFileRefId,
            sourcePathIdentityKey: operation.sourcePathIdentityKey,
            targetFileRefId: operation.targetFileRefId,
            targetPathIdentityKey: operation.targetPathIdentityKey,
            expectedProcessGeneration: operation.producerProcessGeneration,
            expectedRuntimeHandle: expectedCustody.runtimeHandle,
            expectedRuntimeConsumerId: expectedCustody.runtimeConsumerId,
            expectedRuntimeGeneration: expectedCustody.runtimeGeneration
          }
        }
      );
      return assertContained(result);
    }
  });
