import type { ISODateString } from "./common";
import type {
  AffectedEntity,
  AffectedScope,
  RefreshKey,
  WriteFeedbackStatus
} from "./writeFeedback";

export type RefreshEventSource =
  | "service.write"
  | "ai.apply"
  | "manual"
  | "system"
  | "unknown"
  | (string & {});

export type RefreshKeyPattern = RefreshKey | "global.changed" | `${string}.*` | (string & {});

export interface RefreshEvent {
  id: string;
  keys: RefreshKey[];
  affectedEntities: AffectedEntity[];
  affectedScopes: AffectedScope[];
  source: RefreshEventSource;
  operation?: string;
  reason?: string;
  writeFeedbackStatus?: WriteFeedbackStatus;
  warnings?: string[];
  errors?: string[];
  skipped?: string[];
  createdAt: ISODateString;
}

export type RefreshEventListener = (event: RefreshEvent) => void;

export interface RefreshSubscription {
  unsubscribe(): void;
}

export interface CreateRefreshEventFromWriteFeedbackOptions {
  id?: string;
  source?: RefreshEventSource;
  reason?: string;
  createdAt?: ISODateString;
  additionalKeys?: RefreshKey[];
}
