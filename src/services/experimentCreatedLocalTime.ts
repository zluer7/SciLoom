export type CreatedLocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

export type CreatedLocalTimeFacts = {
  createdAt: string;
  createdLocalDate: string;
  createdLocalTime: string;
};

export type CreatedLocalTimeClock = {
  now?: () => Date;
  resolveLocalParts?: (instant: Date) => CreatedLocalDateTimeParts;
};

const pad2 = (value: number) => String(value).padStart(2, "0");

function systemLocalParts(instant: Date): CreatedLocalDateTimeParts {
  return {
    year: instant.getFullYear(),
    month: instant.getMonth() + 1,
    day: instant.getDate(),
    hour: instant.getHours(),
    minute: instant.getMinutes()
  };
}

export function isCreatedLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

export function isCreatedLocalTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}$/.test(value)) return false;
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(2, 4));
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

export function assertCreatedLocalTimeRecord(
  value: Record<string, unknown>,
  entityName: string
): asserts value is Record<string, unknown> & CreatedLocalTimeFacts {
  if (!isCreatedLocalDate(value.createdLocalDate)) {
    throw new Error(`${entityName} created local date must use a valid YYYY-MM-DD value.`);
  }
  if (!isCreatedLocalTime(value.createdLocalTime)) {
    throw new Error(`${entityName} created local time must use a valid HHmm value.`);
  }
}

export function assertCreatedLocalTimeNotPatched(
  patch: Record<string, unknown>,
  entityName: string
) {
  if (
    Object.prototype.hasOwnProperty.call(patch, "createdLocalDate") ||
    Object.prototype.hasOwnProperty.call(patch, "createdLocalTime")
  ) {
    throw new Error(`${entityName} creation-local-time fields are immutable in ordinary updates.`);
  }
}

export function captureCreatedLocalTime(clock: CreatedLocalTimeClock = {}): CreatedLocalTimeFacts {
  const instant = (clock.now ?? (() => new Date()))();
  if (Number.isNaN(instant.getTime())) {
    throw new Error("Experiment creation clock returned an invalid instant.");
  }
  const local = (clock.resolveLocalParts ?? systemLocalParts)(instant);
  const facts = {
    createdAt: instant.toISOString(),
    createdLocalDate: `${String(local.year).padStart(4, "0")}-${pad2(local.month)}-${pad2(local.day)}`,
    createdLocalTime: `${pad2(local.hour)}${pad2(local.minute)}`
  };
  assertCreatedLocalTimeRecord(facts, "Experiment creation");
  return facts;
}
