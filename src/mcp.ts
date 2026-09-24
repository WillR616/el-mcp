import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { horizonShift, yearSaving, type Dso, type HourPoint, type SpotPoint } from "./analyze.ts";
import {
  consumptionMeters,
  getCharges,
  hasToken,
  hourlyImport,
  inferArea,
  listMeters,
  loadConfig,
  meterDetails,
  resolveMeter,
  saveConfig,
  type Config,
  type Meter,
} from "./eloverblik.ts";
import { fetchSpots, isDayPublished, remainingHorizon, type PriceArea } from "./prices.ts";
import { addDate as shiftDate, lastCompleteRange, sliceUsage, type UsageGrain } from "./usage.ts";

export const VERSION = "0.1.0";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

function cphDate(d = new Date()): string {
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Copenhagen" });
}

function cphHour(d = new Date()): number {
  return Number(d.toLocaleString("sv-SE", { timeZone: "Europe/Copenhagen" }).slice(11, 13));
}

function addDate(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days, 12)).toISOString().slice(0, 10);
}

function atNoon(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12));
}

type YearWindow = {
  cfg: Config;
  meter: Meter;
  area: PriceArea;
  today: string;
  usage: HourPoint[];
  spots: SpotPoint[];
  dso: Dso;
};
let yearCache: { key: string; exp: number; data: YearWindow } | undefined;

async function loadYear(): Promise<YearWindow> {
  const cfg = loadConfig();
  const { meter, area } = await resolveMeter();
  const today = cphDate();
  const from = atNoon(addDate(today, -365));
  const key = `${meter.id}:${today}`;
  if (yearCache && yearCache.key === key && yearCache.exp > Date.now()) return yearCache.data;
  const [usage, spots, dso] = await Promise.all([
    hourlyImport(meter.id, from, atNoon(today)),
    fetchSpots(area, from, atNoon(addDate(today, 3))),
    getCharges(meter.id),
  ]);
  const data = { cfg, meter, area, today, usage, spots, dso };
  yearCache = { key, exp: Date.now() + 10 * 60_000, data };
  return data;
}

function guard<A extends unknown[]>(fn: (...args: A) => Promise<ReturnType<typeof json> | ReturnType<typeof fail>>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      return fail((err as Error).message);
    }
  };
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "el-mcp", version: VERSION },
    {
      instructions: [
        "365 hourly days. Daily, weekly and annual shapes are the insight; the two headlines are the kroner.",
        "Now: published window only — rest of today before ~13:00; rest of today plus tomorrow after day-ahead. Never invent hours past the feed.",
        "Say push back or pull forward. Heat and baseload stay put. Empty range is missing data, not zero use.",
        "usage is actual kWh for a short range when asked. It is not the tonight move.",
        "Never mention price area, DSO, tariff, VAT, or weather you do not have.",
      ].join(" "),
    },
  );

  server.registerTool(
    "setup",
    {
      title: "Check token",
      description: "Exchange the Eloverblik refresh token and list meters. Does not print the token.",
    },
    guard(async () => {
      if (!hasToken()) {
        return fail(
          "No refresh token. In Eloverblik: Profil → Datadeling → create a token. Put it in ~/.el-mcp as ELOVERBLIK_REFRESH_TOKEN=... or in .env.",
        );
      }
      const cfg = loadConfig();
      const meters = await listMeters();
      return json({
        token: "ok",
        selected: cfg.meter ?? null,
        meters: meters.map((m) => ({
          id: m.id,
          type: m.typeOfMP,
          address: m.address,
          linked: m.hasRelation,
          consumption: m.consumption,
          heat: m.heat,
          selected: m.id === cfg.meter,
        })),
      });
    }),
  );

  server.registerTool(
    "pick_meter",
    {
      title: "Pick consumption meter",
      description: "Choose the import meter used for both sentences. Infers the price area once and never names it.",
      inputSchema: { id: z.string().optional().describe("18-digit metering point. Omit if there is only one consumption meter.") },
    },
    guard(async ({ id }) => {
      const meters = consumptionMeters(await listMeters());
      const chosen = id ? meters.find((m) => m.id === id) : meters.length === 1 ? meters[0] : undefined;
      if (!chosen) {
        return json({
          need: "id",
          meters: meters.map((m) => ({ id: m.id, type: m.typeOfMP, address: m.address, linked: m.hasRelation })),
        });
      }
      const details = await meterDetails(chosen.id);
      const area: PriceArea = inferArea(details.postcode || chosen.postcode);
      saveConfig({ meter: chosen.id, area });
      return json({ id: chosen.id, address: details.address || chosen.address, linked: chosen.hasRelation });
    }),
  );

  server.registerTool(
    "year_saving",
    {
      title: "Year saving",
      description:
        "Last 365 hourly days: kroner from moving expensive-hour lumps, plus daily / weekly / annual trend tables. Not raw rows.",
    },
    guard(async () => {
      const { cfg, usage, spots, dso } = await loadYear();
      return json(yearSaving(usage, spots, dso, { markup: cfg.markup, fraction: cfg.fraction, foresight: cfg.foresight }));
    }),
  );

  server.registerTool(
    "usage",
    {
      title: "Actual usage",
      description:
        "Metered kWh for a short inclusive date range. Day grain by default; hour for at most 14 days. Not the tonight move, and not a year dump. Missing hours are absent, not zero.",
      inputSchema: {
        from: z.string().optional().describe("Inclusive start YYYY-MM-DD. Default: 7 complete days before the last metered day."),
        to: z.string().optional().describe("Inclusive end YYYY-MM-DD. Default: last complete metered day."),
        grain: z.enum(["day", "hour"]).optional().describe("day (default) or hour."),
      },
    },
    guard(async ({ from, to, grain }) => {
      const { usage } = await loadYear();
      const def = lastCompleteRange(usage);
      const start = from ?? (to ? shiftDate(to, -6) : def.from);
      const end = to ?? def.to;
      const g: UsageGrain = grain ?? "day";
      return json(sliceUsage(usage, start, end, g));
    }),
  );

  server.registerTool(
    "tomorrow_shift",
    {
      title: "Horizon shift",
      description:
        "Best from→to on the published window, using the 365-day weekday shape. Kroner, named hours, push_back or pull_forward.",
    },
    guard(async () => {
      const { cfg, today, usage, spots, dso } = await loadYear();
      const tomorrow = addDate(today, 1);
      const unpublished = !isDayPublished(spots, tomorrow);
      return json(
        horizonShift(usage, remainingHorizon(spots, today, tomorrow, cphHour(), unpublished), dso, {
          today,
          markup: cfg.markup,
          fraction: cfg.fraction,
          foresight: cfg.foresight,
          unpublished,
        }),
      );
    }),
  );

  server.registerPrompt(
    "savings",
    {
      title: "Two sentences",
      description: "Past-year saving and the move in the published price window, written as routines not a tariff lecture.",
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Give me the two el-mcp headlines, then detailed insight from the 365-day hourly series.",
              "",
              "1. setup if the token is unchecked. pick_meter if no consumption meter is selected.",
              "2. year_saving and tomorrow_shift. Both use the past 365 hourly days. Quote the headlines. Do not dump raw hours.",
              "3. Read year_saving.trends: daily (hour-of-day), weekly (0=Sun), annual (YYYY-MM). That is the insight.",
              "4. usage only when asked what the meter actually did on a day or over a range. It is kWh, not the tonight move, and not a way to rebuild the year. Hour grain is at most 14 days. Empty hours are missing data, not zero use.",
              "",
              "Window (this is the data, not a vibe):",
              "- Day-ahead is one auction. Before ~13:00 Copenhagen, tomorrow is not out. Suggest only on the rest of today (~11–24h). Say that tomorrow is not published.",
              "- After publish, the window is the rest of today plus tomorrow (about 24–35h). Suggest across that whole strip. Do not pretend you can see Wednesday on a Monday afternoon.",
              "- Empty range is missing data, not zero use. Do not invent hours past the last published price.",
              "",
              "Move:",
              "- tomorrow_shift.direction is push_back (later) or pull_forward (earlier). Use that verb. Name the clocks.",
              "- fromKwh is the movable lump at the expensive hour — a fraction of the spike above weekday-typical baseload, not the whole house.",
              "- The kroner are already discounted (foresight, default 85%) because day-ahead forecasts are not perfect foresight. Quote that clause. EL_MCP_FORESIGHT changes it.",
              "- Heat, fridge, standby stay put. Dishwasher, laundry, EV, water tank, a delayed oven are the usual movers.",
              "",
              "Routines — only if the hours match; do not invent a lifestyle:",
              "- Morning (06:00–09:00): leaving-the-house load. Pull laundry/EV forward into this only if the cheap hour is actually here.",
              "- Evening (16:00–20:00): cooking and coming-home spike. Default is push back into late evening or overnight, not 'use less dinner'.",
              "- Night (22:00–06:00): the usual sink for push-back. Say overnight, not 'tomorrow morning', unless the clock is after 06:00.",
              "- Circadian: people are awake at the evening spike. A kroner saving that needs them up at 03:00 needs one honest clause.",
              "",
              "Trends from the 365 days — not weather:",
              "- Daily: name the usual peak hour and the cheap-price hour. Morning vs evening vs night.",
              "- Weekly: compare weekdays to Sat/Sun. Do not apply a Tuesday evening to a Saturday.",
              "- Annual: which months carry the evening lump (winter heat in the baseline, not movable). Summer peaks are shorter and more shiftable.",
              "- The tonight move must sit on those shapes. If the year peaks at 18:00 and tonight's from is 19:00, say it is the same evening pattern.",
              "",
              "No weather feed. Do not mention rain, wind, or temperature. Do not ask for an address.",
              "Do not mention price area, DSO, tariff or VAT. Kroner they can check.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  return server;
}
