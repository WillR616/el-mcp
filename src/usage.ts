import { weekdayOf, type HourKey, type HourPoint } from "./analyze.ts";

export type UsagePattern = {
  name: string;
  hours: number[];
  weekend?: number[];
};

export function cphDate(d = new Date()): string {
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Copenhagen" });
}

export function addDate(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days, 12)).toISOString().slice(0, 10);
}

export function atNoon(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12));
}

export function cphHour(d = new Date()): number {
  return Number(d.toLocaleString("sv-SE", { timeZone: "Europe/Copenhagen" }).slice(11, 13));
}

function pad(h: number): string {
  return String(h).padStart(2, "0");
}

export function expandPattern(pattern: UsagePattern, from: string, to: string): HourPoint[] {
  if (pattern.hours.length !== 24) throw new Error(`${pattern.name}: hours must be 24`);
  if (pattern.weekend && pattern.weekend.length !== 24) throw new Error(`${pattern.name}: weekend must be 24`);
  const out: HourPoint[] = [];
  for (let d = from; d < to; d = addDate(d, 1)) {
    const wd = weekdayOf(d);
    const hours = wd === 0 || wd === 6 ? (pattern.weekend ?? pattern.hours) : pattern.hours;
    for (let h = 0; h < 24; h++) out.push({ key: `${d}T${pad(h)}`, kwh: hours[h]! });
  }
  return out;
}

export const HOUR_CAP_DAYS = 14;
export const DAY_CAP_DAYS = 366;

export type UsageGrain = "hour" | "day";

type SliceBase = {
  from: string;
  to: string;
  kwh: number;
  missing: number;
  /** First hour key past the last metered point, when the request runs past it. */
  unmeteredFrom?: string;
};

export type UsageSlice =
  | (SliceBase & { grain: "hour"; hours: { key: HourKey; kwh: number }[] })
  | (SliceBase & { grain: "day"; days: { date: string; kwh: number; hours: number }[] });

function assertYmd(s: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new Error(`Date must be YYYY-MM-DD, got ${s}`);
}

function inclusiveDays(from: string, to: string): number {
  let n = 0;
  for (let d = from; d <= to; d = addDate(d, 1)) n++;
  return n;
}

function hourAfter(key: string): string {
  const date = key.slice(0, 10);
  const h = Number(key.slice(11, 13));
  return h < 23 ? `${date}T${pad(h + 1)}` : `${addDate(date, 1)}T00`;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Inclusive Copenhagen dates. Missing hours stay absent. Hours after the last metered point are unmetered, not zero. */
export function sliceUsage(usage: HourPoint[], from: string, to: string, grain: UsageGrain): UsageSlice {
  assertYmd(from);
  assertYmd(to);
  if (from > to) throw new Error("from is after to");
  const span = inclusiveDays(from, to);
  if (grain === "hour" && span > HOUR_CAP_DAYS) {
    throw new Error(`Hour grain covers at most ${HOUR_CAP_DAYS} days. Narrow the range or use grain day.`);
  }
  if (grain === "day" && span > DAY_CAP_DAYS) {
    throw new Error(`Day grain covers at most ${DAY_CAP_DAYS} days.`);
  }

  let last = "";
  for (const u of usage) if (u.key > last) last = u.key;
  const startKey = `${from}T00`;
  const endKey = `${to}T23`;
  const unmeteredFrom = !last || last < startKey ? startKey : last < endKey ? hourAfter(last) : undefined;

  const present = new Set<string>();
  const inRange: HourPoint[] = [];
  let kwh = 0;
  for (const u of usage) {
    const date = u.key.slice(0, 10);
    if (date < from || date > to || u.key > endKey) continue;
    inRange.push(u);
    present.add(u.key);
    kwh += u.kwh;
  }

  let missing = 0;
  if (last >= startKey) {
    const stop = last < endKey ? last : endKey;
    const stopDate = stop.slice(0, 10);
    const stopHour = Number(stop.slice(11, 13));
    for (let d = from; d <= stopDate; d = addDate(d, 1)) {
      const hEnd = d === stopDate ? stopHour : 23;
      for (let h = 0; h <= hEnd; h++) {
        if (!present.has(`${d}T${pad(h)}`)) missing++;
      }
    }
  }

  const base = { from, to, kwh: round3(kwh), missing, ...(unmeteredFrom ? { unmeteredFrom } : {}) };
  switch (grain) {
    case "hour":
      return {
        ...base,
        grain,
        hours: inRange
          .sort((a, b) => (a.key < b.key ? -1 : 1))
          .map((u) => ({ key: u.key, kwh: round3(u.kwh) })),
      };
    case "day": {
      const byDay = new Map<string, { kwh: number; hours: number }>();
      for (const u of inRange) {
        const date = u.key.slice(0, 10);
        const row = byDay.get(date) ?? { kwh: 0, hours: 0 };
        row.kwh += u.kwh;
        row.hours++;
        byDay.set(date, row);
      }
      return {
        ...base,
        grain,
        days: [...byDay.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([date, row]) => ({ date, kwh: round3(row.kwh), hours: row.hours })),
      };
    }
    default: {
      const _n: never = grain;
      throw new Error(String(_n));
    }
  }
}

/** Last `n` complete (24-hour) days in the series, ending on the latest one. */
export function lastCompleteRange(usage: HourPoint[], n = 7): { from: string; to: string } {
  if (!usage.length) throw new Error("No metered hours in the last year. An empty range is missing data, not zero use.");
  const byDay = new Map<string, number>();
  for (const u of usage) {
    const date = u.key.slice(0, 10);
    byDay.set(date, (byDay.get(date) ?? 0) + 1);
  }
  const dates = [...byDay.keys()].sort();
  let to = "";
  for (let i = dates.length - 1; i >= 0; i--) {
    if ((byDay.get(dates[i]!) ?? 0) >= 24) {
      to = dates[i]!;
      break;
    }
  }
  if (!to) throw new Error("No complete metered day in the last year.");
  const first = dates[0]!;
  const from = addDate(to, -(n - 1));
  return { from: from < first ? first : from, to };
}
