import type { ManuscriptChannel } from "../types";
import type { CandidateManuscriptSource } from "../types/candidateManuscript";
import { createStableShortId } from "./managedPathService";

export const LITERATURE_CANDIDATE_FILENAME_PATTERN =
  /^(literature-outline|dedicated-notes)_(ai|user)_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[a-f0-9]{8}\.md$/u;

export interface LiteratureCandidateFileNamePlan {
  manuscriptChannel: "literature_outline" | "dedicated_notes";
  source: CandidateManuscriptSource;
  occurredAt: string;
  requestId: string;
  requestShortId: string;
  channelPrefix: "literature-outline" | "dedicated-notes";
  timestampSegment: string;
  fileName: string;
}

const RFC3339_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u;
const STABLE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,256}$/u;

function validCalendarDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function parseCandidateOccurredAt(occurredAt: string) {
  const value = String(occurredAt ?? "");
  const match = value.match(RFC3339_WITH_ZONE);
  if (!match) throw new Error("CANDIDATE_OCCURRED_AT_INVALID: occurredAt must be RFC3339 with Z or an explicit offset.");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const zoneValid = zone === "Z" || (() => {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    return offsetHour <= 23 && offsetMinute <= 59;
  })();
  if (
    !validCalendarDate(year, month, day) ||
    hour > 23 || minute > 59 || second > 59 || !zoneValid ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error("CANDIDATE_OCCURRED_AT_INVALID: occurredAt is not a valid RFC3339 timestamp.");
  }
  return {
    occurredAt: value,
    calendarDate: `${yearText}-${monthText}-${dayText}`,
    clockTime: `${hourText}${minuteText}${secondText}`,
    timestampSegment: `${yearText}-${monthText}-${dayText}_${hourText}${minuteText}${secondText}`
  };
}

export function validateCandidateRequestId(requestId: string) {
  const value = String(requestId ?? "");
  if (!STABLE_REQUEST_ID.test(value)) {
    throw new Error("CANDIDATE_REQUEST_ID_INVALID: requestId must be 1-256 stable ASCII identifier characters.");
  }
  return value;
}

export function buildLiteratureCandidateFileName(input: {
  manuscriptChannel: ManuscriptChannel;
  source: CandidateManuscriptSource | string;
  occurredAt: string;
  requestId: string;
}): LiteratureCandidateFileNamePlan {
  const manuscriptChannel = input.manuscriptChannel;
  if (manuscriptChannel !== "literature_outline" && manuscriptChannel !== "dedicated_notes") {
    throw new Error(
      manuscriptChannel ? "CANDIDATE_CHANNEL_UNSUPPORTED: Literature Candidate channel is unsupported." : "CANDIDATE_CHANNEL_REQUIRED: Literature Candidate channel is required."
    );
  }
  if (input.source !== "ai" && input.source !== "user") {
    throw new Error("CANDIDATE_SOURCE_INVALID: Literature Candidate source must be ai or user.");
  }
  const requestId = validateCandidateRequestId(input.requestId);
  const time = parseCandidateOccurredAt(input.occurredAt);
  const requestShortId = createStableShortId(requestId).slice(0, 8);
  const channelPrefix = manuscriptChannel === "literature_outline"
    ? "literature-outline" as const
    : "dedicated-notes" as const;
  const fileName = `${channelPrefix}_${input.source}_${time.timestampSegment}_${requestShortId}.md`;
  if (!LITERATURE_CANDIDATE_FILENAME_PATTERN.test(fileName)) {
    throw new Error("CANDIDATE_FILENAME_INVALID: generated Literature Candidate filename is invalid.");
  }
  return {
    manuscriptChannel,
    source: input.source,
    occurredAt: time.occurredAt,
    requestId,
    requestShortId,
    channelPrefix,
    timestampSegment: time.timestampSegment,
    fileName
  };
}

export const literatureCandidateFilenameService = {
  build: buildLiteratureCandidateFileName
};
