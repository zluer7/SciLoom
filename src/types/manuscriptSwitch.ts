import type { EntityId } from "./common";
import type {
  FileRefLocationMode,
  FileRefOwnerType
} from "./experiment";
import type { LabPodMarkdownDiagnostic, LabPodMarkdownDocumentStatus } from "./labPodMarkdownBlocks";
import type { EntitySource } from "./planning";
import type { ManuscriptChannel } from "./manuscriptChannel";

export const MANUSCRIPT_SWITCH_ERROR_CODES = {
  ownerNotFound: "MANUSCRIPT_SWITCH_OWNER_NOT_FOUND",
  ownerDeleted: "MANUSCRIPT_SWITCH_OWNER_DELETED",
  bindingNotFound: "MANUSCRIPT_SWITCH_BINDING_NOT_FOUND",
  targetNotFound: "MANUSCRIPT_SWITCH_TARGET_NOT_FOUND",
  targetDeleted: "MANUSCRIPT_SWITCH_TARGET_DELETED",
  targetOwnerMismatch: "MANUSCRIPT_SWITCH_TARGET_OWNER_MISMATCH",
  targetChannelMismatch: "MANUSCRIPT_SWITCH_TARGET_CHANNEL_MISMATCH",
  targetInvalidKind: "MANUSCRIPT_SWITCH_TARGET_INVALID_KIND",
  targetInvalidRole: "MANUSCRIPT_SWITCH_TARGET_INVALID_ROLE",
  targetUnreadable: "MANUSCRIPT_SWITCH_TARGET_UNREADABLE",
  targetRefreshFailed: "MANUSCRIPT_SWITCH_TARGET_REFRESH_FAILED",
  targetParseInvalid: "MANUSCRIPT_SWITCH_TARGET_PARSE_INVALID",
  targetParseAmbiguous: "MANUSCRIPT_SWITCH_TARGET_PARSE_AMBIGUOUS",
  targetContentInvalid: "MANUSCRIPT_SWITCH_TARGET_CONTENT_INVALID",
  dirtyRequiresDecision: "MANUSCRIPT_SWITCH_DIRTY_REQUIRES_DECISION",
  discardNotConfirmed: "MANUSCRIPT_SWITCH_DISCARD_NOT_CONFIRMED",
  saveInProgress: "MANUSCRIPT_SWITCH_SAVE_IN_PROGRESS",
  saveFailed: "MANUSCRIPT_SWITCH_SAVE_FAILED",
  canceled: "MANUSCRIPT_SWITCH_CANCELED",
  stale: "MANUSCRIPT_SWITCH_STALE",
  bindingUpdateFailed: "MANUSCRIPT_SWITCH_BINDING_UPDATE_FAILED",
  committedReadbackFailed: "MANUSCRIPT_SWITCH_COMMITTED_READBACK_FAILED"
} as const;

export type ManuscriptSwitchErrorCode =
  (typeof MANUSCRIPT_SWITCH_ERROR_CODES)[keyof typeof MANUSCRIPT_SWITCH_ERROR_CODES];

export type ManuscriptDirtyDecision = "save" | "discard" | "cancel";
export type ManuscriptSwitchReason = "user" | "external-registration" | "candidate" | "other";

export interface ManuscriptSwitchEditorState {
  currentFileRefId: EntityId;
  rawMarkdown: string;
  loadedContent: string;
  draftContent: string;
  metaSnapshot: string;
  outline: string;
  parseStatus: LabPodMarkdownDocumentStatus;
  hasPendingSave: boolean;
}

export interface SwitchCurrentManuscriptInput {
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  manuscriptChannel: ManuscriptChannel;
  targetFileRefId: EntityId;
  currentEditorState: ManuscriptSwitchEditorState;
  switchReason: ManuscriptSwitchReason;
  dirtyDecision?: ManuscriptDirtyDecision;
  confirmedDiscardUnsavedChanges?: boolean;
  confirmedExternalTargetWrite?: boolean;
  requestToken: number;
}

export interface ManuscriptEditorDocument {
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  bindingId: EntityId;
  fileRefId: EntityId;
  path: string;
  locationMode: FileRefLocationMode;
  source: EntitySource;
  rawMarkdown: string;
  loadedContent: string;
  draftContent: string;
  isDirty: boolean;
  parseStatus: LabPodMarkdownDocumentStatus;
  metaSnapshot: string;
  outline: string;
  outsideContent: string;
  diagnostics: LabPodMarkdownDiagnostic[];
  requestToken: number;
  readOnly: boolean;
}

export interface ManuscriptSwitchError {
  code: ManuscriptSwitchErrorCode;
  message: string;
}

export type SwitchCurrentManuscriptResult =
  | {
      status: "success";
      document: ManuscriptEditorDocument;
      warnings: string[];
      requestToken: number;
    }
  | {
      status: "skipped";
      reason: "already-current";
      currentEditorState: ManuscriptSwitchEditorState;
      warnings: string[];
      requestToken: number;
    }
  | {
      status: "error";
      error: ManuscriptSwitchError;
      warnings: string[];
      requestToken: number;
    };

export interface AvailableManuscriptItem {
  fileRefId: EntityId;
  title: string;
  displayName: string;
  pathSummary: string;
  locationMode: FileRefLocationMode;
  isCurrent: boolean;
  isDefault: boolean;
  source: EntitySource;
  createdAt: string;
  updatedAt: string;
}

export type AvailableManuscriptsResult =
  | {
      status: "success";
      ownerType: FileRefOwnerType;
      ownerId: EntityId;
      items: AvailableManuscriptItem[];
    }
  | {
      status: "error";
      ownerType: FileRefOwnerType;
      ownerId: EntityId;
      error: ManuscriptSwitchError;
    };
