import assert from "node:assert/strict";
import { test } from "node:test";
import { weekdayOf } from "./analyze.ts";
import { expandPattern } from "./usage.ts";

test("expandPattern writes 24 hours a day and uses weekend on Sat/Sun", () => {
  const hours = Array.from({ length: 24 }, (_, h) => (h === 18 ? 2.3 : 0.4));
  const weekend = Array.from({ length: 24 }, (_, h) => (h === 18 ? 1.9 : 0.4));
  const usage = expandPattern({ name: "t", hours, weekend }, "2024-01-01", "2024-01-08");
  assert.equal(usage.length, 7 * 24);
  assert.equal(weekdayOf("2024-01-01"), 1);
  assert.equal(usage.find((u) => u.key === "2024-01-01T18")?.kwh, 2.3);
  assert.equal(usage.find((u) => u.key === "2024-01-06T18")?.kwh, 1.9);
});
