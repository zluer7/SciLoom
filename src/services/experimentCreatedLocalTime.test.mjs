import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCreatedLocalTimeNotPatched,
  captureCreatedLocalTime,
  isCreatedLocalDate,
  isCreatedLocalTime
} from "./experimentCreatedLocalTime.ts";

function parts(year, month, day, hour, minute) {
  return { year, month, day, hour, minute };
}

test("captures createdAt, local date, and HHmm from one instant", () => {
  const instant = new Date("2026-07-17T01:05:45.678Z");
  let nowCalls = 0;
  let receivedInstant;

  const facts = captureCreatedLocalTime({
    now: () => {
      nowCalls += 1;
      return instant;
    },
    resolveLocalParts: (value) => {
      receivedInstant = value;
      return parts(2026, 7, 17, 9, 5);
    }
  });

  assert.equal(nowCalls, 1);
  assert.strictEqual(receivedInstant, instant);
  assert.deepEqual(facts, {
    createdAt: "2026-07-17T01:05:45.678Z",
    createdLocalDate: "2026-07-17",
    createdLocalTime: "0905"
  });
});

test("formats midnight, noon, and 23:59 with fixed-width local values", () => {
  const instant = new Date("2026-07-17T00:00:00.000Z");
  for (const [localParts, expectedDate, expectedTime] of [
    [parts(2026, 7, 17, 0, 0), "2026-07-17", "0000"],
    [parts(2026, 7, 17, 12, 0), "2026-07-17", "1200"],
    [parts(2026, 7, 17, 23, 59), "2026-07-17", "2359"]
  ]) {
    const facts = captureCreatedLocalTime({
      now: () => instant,
      resolveLocalParts: () => localParts
    });
    assert.equal(facts.createdLocalDate, expectedDate);
    assert.equal(facts.createdLocalTime, expectedTime);
  }
});

test("freezes the creation-zone interpretation across UTC date and DST boundaries", () => {
  const instant = new Date("2026-03-08T09:30:00.000Z");
  const cases = [
    [parts(2026, 3, 8, 9, 30), "2026-03-08", "0930"],
    [parts(2026, 3, 8, 17, 30), "2026-03-08", "1730"],
    [parts(2026, 3, 8, 1, 30), "2026-03-08", "0130"],
    [parts(2026, 3, 7, 23, 30), "2026-03-07", "2330"]
  ];

  for (const [localParts, expectedDate, expectedTime] of cases) {
    const facts = captureCreatedLocalTime({
      now: () => instant,
      resolveLocalParts: () => localParts
    });
    assert.equal(facts.createdAt, instant.toISOString());
    assert.equal(facts.createdLocalDate, expectedDate);
    assert.equal(facts.createdLocalTime, expectedTime);
  }
});

test("validates strict calendar date and HHmm formats", () => {
  for (const value of ["2026-07-17", "2024-02-29"]) assert.equal(isCreatedLocalDate(value), true);
  for (const value of ["2026-7-17", "2026/07/17", "2026-02-30", "2026-07-17T00:00:00Z", ""])
    assert.equal(isCreatedLocalDate(value), false);
  for (const value of ["0000", "0905", "1200", "2359"]) assert.equal(isCreatedLocalTime(value), true);
  for (const value of ["905", "09:05", "2400", "2360", "090500", ""]) assert.equal(isCreatedLocalTime(value), false);
});

test("ordinary updates reject both frozen fields instead of silently ignoring them", () => {
  for (const patch of [
    { createdLocalDate: "2026-07-18" },
    { createdLocalTime: "1200" },
    { createdLocalDate: "2026-07-17", title: "still rejected" }
  ]) {
    assert.throws(
      () => assertCreatedLocalTimeNotPatched(patch, "Experiment"),
      /creation-local-time fields are immutable/
    );
  }
  assert.doesNotThrow(() => assertCreatedLocalTimeNotPatched({ title: "allowed" }, "Experiment"));
});
