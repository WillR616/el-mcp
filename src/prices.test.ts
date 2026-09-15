import assert from "node:assert/strict";
import { test } from "node:test";
import { hoursInRange, retryWaitSec } from "./prices.ts";

test("429 wait comes from the EDS body, else Retry-After, else 2s", () => {
  assert.equal(retryWaitSec(429, "Rate limit is exceeded. Try again in 17 seconds", null), 17);
  assert.equal(retryWaitSec(429, "nope", "8"), 8);
  assert.equal(retryWaitSec(429, "nope", null), 2);
  assert.equal(retryWaitSec(200, "Try again in 17 seconds", "8"), null);
});

test("hoursInRange counts cached hour keys inside [start, end)", () => {
  const spots = { "2025-09-14T00": 0.6, "2025-09-14T23": 0.5, "2025-10-01T00": 0.4 };
  assert.equal(hoursInRange(spots, "2025-09-14", "2025-10-01"), 2);
  assert.equal(hoursInRange(spots, "2025-10-01", "2025-10-02"), 1);
});
