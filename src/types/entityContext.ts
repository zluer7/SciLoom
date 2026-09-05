import type { EntityId, ISODateString } from "./common";
import type { MissingEntityReference } from "./entityReference";
import type { EntityType, RelationType } from "./planning";

export type EntityContextSourceModule =
  | "planning"
  | "experiment"
  | "literature"
  | "outputConversion"
  | "output"
  | "unknown";

export type LinkSummarySource = "entityLink" | "literatureLink" | "fallbackField";

export interface EntitySummary {
  entityType: EntityType;
  entityId: EntityId;
  title: string;
  subtitle?: string;
  status?: string;
  tags?: string[];
  createdAt?: ISODateString;
  updatedAt?: ISODateString;
  sourceModule?: EntityContextSourceModule;
  sourceAvailable: boolean;
  missingReason?: string;
}

export type TargetSummary = EntitySummary;

export interface LinkedEntitySummary {
  linkId?: EntityId;
  source: EntitySummary;
  target: EntitySummary;
  relationType: RelationType | string;
  description?: string;
  note?: string;
  confidence?: number | string;
  evidenceRole?: string;
  linkSource: LinkSummarySource;
  createdAt?: ISODateString;
  updatedAt?: ISODateString;
}

export interface EvidenceSummary {
  evidenceType: EntityType | string;
  evidenceId: EntityId;
  title: string;
  contentSummary?: string;
  relationType?: RelationType | string;
  evidenceRole?: string;
  confidence?: number | string;
  userConfirmed?: boolean;
  sourceModule?: EntityContextSourceModule;
  source?: EntitySummary;
}

export interface EntityCrossModuleContext {
  entity: EntitySummary;
  outgoingLinks: LinkedEntitySummary[];
  incomingLinks: LinkedEntitySummary[];
  linkedEntities: LinkedEntitySummary[];
  backReferences: LinkedEntitySummary[];
  evidenceSummaries: EvidenceSummary[];
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
}
