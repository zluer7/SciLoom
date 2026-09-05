import type { ManuscriptChannel } from "../types";
import type { SharedManuscriptSessionHandle } from "../types/sharedManuscriptSession";
import {
  acceptSaveAsPresentationPermit,
  manuscriptSaveAsPresentationProtocol,
  type SaveAsPresentationConsumerRegistration
} from "./manuscriptSaveAsPresentationProtocol";
import type { SharedSaveAsEngineResult } from "./sharedManuscriptSaveAsEngine";

type LiteratureSaveAsChannel =
  | "literature_outline"
  | "dedicated_notes";

export interface LiteratureSaveAsPresentationDependencies {
  presentation: typeof manuscriptSaveAsPresentationProtocol;
  nextGeneration(): number;
}

const defaultDependencies: LiteratureSaveAsPresentationDependencies = {
  presentation: manuscriptSaveAsPresentationProtocol,
  nextGeneration: (() => {
    let generation = 0;
    return () => ++generation;
  })()
};

export function createLiteratureManuscriptSaveAsPresentationAdapter(
  dependencies: LiteratureSaveAsPresentationDependencies =
    defaultDependencies
) {
  return Object.freeze({
    async present(input: {
      literatureId: string;
      manuscriptChannel: LiteratureSaveAsChannel;
      consumerId: string;
      result: SharedSaveAsEngineResult;
    }) {
      const channel: ManuscriptChannel = input.manuscriptChannel;
      if (
        channel !== "literature_outline" &&
        channel !== "dedicated_notes"
      ) {
        return { status: "recovery-required" as const };
      }
      const consumerGeneration = dependencies.nextGeneration();
      let acceptedHandle:
        | SharedManuscriptSessionHandle
        | undefined;
      const registration =
        dependencies.presentation.registerConsumer({
          consumerId: input.consumerId,
          consumerGeneration,
          async consume(permit) {
            acceptedHandle = permit.runtime.handle;
            return acceptSaveAsPresentationPermit(permit);
          }
        });
      if (registration.status !== "registered") {
        return {
          status: "recovery-required" as const,
          failure: registration.failure
        };
      }
      const lease: SaveAsPresentationConsumerRegistration =
        registration;
      try {
        const issued = await dependencies.presentation.issue({
            operationId: input.result.operation.operationId,
            operationGeneration:
              input.result.operation.operationGeneration,
            processGeneration:
              input.result.operation.producerProcessGeneration,
          j0Revision: input.result.operation.revision,
          targetFileRefId: input.result.d2.fileRef.id,
          candidateReceiptId: input.result.r3.custody.receiptId,
          runtime: input.result.r3.runtime,
          consumerId: input.consumerId,
          consumerGeneration,
          presentationGeneration: consumerGeneration
        });
        if (!issued.ok) {
          return {
            status: "recovery-required" as const,
            failure: issued.failure
          };
        }
        const transferred =
          await dependencies.presentation.transfer(
            issued.value.permitId
          );
        if (!transferred.ok || !acceptedHandle) {
          return {
            status: "recovery-required" as const,
            failure: transferred.ok
              ? undefined
              : transferred.failure
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

export const literatureManuscriptSaveAsPresentationAdapter =
  createLiteratureManuscriptSaveAsPresentationAdapter();
