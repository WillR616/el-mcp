import { homedir } from "node:os";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_FORESIGHT, DEFAULT_FRACTION, DEFAULT_MARKUP, type Dso, type HourPoint } from "./analyze.ts";
import type { PriceArea } from "./prices.ts";

const API = "https://api.eloverblik.dk/customerapi/api";
const HOME = resolve(homedir(), ".el-mcp");
const CONSUMPTION = new Set(["E17", "D07", "D12"]);
const HEAT = new Set(["D14"]);

export type Meter = {
  id: string;
  typeOfMP: string;
  address: string;
  postcode: string;
  hasRelation: boolean;
  consumption: boolean;
  heat: boolean;
};

export type Config = {
  refreshToken: string;
  meter?: string;
  area?: PriceArea;
  markup: number;
  fraction: number;
  foresight: number;
};

type Kv = Record<string, string>;

let access: { token: string; exp: number } | undefined;

function parseKv(text: string): Kv {
  const out: Kv = {};
  const trimmed = text.trim();
  if (trimmed && !trimmed.includes("=") && trimmed.split(".").length === 3) {
    out.ELOVERBLIK_REFRESH_TOKEN = trimmed;
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function readFileKv(path: string): Kv {
  try {
    return existsSync(path) ? parseKv(readFileSync(path, "utf8")) : {};
  } catch {
    return {};
  }
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): Config {
  const file = readFileKv(HOME);
  const env = process.env;
  const refreshToken = (env.ELOVERBLIK_REFRESH_TOKEN ?? file.ELOVERBLIK_REFRESH_TOKEN ?? "").trim();
  const meter = (env.ELOVERBLIK_METER ?? file.ELOVERBLIK_METER)?.trim() || undefined;
  const areaRaw = (env.ELOVERBLIK_AREA ?? file.ELOVERBLIK_AREA)?.trim();
  const area = areaRaw === "DK1" || areaRaw === "DK2" ? areaRaw : undefined;
  return {
    refreshToken,
    meter,
    area,
    markup: envNum("EL_MCP_MARKUP", DEFAULT_MARKUP),
    fraction: envNum("EL_MCP_MOVE_FRACTION", DEFAULT_FRACTION),
    foresight: envNum("EL_MCP_FORESIGHT", DEFAULT_FORESIGHT),
  };
}

export function saveConfig(patch: Partial<Pick<Config, "refreshToken" | "meter" | "area">>): void {
  const cur = { ...readFileKv(HOME) };
  if (patch.refreshToken !== undefined) cur.ELOVERBLIK_REFRESH_TOKEN = patch.refreshToken;
  if (patch.meter !== undefined) cur.ELOVERBLIK_METER = patch.meter;
  if (patch.area !== undefined) cur.ELOVERBLIK_AREA = patch.area;
  mkdirSync(homedir(), { recursive: true });
  writeFileSync(
    HOME,
    Object.entries(cur)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
    { encoding: "utf8" },
  );
  chmodSync(HOME, 0o600);
}

export function hasToken(): boolean {
  return Boolean(loadConfig().refreshToken);
}

async function api(path: string, init: RequestInit & { token: string }): Promise<unknown> {
  const { token, ...rest } = init;
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...rest.headers,
    },
  });
  if (res.status === 401) throw new Error("Eloverblik token rejected");
  if (!res.ok) throw new Error(`Eloverblik ${res.status}`);
  return res.json();
}

export async function accessToken(): Promise<string> {
  if (access && access.exp > Date.now() + 60_000) return access.token;
  const refresh = loadConfig().refreshToken;
  if (!refresh) throw new Error("No Eloverblik refresh token. Put it in ~/.el-mcp or ELOVERBLIK_REFRESH_TOKEN.");
  const json = (await api("/token", { token: refresh })) as { result?: string };
  const token = json.result;
  if (!token) throw new Error("Eloverblik did not return an access token");
  access = { token, exp: Date.now() + 23 * 3600_000 };
  return token;
}

function body(ids: string[]): string {
  return JSON.stringify({ meteringPoints: { meteringPoint: ids } });
}

function addr(m: { streetName?: string; buildingNumber?: string; postcode?: string; cityName?: string }): string {
  return [m.streetName, m.buildingNumber, [m.postcode, m.cityName].filter(Boolean).join(" ")].filter(Boolean).join(" ");
}

function asMeters(raw: unknown): Meter[] {
  const root = raw as { result?: unknown };
  const list = Array.isArray(root.result)
    ? root.result
    : Array.isArray((root.result as { meteringPoints?: unknown })?.meteringPoints)
      ? (root.result as { meteringPoints: unknown[] }).meteringPoints
      : Array.isArray(raw)
        ? raw
        : [];
  return list.map((row) => {
    const r = row as {
      meteringPointId?: string;
      typeOfMP?: string;
      postcode?: string;
      cityName?: string;
      streetName?: string;
      buildingNumber?: string;
      hasRelation?: boolean;
    };
    const typeOfMP = r.typeOfMP ?? "";
    return {
      id: r.meteringPointId ?? "",
      typeOfMP,
      address: addr(r),
      postcode: r.postcode ?? "",
      hasRelation: Boolean(r.hasRelation),
      consumption: CONSUMPTION.has(typeOfMP),
      heat: HEAT.has(typeOfMP),
    };
  });
}

export async function listMeters(): Promise<Meter[]> {
  const token = await accessToken();
  return asMeters(await api("/meteringpoints/meteringpoints?includeAll=true", { token }));
}

export function inferArea(postcode: string): PriceArea {
  const n = Number(postcode);
  return Number.isFinite(n) && n >= 1000 && n <= 4999 ? "DK2" : "DK1";
}

export async function meterDetails(id: string): Promise<{ postcode: string; typeOfMP: string; address: string }> {
  const token = await accessToken();
  const json = (await api("/meteringpoints/meteringpoint/getdetails", { method: "POST", token, body: body([id]) })) as {
    result?: { result?: { postcode?: string; typeOfMP?: string; streetName?: string; buildingNumber?: string; cityName?: string }; postcode?: string; typeOfMP?: string }[];
  };
  const row = json.result?.[0];
  const r = row?.result ?? row;
  return { postcode: r?.postcode ?? "", typeOfMP: r?.typeOfMP ?? "", address: r ? addr(r) : "" };
}

function validOn(from?: string | null, to?: string | null, now = Date.now()): boolean {
  if (from && Date.parse(from) > now) return false;
  if (to && Date.parse(to) <= now) return false;
  return true;
}

type Tariff = { validFromDate?: string; validToDate?: string; periodType?: string; prices?: { position?: string; price?: number }[] };

export function parseCharges(raw: unknown): Dso {
  const dso = Array.from({ length: 24 }, () => 0);
  const root = raw as { result?: { result?: { tariffs?: Tariff[] }; tariffs?: Tariff[] }[]; tariffs?: Tariff[] };
  const tariffs = root.result?.[0]?.result?.tariffs ?? root.result?.[0]?.tariffs ?? root.tariffs ?? [];
  for (const t of tariffs) {
    if (!validOn(t.validFromDate, t.validToDate)) continue;
    const prices = t.prices ?? [];
    const hourly = /hour/i.test(t.periodType ?? "") || prices.length >= 24;
    if (!hourly && prices.length <= 1) {
      const p = prices[0]?.price ?? 0;
      for (let h = 0; h < 24; h++) dso[h]! += p;
      continue;
    }
    if (prices.length > 24) {
      for (const px of prices) {
        const pos = Number(px.position ?? 0);
        if (!pos || typeof px.price !== "number") continue;
        dso[Math.floor((pos - 1) / 4)]! += px.price / 4;
      }
      continue;
    }
    for (const px of prices) {
      const pos = Number(px.position ?? 0);
      if (!pos || typeof px.price !== "number") continue;
      dso[pos - 1]! += px.price;
    }
  }
  return dso;
}

export async function getCharges(id: string): Promise<Dso> {
  const token = await accessToken();
  return parseCharges(await api("/meteringpoints/meteringpoint/getcharges", { method: "POST", token, body: body([id]) }));
}

function qtyOf(p: Record<string, unknown>): number | undefined {
  const q = p["out_Quantity.quantity"] ?? (p.out_Quantity as { quantity?: unknown } | undefined)?.quantity;
  if (q === undefined || q === null || q === "") return undefined;
  const n = Number(q);
  return Number.isFinite(n) ? n : undefined;
}

function qualityOf(p: Record<string, unknown>): string {
  return String(p["out_Quantity.quality"] ?? (p.out_Quantity as { quality?: unknown } | undefined)?.quality ?? "");
}

function addHour(map: Map<string, number>, startUtc: Date, offsetHours: number, kwh: number): void {
  const t = new Date(startUtc.getTime() + offsetHours * 3600_000);
  const local = t.toLocaleString("sv-SE", { timeZone: "Europe/Copenhagen" });
  const key = `${local.slice(0, 10)}T${local.slice(11, 13)}`;
  map.set(key, (map.get(key) ?? 0) + kwh);
}

export function parseTimeseries(raw: unknown): HourPoint[] {
  const root = raw as {
    result?: {
      MyEnergyData_MarketDocument?: {
        TimeSeries?: {
          businessType?: string;
          Period?: { resolution?: string; timeInterval?: { start?: string }; Point?: Record<string, unknown>[] }[];
        }[];
      };
    }[];
  };
  const map = new Map<string, number>();
  for (const doc of root.result ?? []) {
    for (const ts of doc.MyEnergyData_MarketDocument?.TimeSeries ?? []) {
      if (ts.businessType === "A01") continue;
      for (const period of ts.Period ?? []) {
        if (!period.timeInterval?.start) continue;
        const start = new Date(period.timeInterval.start);
        const res = period.resolution ?? "PT1H";
        for (const p of period.Point ?? []) {
          if (qualityOf(p) === "A02") continue;
          const qty = qtyOf(p);
          if (qty === undefined) continue;
          const pos = Number(p.position ?? 0);
          if (!pos) continue;
          if (res === "PT15M") addHour(map, start, (pos - 1) / 4, qty);
          else addHour(map, start, pos - 1, qty);
        }
      }
    }
  }
  return [...map].map(([key, kwh]) => ({ key, kwh })).sort((a, b) => (a.key < b.key ? -1 : 1));
}

function ymd(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Copenhagen" });
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

export async function hourlyImport(id: string, from: Date, to: Date): Promise<HourPoint[]> {
  const token = await accessToken();
  const chunks: HourPoint[] = [];
  let cursor = from;
  while (cursor < to) {
    const next = addDays(cursor, 180);
    const end = next < to ? next : to;
    const dateFrom = ymd(cursor);
    const dateTo = ymd(end);
    if (dateFrom === dateTo) break;
    const json = await api(`/meterdata/gettimeseries/${dateFrom}/${dateTo}/Hour`, {
      method: "POST",
      token,
      body: body([id]),
    });
    chunks.push(...parseTimeseries(json));
    cursor = end;
  }
  return chunks;
}

export function consumptionMeters(meters: Meter[]): Meter[] {
  return meters.filter((m) => m.consumption && !m.heat);
}

export async function resolveMeter(): Promise<{ meter: Meter; area: PriceArea }> {
  const cfg = loadConfig();
  const meters = await listMeters();
  const chosen = cfg.meter
    ? meters.find((m) => m.id === cfg.meter)
    : consumptionMeters(meters).length === 1
      ? consumptionMeters(meters)[0]
      : undefined;
  if (!chosen) throw new Error("No consumption meter selected. Call pick_meter.");
  if (!chosen.hasRelation) throw new Error("This meter is not linked in Eloverblik yet.");
  let area = cfg.area;
  if (!area) {
    const details = await meterDetails(chosen.id);
    area = inferArea(details.postcode || chosen.postcode);
    saveConfig({ meter: chosen.id, area });
  }
  return { meter: chosen, area };
}
