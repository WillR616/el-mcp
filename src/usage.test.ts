import assert from "node:assert/strict";
import { test } from "node:test";
import { weekdayOf } from "./analyze.ts";
import { expandPattern, sliceUsage } from "./usage.ts";

test("expandPattern writes 24 hours a day and uses weekend on Sat/Sun", () => {
  const hours = Array.from({ length: 24 }, (_, h) => (h === 18 ? 2.3 : 0.4));
  const weekend = Array.from({ length: 24 }, (_, h) => (h === 18 ? 1.9 : 0.4));
  const usage = expandPattern({ name: "t", hours, weekend }, "2024-01-01", "2024-01-08");
  assert.equal(usage.length, 7 * 24);
  assert.equal(weekdayOf("2024-01-01"), 1);
  assert.equal(usage.find((u) => u.key === "2024-01-01T18")?.kwh, 2.3);
  assert.equal(usage.find((u) => u.key === "2024-01-06T18")?.kwh, 1.9);
});

test("hour slice drops a gap and counts it missing", () => {
  const usage = expandPattern({ name: "t", hours: Array.from({ length: 24 }, () => 1) }, "2024-01-01", "2024-01-03").filter(
    (u) => u.key !== "2024-01-01T18",
  );
  const hour = sliceUsage(usage, "2024-01-01", "2024-01-01", "hour");
  assert.equal(hour.grain, "hour");
  if (hour.grain !== "hour") return;
  assert.equal(hour.hours.length, 23);
  assert.equal(hour.missing, 1);
  assert.equal(hour.kwh, 23);
  assert.equal(hour.hours.some((h) => h.key === "2024-01-01T18"), false);
  assert.equal(hour.unmeteredFrom, undefined);
});

test("day slice sums present hours", () => {
  const usage = expandPattern({ name: "t", hours: Array.from({ length: 24 }, () => 1) }, "2024-01-01", "2024-01-03").filter(
    (u) => u.key !== "2024-01-01T18",
  );
  const day = sliceUsage(usage, "2024-01-01", "2024-01-02", "day");
  assert.equal(day.grain, "day");
  if (day.grain !== "day") return;
  assert.deepEqual(
    day.days.map((d) => ({ date: d.date, kwh: d.kwh, hours: d.hours })),
    [
      { date: "2024-01-01", kwh: 23, hours: 23 },
      { date: "2024-01-02", kwh: 24, hours: 24 },
    ],
  );
  assert.equal(day.missing, 1);
  assert.equal(day.kwh, 47);
});

test("hour grain rejects more than 14 days", () => {
  const usage = expandPattern({ name: "t", hours: Array.from({ length: 24 }, () => 1) }, "2024-01-01", "2024-01-02");
  assert.throws(() => sliceUsage(usage, "2024-01-01", "2024-01-15", "hour"), /at most 14 days/);
  assert.equal(sliceUsage(usage, "2024-01-01", "2024-01-14", "hour").grain, "hour");
});

test("range past the last point is unmetered, not zeros", () => {
  const usage = expandPattern({ name: "t", hours: Array.from({ length: 24 }, () => 1) }, "2024-01-01", "2024-01-03");
  const day = sliceUsage(usage, "2024-01-02", "2024-01-05", "day");
  assert.equal(day.grain, "day");
  if (day.grain !== "day") return;
  assert.deepEqual(day.days, [{ date: "2024-01-02", kwh: 24, hours: 24 }]);
  assert.equal(day.unmeteredFrom, "2024-01-03T00");
  assert.equal(day.missing, 0);
  assert.equal(day.days.some((d) => d.kwh === 0), false);
});
