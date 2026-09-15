export const VAT = 1.25;
export const DEFAULT_MARKUP = 0.08;
export const DEFAULT_FRACTION = 0.4;
export const YEAR_DAYS = 365;

/** Copenhagen local hour: YYYY-MM-DDTHH */
export type HourKey = string;
export type HourPoint = { key: HourKey; kwh: number };
export type SpotPoint = { key: HourKey; spot: number };
export type Dso = readonly number[];

export type HourAvg = { hour: number; kwh: number; price: number | null };

export type Trends = {
  days: number;
  daily: HourAvg[];
  weekly: { weekday: number; daily: HourAvg[] }[];
  annual: { month: string; days: number; kwh: number; peakHour: number; peakKwh: number }[];
};

export type YearResult = {
  headline: string;
  dkk: number;
  from: string;
  to: string;
  days: number;
  scaled: boolean;
  fraction: number;
  trends: Trends;
};

export type ShiftDirection = "push_back" | "pull_forward";
export type ShiftWindow = "today" | "horizon";

export type HorizonResult = {
  headline: string;
  dkk: number;
  from: string;
  to: string;
  fromKey: HourKey;
  toKey: HourKey;
  direction: ShiftDirection | null;
  window: ShiftWindow;
  unpublished: boolean;
  fraction: number;
  fromKwh: number;
};

export function retailPrice(spot: number, dso: number, markup = DEFAULT_MARKUP): number {
  return (spot + dso + markup) * VAT;
}

export function hourOf(key: HourKey): number {
  return Number(key.slice(11, 13));
}

export function dateOf(key: HourKey): string {
  return key.slice(0, 10);
}

export function formatHours(hours: number[]): string {
  const uniq = [...new Set(hours)].sort((a, b) => a - b);
  if (!uniq.length) return "";
  const groups: number[][] = [];
  for (const h of uniq) {
    const last = groups.at(-1);
    if (last && h === last[last.length - 1]! + 1) last.push(h);
    else groups.push([h]);
  }
  const parts = groups.map((g) => {
    const a = hh(g[0]!);
    return g.length === 1 ? a : `${a}–${hh(g[g.length - 1]!)}`;
  });
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function hh(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

function honesty(fraction: number): string {
  const pct = Math.round(fraction * 100);
  return `That treats about ${pct}% of the expensive-hour spike as movable, not heat or always-on load.`;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return quantile(s, 0.5);
}

function dsoAt(dso: Dso, hour: number): number {
  return dso[hour] ?? 0;
}

function priceAt(spot: number, dso: Dso, hour: number, markup: number): number {
  return retailPrice(spot, dsoAt(dso, hour), markup);
}

function roundDkk(n: number): number {
  return Math.round(n);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function emptyTrends(): Trends {
  return { days: 0, daily: [], weekly: [], annual: [] };
}

function averages(rows: { hour: number; kwh: number; price: number | null }[]): HourAvg[] {
  const acc = Array.from({ length: 24 }, () => ({ kwh: 0, price: 0, n: 0, pn: 0 }));
  for (const r of rows) {
    const a = acc[r.hour]!;
    a.kwh += r.kwh;
    a.n += 1;
    if (r.price !== null) {
      a.price += r.price;
      a.pn += 1;
    }
  }
  return acc.flatMap((a, hour) =>
    a.n ? [{ hour, kwh: round3(a.kwh / a.n), price: a.pn ? round3(a.price / a.pn) : null }] : [],
  );
}

/** Hour-of-day, weekday, and month from the 365-day hourly series. Missing hours stay absent. */
export function usageTrends(usage: HourPoint[], spots: SpotPoint[], dso: Dso, markup = DEFAULT_MARKUP): Trends {
  const spotMap = new Map(spots.map((s) => [s.key, s.spot]));
  const days = new Set<string>();
  const rows: { date: string; hour: number; kwh: number; price: number | null }[] = [];
  for (const u of usage) {
    days.add(dateOf(u.key));
    const spot = spotMap.get(u.key);
    rows.push({
      date: dateOf(u.key),
      hour: hourOf(u.key),
      kwh: u.kwh,
      price: spot === undefined ? null : priceAt(spot, dso, hourOf(u.key), markup),
    });
  }
  if (!rows.length) return emptyTrends();

  const weekly = [0, 1, 2, 3, 4, 5, 6]
    .map((weekday) => ({ weekday, daily: averages(rows.filter((r) => weekdayOf(r.date) === weekday)) }))
    .filter((w) => w.daily.length);

  const byMonth = new Map<string, { days: Set<string>; kwh: number; hourKwh: number[] }>();
  for (const r of rows) {
    const month = r.date.slice(0, 7);
    const m = byMonth.get(month) ?? { days: new Set<string>(), kwh: 0, hourKwh: Array.from({ length: 24 }, () => 0) };
    m.days.add(r.date);
    m.kwh += r.kwh;
    m.hourKwh[r.hour]! += r.kwh;
    byMonth.set(month, m);
  }
  const annual = [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, m]) => {
      let peakHour = 0;
      let peakKwh = -1;
      for (let h = 0; h < 24; h++) {
        const avg = m.hourKwh[h]! / m.days.size;
        if (avg > peakKwh) {
          peakKwh = avg;
          peakHour = h;
        }
      }
      return { month, days: m.days.size, kwh: round3(m.kwh), peakHour, peakKwh: round3(peakKwh) };
    });

  return { days: days.size, daily: averages(rows), weekly, annual };
}

export function yearSaving(
  usage: HourPoint[],
  spots: SpotPoint[],
  dso: Dso,
  opts: { markup?: number; fraction?: number } = {},
): YearResult {
  const markup = opts.markup ?? DEFAULT_MARKUP;
  const fraction = opts.fraction ?? DEFAULT_FRACTION;
  const spotMap = new Map(spots.map((s) => [s.key, s.spot]));
  const byDay = new Map<string, { kwh: number; price: number; hour: number }[]>();

  for (const u of usage) {
    const spot = spotMap.get(u.key);
    if (spot === undefined) continue;
    const hour = hourOf(u.key);
    const row = { kwh: u.kwh, price: priceAt(spot, dso, hour, markup), hour };
    const day = dateOf(u.key);
    const list = byDay.get(day);
    if (list) list.push(row);
    else byDay.set(day, [row]);
  }

  const trends = usageTrends(usage, spots, dso, markup);

  if (!byDay.size) {
    return {
      headline: "Last year's hourly series is missing; an empty range is missing data, not zero use.",
      dkk: 0,
      from: "",
      to: "",
      days: 0,
      scaled: false,
      fraction,
      trends,
    };
  }

  let raw = 0;
  const fromHits = new Map<number, number>();
  const toHits = new Map<number, number>();

  for (const rows of byDay.values()) {
    const prices = rows.map((r) => r.price).sort((a, b) => a - b);
    const cheapCut = quantile(prices, 0.25);
    const expCut = quantile(prices, 0.75);
    if (expCut <= cheapCut) continue;
    const baseline = median(rows.map((r) => r.kwh));
    const cheap = rows.filter((r) => r.price <= cheapCut);
    const expensive = rows.filter((r) => r.price >= expCut && r.kwh > baseline);
    if (!cheap.length || !expensive.length) continue;
    const cheapPrice = cheap.reduce((s, r) => s + r.price, 0) / cheap.length;
    for (const e of expensive) {
      const lump = (e.kwh - baseline) * fraction;
      const save = lump * (e.price - cheapPrice);
      if (save <= 0) continue;
      raw += save;
      fromHits.set(e.hour, (fromHits.get(e.hour) ?? 0) + save);
    }
    const dest = cheap.reduce((a, b) => (a.price <= b.price ? a : b));
    toHits.set(dest.hour, (toHits.get(dest.hour) ?? 0) + 1);
  }

  const days = byDay.size;
  const scaled = days < YEAR_DAYS;
  const dkk = roundDkk(scaled ? (raw * YEAR_DAYS) / days : raw);
  const fromHrs = topHours(fromHits);
  const toHrs = topHours(toHits);
  const from = formatHours(fromHrs);
  const to = formatHours(toHrs);
  const scaleNote = scaled ? ` (scaled from ${days} day${days === 1 ? "" : "s"})` : "";
  const move = from && to ? ` by moving usage from ${from} to ${to}` : "";
  const headline = `Last year you could have saved DKK ${dkk}${scaleNote}${move}. ${honesty(fraction)}`;
  return { headline, dkk, from, to, days, scaled, fraction, trends };
}

function topHours(hits: Map<number, number>): number[] {
  if (!hits.size) return [];
  const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1]);
  const cut = ranked[0]![1] * 0.5;
  return ranked.filter(([, w]) => w >= cut).map(([h]) => h);
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12)).getUTCDay();
}

/** Average hour-of-day kWh for `weekday` (0=Sun) over the series, or the last `n` of those dates. Missing hours stay absent. */
export function weekdayShape(usage: HourPoint[], weekday: number, n?: number): Map<number, number> {
  let dates = [...new Set(usage.map((u) => dateOf(u.key)))].filter((d) => weekdayOf(d) === weekday).sort();
  if (n !== undefined) dates = dates.slice(-n);
  const shape = new Map<number, number>();
  for (let h = 0; h < 24; h++) {
    const vals = dates
      .map((d) => usage.find((u) => u.key === `${d}T${String(h).padStart(2, "0")}`)?.kwh)
      .filter((v): v is number => v !== undefined);
    if (vals.length) shape.set(h, vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return shape;
}

function clockOn(key: HourKey, today: string): string {
  const clock = formatHours([hourOf(key)]);
  return dateOf(key) === today ? clock : `${clock} tomorrow`;
}

function emptyHorizon(unpublished: boolean, window: ShiftWindow, fraction: number, extra?: string): HorizonResult {
  const when = unpublished
    ? "Tomorrow's prices are not published yet (~13:00)."
    : window === "today"
      ? "The rest of today's prices are missing."
      : "The published price window is missing.";
  return {
    headline: `${when} ${extra ?? "An empty range is missing data, not zero use."}`,
    dkk: 0,
    from: "",
    to: "",
    fromKey: "",
    toKey: "",
    direction: null,
    window,
    unpublished,
    fraction,
    fromKwh: 0,
  };
}

/** Best from→to on the published remaining hours. `spots` must already be that window. */
export function horizonShift(
  usage: HourPoint[],
  spots: SpotPoint[],
  dso: Dso,
  opts: { today: string; markup?: number; fraction?: number; unpublished?: boolean },
): HorizonResult {
  const markup = opts.markup ?? DEFAULT_MARKUP;
  const fraction = opts.fraction ?? DEFAULT_FRACTION;
  const unpublished = opts.unpublished ?? false;
  const dates = new Set(spots.map((s) => dateOf(s.key)));
  const window: ShiftWindow = dates.size > 1 ? "horizon" : "today";

  if (!spots.length) return emptyHorizon(unpublished, window, fraction);

  const shapes = new Map<number, Map<number, number>>();
  const shapeOf = (date: string) => {
    const wd = weekdayOf(date);
    const cached = shapes.get(wd);
    if (cached) return cached;
    const built = weekdayShape(usage, wd);
    shapes.set(wd, built);
    return built;
  };

  const rows = spots.map((s) => ({
    key: s.key,
    price: priceAt(s.spot, dso, hourOf(s.key), markup),
    kwh: shapeOf(dateOf(s.key)).get(hourOf(s.key)),
  }));
  const loads = [...shapes.values()].flatMap((s) => [...s.values()]);
  if (!loads.length) return emptyHorizon(unpublished, window, fraction);
  const baseline = median(loads);

  let best = { y: 0, from: "", to: "", kwh: 0 };
  for (const from of rows) {
    if (from.kwh === undefined) continue;
    const movable = Math.max(0, from.kwh - baseline) * fraction;
    if (movable <= 0) continue;
    for (const to of rows) {
      if (to.key === from.key || to.price >= from.price) continue;
      const y = movable * (from.price - to.price);
      if (y > best.y) best = { y, from: from.key, to: to.key, kwh: movable };
    }
  }

  const wait = unpublished ? "Tomorrow's prices are not published yet (~13:00). " : "";
  const scope = window === "horizon" ? "From now through tomorrow you can save" : "For the rest of today you can save";

  if (!best.from || roundDkk(best.y) <= 0) {
    return {
      ...emptyHorizon(unpublished, window, fraction, `No useful shift in this window; prices are flat or the usual spike is already cheap.`),
      headline: `${wait}No useful shift ${window === "horizon" ? "from now through tomorrow" : "later today"}; prices are flat or the usual spike is already cheap.`,
    };
  }

  const direction: ShiftDirection = best.from < best.to ? "push_back" : "pull_forward";
  const from = clockOn(best.from, opts.today);
  const to = clockOn(best.to, opts.today);
  let move: string;
  switch (direction) {
    case "push_back":
      move = `pushing usage from ${from} back to ${to}`;
      break;
    case "pull_forward":
      move = `pulling usage from ${from} forward to ${to}`;
      break;
    default: {
      const _n: never = direction;
      throw new Error(String(_n));
    }
  }
  const dkk = roundDkk(best.y);
  return {
    headline: `${wait}${scope} DKK ${dkk} by ${move}. ${honesty(fraction)}`,
    dkk,
    from,
    to,
    fromKey: best.from,
    toKey: best.to,
    direction,
    window,
    unpublished,
    fraction,
    fromKwh: Math.round(best.kwh * 1000) / 1000,
  };
}
