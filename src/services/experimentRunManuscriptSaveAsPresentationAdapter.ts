import type { SharedManuscriptSessionHandle } from "../types/sharedManuscriptSession";
import {
  acceptSaveAsPresentationPermit,
  manuscriptSaveAsPresentationProtocol,
  type SaveAsPresentationAcknowledger,
  type SaveAsPresentationConsumerRegistration
} from "./manuscriptSaveAsPresentationProtocol";
import type { SharedSaveAsEngineResult } from "./sharedManuscriptSaveAsEngine";

export interface ExperimentRunSaveAsPresentationDependencies {
  presentation: typeof manuscriptSaveAsPresentationProtocol;
  nextGeneration(): number;
}

const defaultDependencies: ExperimentRunSaveAsPresentationDependencies = {
  presentation: manuscriptSaveAsPresentationProtocol,
  nextGeneration: (() => {
    let generation = 0;
    return () => ++generation;
  })()
};

export function createExperimentRunManuscriptSaveAsPresentationAdapter(
  dependencies: ExperimentRunSaveAsPresentationDependencies = defaultDependencies
) {
  return Object.freeze({
    async present(input: {
      runId: string;
      consumerId: string;
      result: SharedSaveAsEngineResult;
      acknowledgePresentation: SaveAsPresentationAcknowledger;
    }) {
      const consumerGeneration = dependencies.nextGeneration();
      let acceptedHandle: SharedManuscriptSessionHandle | undefined;
      const registration = dependencies.presentation.registerConsumer({
        consumerId: input.consumerId,
        consumerGeneration,
        async consume(permit) {
          if (!(await input.acknowledgePresentation(permit))) {
            throw new Error("SAVE_AS_PRESENTATION_NOT_ACKNOWLEDGED");
          }
          acceptedHandle = permit.runtime.handle;
          return acceptSaveAsPresentationPermit(permit);
        }
      });
      if (registration.status !== "registered") {
        return { status: "recovery-required" as const, failure: registration.failure };
      }
      const lease: SaveAsPresentationConsumerRegistration = registration;
      try {
        const issued = await dependencies.presentation.issue({
          operationId: input.result.operation.operationId,
          operationGeneration: input.result.operation.operationGeneration,
          processGeneration: input.result.operation.producerProcessGeneration,
          j0Revision: input.result.operation.revision,
          targetFileRefId: input.result.d2.fileRef.id,
          candidateReceiptId: input.result.r3.custody.receiptId,
          runtime: input.result.r3.runtime,
          consumerId: input.consumerId,
          consumerGeneration,
          presentationGeneration: consumerGeneration
        });
        if (!issued.ok) {
          return { status: "recovery-required" as const, failure: issued.failure };
        }
        const transferred = await dependencies.presentation.transfer(
          issued.value.permitId
        );
        if (!transferred.ok || !acceptedHandle) {
          return {
            status: "recovery-required" as const,
            failure: transferred.ok ? undefined : transferred.failure
          };
        }
        return {
          status: "success" as const,
          sessionHandle: acceptedHandle,
          operation: transferred.value
        };
      } finally {
        dependencies.presentation.detachConsumer(lease);
      }
    }
  });
}

export const experimentRunManuscriptSaveAsPresentationAdapter =
  createExperimentRunManuscriptSaveAsPresentationAdapter();
