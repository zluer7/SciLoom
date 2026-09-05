import type { AuditableEntity, EntityId } from "./common";
import type { FileRefOwnerType } from "./experiment";
import type { ManuscriptChannel } from "./manuscriptChannel";

export type ManuscriptBinding = AuditableEntity & {
  schemaVersion: number;
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  manuscriptChannel: ManuscriptChannel;
  defaultFolderFileRefId?: EntityId | null;
  defaultManuscriptFileRefId?: EntityId | null;
  currentFileRefId?: EntityId | null;
};

export type CreateManuscriptBindingInput = Pick<ManuscriptBinding, "ownerType" | "ownerId"> &
  Partial<
    Pick<
      ManuscriptBinding,
      "manuscriptChannel" | "defaultFolderFileRefId" | "defaultManuscriptFileRefId" | "currentFileRefId"
    >
  >;

export type UpdateManuscriptBindingInput = Partial<
  Pick<
    ManuscriptBinding,
    "defaultFolderFileRefId" | "defaultManuscriptFileRefId" | "currentFileRefId"
  >
>;
