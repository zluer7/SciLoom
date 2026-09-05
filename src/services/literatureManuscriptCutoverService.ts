import { literatureRepository } from "../repositories/literatureRepository";
import type { EntityId, FileRef, ManuscriptChannel } from "../types";
import { fileRefService } from "./fileRefService";
import { parseLabPodMarkdownDocument, upsertLabPodStandardBlocks } from "./labPodMarkdownDocumentService";
import { parseLegacyLiteratureDocumentV1 } from "./literatureLegacyCodecV1";
import {
  assertLiteratureDocumentV2,
  LITERATURE_CODEC_ERROR_CODES,
  LITERATURE_META_CODEC_MARKER,
  LITERATURE_OUTLINE_CODEC_MARKER,
  LiteratureCodecError,
  literatureCodecDiagnosticFromUnknown,
  serializeLiteratureDedicatedNotesV2,
  serializeLiteratureMetaV2,
  serializeLiteratureOutlineV2,
  type LiteratureCodecDiagnostic,
  type LiteratureDedicatedNotesSummary
} from "./literatureMarkdownCodecService";
import { manuscriptIoService } from "./manuscriptIoService";
import type { LiteratureStructuredOutlineSummary } from "../types/literatureContext";

export interface LiteratureCutoverInput {
  literatureId: EntityId;
  manuscriptChannel: ManuscriptChannel;
  fileRefId: EntityId;
  apply?: boolean;
  confirmedByUser?: boolean;
  requestToken: number;
}

export type LiteratureCutoverResult =
  | {
      status: "preview" | "success" | "skipped";
      literatureId: EntityId;
      manuscriptChannel: ManuscriptChannel;
      fileRefId: EntityId;
      sourceCodec: "legacy-v1" | "v2";
      targetCodec: "v2";
      convertedMarkdown?: string;
      bodyPreserved: true;
      outsideContentPreserved: true;
      diagnostics: LiteratureCodecDiagnostic[];
      requestToken: number;
    }
  | {
      status: "error";
      literatureId: EntityId;
      manuscriptChannel: ManuscriptChannel;
      fileRefId: EntityId;
      error: LiteratureCodecDiagnostic;
      diagnostics: LiteratureCodecDiagnostic[];
      requestToken: number;
    };

export interface LiteratureCutoverDependencies {
  getLiterature(id: EntityId): ReturnType<typeof literatureRepository.getById>;
  getFileRef(id: EntityId): Promise<FileRef | undefined>;
  read: typeof manuscriptIoService.readManuscriptByFileRef;
  write: typeof manuscriptIoService.saveManuscriptByFileRef;
}

const defaultDependencies: LiteratureCutoverDependencies = {
  getLiterature: literatureRepository.getById,
  getFileRef: fileRefService.getById,
  read: manuscriptIoService.readManuscriptByFileRef,
  write: manuscriptIoService.saveManuscriptByFileRef
};

function errorResult(input: LiteratureCutoverInput, error: unknown): LiteratureCutoverResult {
  const diagnostics = literatureCodecDiagnosticFromUnknown(error);
  return {
    status: "error",
    literatureId: input.literatureId,
    manuscriptChannel: input.manuscriptChannel,
    fileRefId: input.fileRefId,
    error: diagnostics[0],
    diagnostics,
    requestToken: input.requestToken
  };
}

function assertTarget(input: LiteratureCutoverInput, fileRef: FileRef | undefined) {
  if (
    !fileRef ||
    fileRef.deletedAt ||
    fileRef.ownerType !== "literature" ||
    fileRef.ownerId !== input.literatureId ||
    fileRef.resourceKind !== "file" ||
    fileRef.fileRole !== "manuscript" ||
    fileRef.manuscriptChannel !== input.manuscriptChannel ||
    (input.manuscriptChannel !== "literature_outline" && input.manuscriptChannel !== "dedicated_notes")
  ) {
    throw new LiteratureCodecError(
      LITERATURE_CODEC_ERROR_CODES.cutoverTargetInvalid,
      "Cutover target is not an active Literature manuscript for the requested channel."
    );
  }
  return fileRef;
}

function resolveAbstract<T extends LiteratureStructuredOutlineSummary | LiteratureDedicatedNotesSummary>(
  metaAbstract: string | undefined,
  outline: T,
  getSummary: (value: T) => string | undefined,
  setSummary: (value: T, summary: string) => T
) {
  const meta = metaAbstract?.trim() ?? "";
  const summary = getSummary(outline)?.trim() ?? "";
  if (!meta || meta === summary) return outline;
  if (!summary) return setSummary(outline, meta);
  throw new LiteratureCodecError(
    LITERATURE_CODEC_ERROR_CODES.cutoverAbstractConflict,
    "Legacy META Abstract conflicts with the legacy OUTLINE summary."
  );
}

export function createLiteratureManuscriptCutoverService(
  dependencies: LiteratureCutoverDependencies = defaultDependencies
) {
  return {
    async cutoverToV2(input: LiteratureCutoverInput): Promise<LiteratureCutoverResult> {
      try {
        const literature = await dependencies.getLiterature(input.literatureId);
        if (!literature) {
          throw new LiteratureCodecError(
            LITERATURE_CODEC_ERROR_CODES.cutoverTargetInvalid,
            "Literature cutover owner was not found or is inactive."
          );
        }
        const fileRef = assertTarget(input, await dependencies.getFileRef(input.fileRefId));
        const read = await dependencies.read("literature", input.literatureId, input.fileRefId, {
          requestToken: input.requestToken,
          manuscriptChannel: input.manuscriptChannel
        });
        if (read.status === "error") {
          throw new LiteratureCodecError(
            LITERATURE_CODEC_ERROR_CODES.cutoverTargetInvalid,
            read.error.message
          );
        }
        const standard = parseLabPodMarkdownDocument(read.content);
        if (standard.status !== "valid" && standard.status !== "valid-empty") {
          throw new LiteratureCodecError(
            LITERATURE_CODEC_ERROR_CODES.cutoverTargetInvalid,
            "Cutover requires one valid set of SciLoom standard blocks."
          );
        }
        const metaSnapshot = standard.metaSnapshot ?? "";
        const outlineMarkdown = standard.outline ?? "";
        const hasV2Marker =
          metaSnapshot.includes(LITERATURE_META_CODEC_MARKER) ||
          outlineMarkdown.includes(LITERATURE_OUTLINE_CODEC_MARKER);
        if (hasV2Marker) {
          assertLiteratureDocumentV2({
            metaSnapshot,
            outline: outlineMarkdown,
            channel: input.manuscriptChannel
          });
          return {
            status: "skipped",
            literatureId: input.literatureId,
            manuscriptChannel: input.manuscriptChannel,
            fileRefId: input.fileRefId,
            sourceCodec: "v2",
            targetCodec: "v2",
            bodyPreserved: true,
            outsideContentPreserved: true,
            diagnostics: [],
            requestToken: input.requestToken
          };
        }

        const legacy = parseLegacyLiteratureDocumentV1({
          metaSnapshot,
          outline: outlineMarkdown,
          channel: input.manuscriptChannel
        });
        const meta = { ...legacy.meta, importance: literature.importance ?? "" };
        const outline = input.manuscriptChannel === "literature_outline"
          ? resolveAbstract(
              legacy.meta.abstract,
              legacy.outline as LiteratureStructuredOutlineSummary,
              (value) => value.abstract,
              (value, summary) => ({ ...value, abstract: summary })
            )
          : resolveAbstract(
              legacy.meta.abstract,
              legacy.outline as LiteratureDedicatedNotesSummary,
              (value) => value.projectSummary,
              (value, summary) => ({ ...value, projectSummary: summary })
            );
        const nextMeta = serializeLiteratureMetaV2(meta);
        const nextOutline = input.manuscriptChannel === "literature_outline"
          ? serializeLiteratureOutlineV2(outline as LiteratureStructuredOutlineSummary)
          : serializeLiteratureDedicatedNotesV2(outline as LiteratureDedicatedNotesSummary);
        const converted = upsertLabPodStandardBlocks(
          read.content,
          { metaSnapshot: nextMeta, outline: nextOutline },
          { mode: "strict", preserveOutsideContent: true }
        );
        if (converted.status === "error") {
          throw new LiteratureCodecError(
            LITERATURE_CODEC_ERROR_CODES.cutoverTargetInvalid,
            "Legacy Literature standard blocks could not be converted safely."
          );
        }
        const verified = parseLabPodMarkdownDocument(converted.markdown);
        if (verified.status !== "valid" && verified.status !== "valid-empty") {
          throw new LiteratureCodecError(
            LITERATURE_CODEC_ERROR_CODES.cutoverTargetInvalid,
            "Converted Literature manuscript failed standard block validation."
          );
        }
        assertLiteratureDocumentV2({
          metaSnapshot: verified.metaSnapshot ?? "",
          outline: verified.outline ?? "",
          channel: input.manuscriptChannel
        });
        if (verified.body !== standard.body || verified.outsideContent !== standard.outsideContent) {
          throw new LiteratureCodecError(
            LITERATURE_CODEC_ERROR_CODES.cutoverTargetInvalid,
            "Cutover would change BODY or marker-external content."
          );
        }
        if (input.apply !== true) {
          return {
            status: "preview",
            literatureId: input.literatureId,
            manuscriptChannel: input.manuscriptChannel,
            fileRefId: input.fileRefId,
            sourceCodec: "legacy-v1",
            targetCodec: "v2",
            convertedMarkdown: converted.markdown,
            bodyPreserved: true,
            outsideContentPreserved: true,
            diagnostics: [],
            requestToken: input.requestToken
          };
        }
        if (input.confirmedByUser !== true) {
          throw new LiteratureCodecError(
            LITERATURE_CODEC_ERROR_CODES.cutoverConfirmationRequired,
            "Applying Literature codec cutover requires explicit user confirmation."
          );
        }
        const saved = await dependencies.write(
          "literature",
          input.literatureId,
          fileRef.id,
          converted.markdown,
          {
            requestToken: input.requestToken,
            confirmedExternalWrite: fileRef.locationMode === "external",
            manuscriptChannel: input.manuscriptChannel
          }
        );
        if (saved.status === "error") {
          throw new LiteratureCodecError(
            LITERATURE_CODEC_ERROR_CODES.cutoverWriteFailed,
            saved.error.message
          );
        }
        return {
          status: "success",
          literatureId: input.literatureId,
          manuscriptChannel: input.manuscriptChannel,
          fileRefId: input.fileRefId,
          sourceCodec: "legacy-v1",
          targetCodec: "v2",
          convertedMarkdown: converted.markdown,
          bodyPreserved: true,
          outsideContentPreserved: true,
          diagnostics: [],
          requestToken: input.requestToken
        };
      } catch (error) {
        return errorResult(input, error);
      }
    }
  };
}

export const literatureManuscriptCutoverService = createLiteratureManuscriptCutoverService();
