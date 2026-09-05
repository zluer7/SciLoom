import type { EntityId } from "./common";
import type {
  CreateFileRefInput,
  CustomField,
  FileRefPathSummary,
  FileRefType,
  UpdateFileRefInput
} from "./experiment";

export type OutputFileRefOwnerType =
  | "resultItem"
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "researchOutput";

export interface CreateOutputFileRefMetadataInput {
  ownerType: OutputFileRefOwnerType;
  ownerId: EntityId;
  path: string;
  fileType?: FileRefType | string;
  title?: string;
  description?: string;
  mimeType?: string;
  sizeBytes?: number;
  customFields?: CustomField[];
  source?: CreateFileRefInput["source"];
}

export interface UpdateOutputFileRefMetadataInput {
  fileRefId: EntityId;
  ownerType?: OutputFileRefOwnerType;
  ownerId?: EntityId;
  path?: string;
  fileType?: FileRefType | string;
  title?: string;
  description?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  customFields?: CustomField[];
  source?: UpdateFileRefInput["source"];
}

export interface RemoveOutputFileRefMetadataInput {
  fileRefId: EntityId;
  confirmedMetadataOnly: true;
}

export interface OutputFileRefMetadataResult {
  ok: boolean;
  metadataOnly: true;
  ownerType?: OutputFileRefOwnerType;
  ownerId?: EntityId;
  fileRefId?: EntityId;
  pathSummary?: FileRefPathSummary;
  warnings: string[];
  skipped: string[];
}
