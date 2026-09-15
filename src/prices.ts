import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { SpotPoint } from "./analyze.ts";

export type PriceArea = "DK1" | "DK2";

const EDS = "https://api.energidataservice.dk/dataset";
const ELSPOT_CUTOFF = "2025-10-01";
const TIP_MS = 20 * 60_000;

type EdsRecord = Record<string, string | number | null>;
type AreaCache = { spots: Record<string, number>; elspotDone?: boolean; historyTo?: string; tipAt?: number };
type Disk = { areas: Record<string, AreaCache> };

function cacheFile(): string {
  return process.env.EL_MCP_CACHE ?? resolve(homedir(), ".el-mcp-cache", "spots.json");
}

function loadDisk(): Disk {
  try {
    const path = cacheFile();
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Disk) : { areas: {} };
  } catch {
    return { areas: {} };
  }
}

function saveDisk(disk: Disk): void {
  const path = cacheFile();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(disk));
}

export function retryWaitSec(status: number, body: string, retryAfter: string | null): number | null {
  if (status !== 429) return null;
  const n = Number(/try again in (\d+)/i.exec(body)?.[1] ?? retryAfter);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function eds(dataset: string, params: Record<string, string>): Promise<EdsRecord[]> {
  const out: EdsRecord[] = [];
  const limit = 100_000;
  let offset = 0;
  for (;;) {
    const url = new URL(`${EDS}/${dataset}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    let json: { records?: EdsRecord[]; total?: number } | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(url);
      const text = await res.text();
      const wait = retryWaitSec(res.status, text, res.headers.get("retry-after"));
      if (wait !== null) {
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`EDS ${dataset} ${res.status}`);
      json = JSON.parse(text) as { records?: EdsRecord[]; total?: number };
      break;
    }
    if (!json) throw new Error(`EDS ${dataset} rate limit`);
    const rows = json.records ?? [];
    out.push(...rows);
    if (rows.length < limit || out.length >= (json.total ?? out.length)) break;
    offset += limit;
  }
  return out;
}

function hourKey(stamp: string): string {
  return stamp.slice(0, 13);
}

function toKwh(dkkPerMwh: number): number {
  return dkkPerMwh / 1000;
}

async function elspot(area: PriceArea, start: string, end: string): Promise<SpotPoint[]> {
  const rows = await eds("Elspotprices", {
    start,
    end,
    filter: JSON.stringify({ PriceArea: [area] }),
    columns: "HourDK,SpotPriceDKK",
    sort: "HourDK",
  });
  const out: SpotPoint[] = [];
  for (const r of rows) {
    const hour = r.HourDK;
    const px = r.SpotPriceDKK;
    if (typeof hour !== "string" || typeof px !== "number") continue;
    out.push({ key: hourKey(hour), spot: toKwh(px) });
  }
  return out;
}

async function dayAhead(area: PriceArea, start: string, end: string): Promise<SpotPoint[]> {
  const rows = await eds("DayAheadPrices", {
    start,
    end,
    filter: JSON.stringify({ PriceArea: [area] }),
    columns: "TimeDK,DayAheadPriceDKK",
    sort: "TimeDK",
  });
  const acc = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    const t = r.TimeDK;
    const px = r.DayAheadPriceDKK;
    if (typeof t !== "string" || typeof px !== "number") continue;
    const key = hourKey(t);
    const cur = acc.get(key) ?? { sum: 0, n: 0 };
    cur.sum += px;
    cur.n += 1;
    acc.set(key, cur);
  }
  return [...acc].map(([key, { sum, n }]) => ({ key, spot: toKwh(sum / n) }));
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function put(cache: AreaCache, pts: SpotPoint[]): void {
  for (const p of pts) cache.spots[p.key] = p.spot;
}

export function hoursInRange(spots: Record<string, number>, start: string, end: string): number {
  let n = 0;
  for (const key of Object.keys(spots)) if (key >= start && key < end) n += 1;
  return n;
}

/** Spot DKK/kWh. History is cached; only the today/tomorrow tip is refreshed. */
export async function fetchSpots(area: PriceArea, from: Date, to: Date): Promise<SpotPoint[]> {
  const start = ymd(from);
  const end = ymd(to);
  const today = ymd(new Date());
  const disk = loadDisk();
  const cache = disk.areas[area] ?? { spots: {} };

  if (start < ELSPOT_CUTOFF && !cache.elspotDone) {
    const until = end < ELSPOT_CUTOFF ? end : ELSPOT_CUTOFF;
    put(cache, await elspot(area, start, until));
    cache.elspotDone = true;
    disk.areas[area] = cache;
    saveDisk(disk);
  }

  const histFrom = start > ELSPOT_CUTOFF ? start : ELSPOT_CUTOFF;
  const histTo = end < today ? end : today;
  if (histFrom < histTo && (cache.historyTo ?? histFrom) < histTo) {
    put(cache, await dayAhead(area, cache.historyTo ?? histFrom, histTo));
    cache.historyTo = histTo;
    disk.areas[area] = cache;
    saveDisk(disk);
  }

  if (end > today && (!cache.tipAt || Date.now() - cache.tipAt > TIP_MS)) {
    put(cache, await dayAhead(area, today, end));
    cache.tipAt = Date.now();
    disk.areas[area] = cache;
    saveDisk(disk);
  }

  return Object.entries(cache.spots)
    .filter(([key]) => key >= `${start}T00` && key < `${end}T00`)
    .map(([key, spot]) => ({ key, spot }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

export function publishedHours(spots: SpotPoint[], date: string): SpotPoint[] {
  return spots.filter((s) => s.key.startsWith(date));
}

export function isDayPublished(spots: SpotPoint[], date: string): boolean {
  return publishedHours(spots, date).length >= 20;
}

/** Hours still ahead: rest of today, plus tomorrow after day-ahead is out. */
export function remainingHorizon(
  spots: SpotPoint[],
  today: string,
  tomorrow: string,
  nowHour: number,
  unpublished: boolean,
): SpotPoint[] {
  const nowKey = `${today}T${String(nowHour).padStart(2, "0")}`;
  return spots.filter((s) => {
    if (s.key <= nowKey) return false;
    const day = s.key.slice(0, 10);
    if (day === today) return true;
    if (day === tomorrow) return !unpublished;
    return false;
  });
}
