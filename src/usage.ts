import { weekdayOf, type HourPoint } from "./analyze.ts";

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
