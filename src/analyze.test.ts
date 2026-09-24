import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_FORESIGHT,
  DEFAULT_FRACTION,
  retailPrice,
  formatHours,
  yearSaving,
  weekdayShape,
  weekdayOf,
  horizonShift,
  usageTrends,
  type HourPoint,
  type SpotPoint,
} from "./analyze.ts";
import { expandPattern } from "./usage.ts";
import { parseCharges, parseTimeseries } from "./eloverblik.ts";
import { remainingHorizon } from "./prices.ts";

const DSO0 = Array.from({ length: 24 }, () => 0);

function spikeDay(date: string): { usage: HourPoint[]; spots: SpotPoint[] } {
  const usage: HourPoint[] = [
    { key: `${date}T02`, kwh: 0.4 },
    { key: `${date}T12`, kwh: 0.4 },
    { key: `${date}T19`, kwh: 2.0 },
  ];
  const spots: SpotPoint[] = [
    { key: `${date}T02`, spot: 0.2 },
    { key: `${date}T12`, spot: 0.5 },
    { key: `${date}T19`, spot: 2.0 },
  ];
  return { usage, spots };
}

test("retail price is (spot + dso + 0.08) * 1.25", () => {
  assert.equal(retailPrice(2, 0.5), (2 + 0.5 + 0.08) * 1.25);
});

test("formatHours names singles, ranges, and gaps", () => {
  assert.equal(formatHours([19]), "19:00");
  assert.equal(formatHours([17, 18, 19]), "17:00–19:00");
  assert.equal(formatHours([17, 18, 19, 22]), "17:00–19:00 and 22:00");
});

test("A: expensive-hour spike rebilled at that day's cheap hours, then scaled", () => {
  const a = spikeDay("2024-01-01");
  const b = spikeDay("2024-01-02");
  const got = yearSaving([...a.usage, ...b.usage], [...a.spots, ...b.spots], DSO0);
  // per day: baseline 0.4, lump (2.0-0.4)*0.4=0.64, prices 0.35 vs 2.60, cheap mean is hour 02 only
  const pCheap = retailPrice(0.2, 0);
  const pExp = retailPrice(2.0, 0);
  const perDay = 0.64 * (pExp - pCheap);
  assert.equal(got.days, 2);
  assert.equal(got.scaled, true);
  assert.equal(got.dkk, Math.round(((perDay * 2 * 365) / 2) * DEFAULT_FORESIGHT));
  assert.equal(got.foresight, DEFAULT_FORESIGHT);
  assert.equal(got.from, "19:00");
  assert.equal(got.to, "02:00");
  assert.match(got.headline, /^Last year you could have saved DKK \d+ \(scaled from 2 days\) by moving usage from 19:00 to 02:00\./);
  assert.match(got.headline, /40%/);
  assert.match(got.headline, /85% of perfect foresight/);
});

test("A: foresight 1 is the undiscounted saving", () => {
  const a = spikeDay("2024-01-01");
  const b = spikeDay("2024-01-02");
  const usage = [...a.usage, ...b.usage];
  const spots = [...a.spots, ...b.spots];
  const full = yearSaving(usage, spots, DSO0, { foresight: 1 });
  const perDay = 0.64 * (retailPrice(2.0, 0) - retailPrice(0.2, 0));
  assert.equal(full.dkk, Math.round((perDay * 2 * 365) / 2));
  assert.equal(full.foresight, 1);
  assert.match(full.headline, /100% of perfect foresight/);
});

test("A: empty usage is missing data, not a zero-krone year", () => {
  const got = yearSaving([], [{ key: "2024-01-01T12", spot: 1 }], DSO0);
  assert.equal(got.dkk, 0);
  assert.equal(got.days, 0);
  assert.match(got.headline, /missing data, not zero use/);
});

test("A: baseload in an expensive hour is not moved", () => {
  const usage: HourPoint[] = [
    { key: "2024-01-01T02", kwh: 1 },
    { key: "2024-01-01T19", kwh: 1 },
  ];
  const spots: SpotPoint[] = [
    { key: "2024-01-01T02", spot: 0.1 },
    { key: "2024-01-01T19", spot: 3 },
  ];
  const got = yearSaving(usage, spots, DSO0);
  assert.equal(got.dkk, 0);
  assert.match(got.headline, /DKK 0/);
});

test("365-day trends: daily peak, weekend vs weekday, months present", () => {
  const hours = Array.from({ length: 24 }, (_, h) => (h === 19 ? 2 : 0.4));
  const weekend = Array.from({ length: 24 }, (_, h) => (h === 11 ? 2 : 0.4));
  const usage = expandPattern({ name: "t", hours, weekend }, "2024-01-01", "2024-03-01");
  const spots: SpotPoint[] = usage.map((u) => ({ key: u.key, spot: u.key.endsWith("T19") ? 2 : 0.2 }));
  const t = usageTrends(usage, spots, DSO0);
  assert.ok(t.days >= 60);
  assert.equal(t.daily.reduce((a, b) => (b.kwh > a.kwh ? b : a)).hour, 19);
  assert.equal(t.weekly.find((w) => w.weekday === 6)?.daily.reduce((a, b) => (b.kwh > a.kwh ? b : a)).hour, 11);
  assert.deepEqual(
    t.annual.map((m) => m.month),
    ["2024-01", "2024-02"],
  );
  assert.equal(t.annual[0]!.peakHour, 19);
});

test("weekdayShape averages the last four same weekdays and skips missing hours", () => {
  // 2024-01-01 is a Monday (1). Four Mondays + one extra older Monday.
  const mondays = ["2023-12-04", "2023-12-11", "2023-12-18", "2023-12-25", "2024-01-01"];
  const usage: HourPoint[] = mondays.flatMap((d, i) => [
    { key: `${d}T19`, kwh: i + 1 },
    ...(i === mondays.length - 1 ? [] : [{ key: `${d}T12`, kwh: 0.5 }]),
  ]);
  const shape = weekdayShape(usage, 1, 4);
  assert.equal(weekdayOf("2024-01-01"), 1);
  assert.equal(shape.get(19), (2 + 3 + 4 + 5) / 4);
  assert.equal(shape.get(12), (0.5 + 0.5 + 0.5) / 3);
  assert.equal(shape.has(3), false);
});

/** Four Tuesdays ending 2024-01-02, same hour-of-day kWh. */
function tuesdays(hours: Record<number, number>): HourPoint[] {
  return ["2023-12-12", "2023-12-19", "2023-12-26", "2024-01-02"].flatMap((d) =>
    Object.entries(hours).map(([h, kwh]) => ({
      key: `${d}T${String(Number(h)).padStart(2, "0")}`,
      kwh,
    })),
  );
}

test("B: best from→to is a push-back of the spike", () => {
  const date = "2024-01-02";
  const spots: SpotPoint[] = [
    { key: `${date}T12`, spot: 0.5 },
    { key: `${date}T19`, spot: 2.0 },
    { key: `${date}T22`, spot: 0.1 },
  ];
  const got = horizonShift(tuesdays({ 12: 0.4, 19: 2.0, 22: 0.4 }), spots, DSO0, { today: date });
  const y = (2.0 - 0.4) * DEFAULT_FRACTION * (retailPrice(2.0, 0) - retailPrice(0.1, 0));
  assert.equal(got.dkk, Math.round(y * DEFAULT_FORESIGHT));
  assert.match(got.headline, /85% of perfect foresight/);
  assert.equal(got.from, "19:00");
  assert.equal(got.to, "22:00");
  assert.equal(got.direction, "push_back");
  assert.equal(got.window, "today");
  assert.match(got.headline, /For the rest of today you can save DKK \d+ by pushing usage from 19:00 back to 22:00/);
});

test("B: unpublished tomorrow stays on the rest of today", () => {
  const spots: SpotPoint[] = [
    { key: "2024-01-02T19", spot: 2.0 },
    { key: "2024-01-02T22", spot: 0.2 },
  ];
  const got = horizonShift(tuesdays({ 19: 2.0, 22: 0.4 }), spots, DSO0, {
    today: "2024-01-02",
    unpublished: true,
  });
  assert.equal(got.unpublished, true);
  assert.equal(got.window, "today");
  assert.equal(got.direction, "push_back");
  assert.match(got.headline, /not published yet/);
  assert.match(got.headline, /For the rest of today you can save DKK \d+ by pushing usage from 19:00 back to 22:00/);
});

test("B: after publish, push the evening spike into tomorrow morning", () => {
  const spots: SpotPoint[] = [
    { key: "2024-01-02T19", spot: 2.0 },
    { key: "2024-01-03T02", spot: 0.1 },
  ];
  const usage = [
    ...tuesdays({ 19: 2.0 }),
    ...["2023-12-13", "2023-12-20", "2023-12-27", "2024-01-03"].map((d) => ({ key: `${d}T02`, kwh: 0.4 })),
  ];
  const got = horizonShift(usage, spots, DSO0, { today: "2024-01-02" });
  assert.equal(got.window, "horizon");
  assert.equal(got.direction, "push_back");
  assert.equal(got.from, "19:00");
  assert.equal(got.to, "02:00 tomorrow");
  assert.match(got.headline, /From now through tomorrow you can save DKK \d+ by pushing usage from 19:00 back to 02:00 tomorrow/);
});

test("B: cheaper earlier hour is a pull-forward", () => {
  const date = "2024-01-02";
  const spots: SpotPoint[] = [
    { key: `${date}T14`, spot: 0.1 },
    { key: `${date}T19`, spot: 2.0 },
  ];
  const got = horizonShift(tuesdays({ 14: 0.4, 19: 2.0 }), spots, DSO0, { today: date });
  assert.equal(got.direction, "pull_forward");
  assert.match(got.headline, /pulling usage from 19:00 forward to 14:00/);
});

test("B: empty spots are missing data", () => {
  const got = horizonShift(tuesdays({ 19: 2 }), [], DSO0, { today: "2024-01-02" });
  assert.equal(got.dkk, 0);
  assert.match(got.headline, /missing data, not zero use/);
});

test("remainingHorizon is rest of today, plus tomorrow only after publish", () => {
  const spots: SpotPoint[] = [
    { key: "2024-01-02T10", spot: 1 },
    { key: "2024-01-02T19", spot: 2 },
    { key: "2024-01-03T02", spot: 0.2 },
  ];
  const morning = remainingHorizon(spots, "2024-01-02", "2024-01-03", 11, true);
  assert.deepEqual(
    morning.map((s) => s.key),
    ["2024-01-02T19"],
  );
  const afternoon = remainingHorizon(spots, "2024-01-02", "2024-01-03", 13, false);
  assert.deepEqual(
    afternoon.map((s) => s.key),
    ["2024-01-02T19", "2024-01-03T02"],
  );
});

test("charges fixture: hourly DSO plus a flat tariff", () => {
  const dso = parseCharges({
    result: [
      {
        result: {
          tariffs: [
            {
              periodType: "HOUR",
              prices: [
                { position: "1", price: 0.1 },
                { position: "20", price: 1.2 },
              ],
            },
            { periodType: "DAY", prices: [{ position: "1", price: 0.05 }] },
          ],
        },
      },
    ],
  });
  assert.ok(Math.abs(dso[0]! - 0.15) < 1e-9);
  assert.ok(Math.abs(dso[19]! - 1.25) < 1e-9);
});

test("timeseries fixture: missing quality is skipped, consumption hours are kept", () => {
  const usage = parseTimeseries({
    result: [
      {
        MyEnergyData_MarketDocument: {
          TimeSeries: [
            {
              businessType: "A04",
              Period: [
                {
                  resolution: "PT1H",
                  timeInterval: { start: "2024-01-01T23:00:00Z" },
                  Point: [
                    { position: "1", "out_Quantity.quantity": "0.4", "out_Quantity.quality": "A04" },
                    { position: "2", "out_Quantity.quantity": "9", "out_Quantity.quality": "A02" },
                    { position: "20", "out_Quantity.quantity": "2.0", "out_Quantity.quality": "A04" },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  });
  assert.deepEqual(
    usage.map((u) => u.key),
    ["2024-01-02T00", "2024-01-02T19"],
  );
  assert.equal(usage[0]!.kwh, 0.4);
  assert.equal(usage[1]!.kwh, 2);
});
