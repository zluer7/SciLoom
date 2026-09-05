import type { EntityId, ISODateString } from "./common";
import type { FileRefLocationMode } from "./experiment";
import type { LabPodMarkdownDocumentParseResult } from "./labPodMarkdownBlocks";
import type { OutputManuscriptEntityKind, OutputManuscriptOwnerType } from "./outputManuscript";
import type { StructuredSummary } from "./outputStructuredSummary";

export const OUTPUT_MANUSCRIPT_FILE_ERROR_CODES = Object.freeze({
  ownerUnsupported: "OUTPUT_MANUSCRIPT_FILE_OWNER_UNSUPPORTED",
  ownerNotFound: "OUTPUT_MANUSCRIPT_FILE_OWNER_NOT_FOUND",
  ownerDeleted: "OUTPUT_MANUSCRIPT_FILE_OWNER_DELETED",
  cleanupInProgress: "OUTPUT_MANUSCRIPT_FILE_CLEANUP_IN_PROGRESS",
  channelInvalid: "OUTPUT_MANUSCRIPT_FILE_CHANNEL_INVALID",
  currentMissing: "OUTPUT_MANUSCRIPT_FILE_CURRENT_MISSING",
  currentStale: "OUTPUT_MANUSCRIPT_FILE_CURRENT_STALE",
  targetInvalid: "OUTPUT_MANUSCRIPT_FILE_TARGET_INVALID",
  parseInvalid: "OUTPUT_MANUSCRIPT_FILE_PARSE_INVALID",
  parseAmbiguous: "OUTPUT_MANUSCRIPT_FILE_PARSE_AMBIGUOUS",
  saveAsNotConfirmed: "OUTPUT_MANUSCRIPT_SAVE_AS_NOT_CONFIRMED",
  saveAsTargetInvalid: "OUTPUT_MANUSCRIPT_SAVE_AS_TARGET_INVALID",
  saveAsConflict: "OUTPUT_MANUSCRIPT_SAVE_AS_CONFLICT",
  operationFailed: "OUTPUT_MANUSCRIPT_FILE_OPERATION_FAILED"
} as const);

export type OutputManuscriptFileErrorCode =
  (typeof OUTPUT_MANUSCRIPT_FILE_ERROR_CODES)[keyof typeof OUTPUT_MANUSCRIPT_FILE_ERROR_CODES];

export interface OutputManuscriptRelationSummary {
  direction: "incoming" | "outgoing";
  relationType: string;
  counterpartType: OutputManuscriptOwnerType;
  counterpartId: EntityId;
  note?: string;
}

export interface OutputManuscriptSourceSummary {
  sourceType: string;
  sourceId?: EntityId;
  title: string;
  summary?: string;
  relationType: string;
  status: "active" | "missing";
}

export interface OutputManuscriptSnapshotBase {
  ownerType: OutputManuscriptOwnerType;
  ownerId: EntityId;
  channel: "primary";
  projectId: EntityId;
  projectTitle: string;
  entityKind: OutputManuscriptEntityKind;
  displayTitle: string;
  briefDescription: string;
  status: string;
  type: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  tags: string[];
  currentFilename?: string;
  structuredSummary: StructuredSummary;
  relations: OutputManuscriptRelationSummary[];
  sources: OutputManuscriptSourceSummary[];
  provenance: string[];
  warnings: string[];
  sectionOrder: readonly ["identity", "summary", "layer", "relations", "sources", "provenance", "warnings"];
}

export type OutputManuscriptStructuredSnapshot =
  | (OutputManuscriptSnapshotBase & {
      ownerType: "resultItem";
      layer: {
        resultType: string;
        sourceType: string;
        sourceId: EntityId;
        value?: string;
        unit?: string;
        isAsset: boolean;
        assetQuality?: string;
        experimentId?: EntityId;
        experimentRunId?: EntityId;
        resultMetricId?: EntityId;
        pathSummary?: string;
      };
    })
  | (OutputManuscriptSnapshotBase & {
      ownerType: "finding";
      layer: { findingType?: string; confidence?: string; maturity?: string };
    })
  | (OutputManuscriptSnapshotBase & {
      ownerType: "outputCandidate";
      layer: { businessEntity: "OutputCandidate"; candidateType: string; maturity?: string; priority?: string };
    })
  | (OutputManuscriptSnapshotBase & {
      ownerType: "outputGap";
      layer: {
        gapType: string;
        priority?: string;
        resolvedAt?: ISODateString;
        relatedTaskId?: EntityId;
        relatedRouteNodeId?: EntityId;
        feedbackSummary?: string;
      };
    })
  | (OutputManuscriptSnapshotBase & {
      ownerType: "researchOutput";
      layer: {
        canonicalOwnerType: "researchOutput";
        outputType: string;
        description: string;
        usableForPaper: boolean;
        sourceOutputCandidateId?: EntityId;
        taskId?: EntityId;
        experimentId?: EntityId;
      };
    });

export interface OutputManuscriptDocument {
  ownerType: OutputManuscriptOwnerType;
  ownerId: EntityId;
  channel: "primary";
  fileRefId: EntityId;
  filename: string;
  locationMode: FileRefLocationMode;
  rawMarkdown: string;
  body: string;
  parsed: LabPodMarkdownDocumentParseResult;
  snapshot: OutputManuscriptStructuredSnapshot;
  warnings: string[];
  requestToken?: number;
}

export type OutputManuscriptOperationResult<T> =
  | { status: "success" | "skipped"; data: T; warnings: string[]; currentChanged: boolean }
  | { status: "error" | "partial" | "conflict"; error: { code: string; message: string }; warnings: string[]; currentChanged: false; retryable?: boolean };

export interface OutputManuscriptHardCleanupResult {
  status: "complete" | "partial";
  ownerType: OutputManuscriptOwnerType;
  ownerId: EntityId;
  removedBinding: boolean;
  removedFileRefCount: number;
  failedStep?: "binding" | "fileRefs";
  retryable: boolean;
  physicalFilesTouched: false;
  warnings: string[];
}
