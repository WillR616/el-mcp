import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatHours, horizonShift, yearSaving, type Dso, type Trends } from "../src/analyze.ts";
import { fetchSpots, isDayPublished, remainingHorizon, type PriceArea } from "../src/prices.ts";
import { addDate, atNoon, cphDate, cphHour, expandPattern, type UsagePattern } from "../src/usage.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const areaFlag = args.indexOf("--area");
const area = (areaFlag >= 0 ? args[areaFlag + 1] : "DK1") as PriceArea;
if (area !== "DK1" && area !== "DK2") throw new Error("area must be DK1 or DK2");
const only = args.find((a, i) => !a.startsWith("--") && (areaFlag < 0 || i !== areaFlag + 1));

const today = cphDate();
const tomorrow = addDate(today, 1);
const from = addDate(today, -365);
const dso = JSON.parse(readFileSync(join(root, "fixtures/dso.json"), "utf8")) as Dso;

const files = readdirSync(join(root, "fixtures/usage"))
  .filter((f) => f.endsWith(".json") && (!only || f.startsWith(only)))
  .sort();
if (!files.length) throw new Error(`No usage fixture matching ${only ?? "*"}`);

process.stderr.write(`EDS ${area} ${from} → ${addDate(today, 3)}\n`);
const spots = await fetchSpots(area, atNoon(from), atNoon(addDate(today, 3)));
const unpublished = !isDayPublished(spots, tomorrow);
const horizon = remainingHorizon(spots, today, tomorrow, cphHour(), unpublished);

console.log(
  [
    `area=${area}  now=${today}T${String(cphHour()).padStart(2, "0")}`,
    `forward=${horizon.length}h  tomorrow=${unpublished ? "not published" : "out"}`,
    `spots=${spots.length}h`,
    "",
  ].join("\n"),
);

for (const file of files) {
  const pattern = JSON.parse(readFileSync(join(root, "fixtures/usage", file), "utf8")) as UsagePattern;
  const usage = expandPattern(pattern, from, today);
  const year = yearSaving(usage, spots, dso);
  const shift = horizonShift(usage, horizon, dso, { today, unpublished });
  console.log(`## ${pattern.name}  (${file})`);
  console.log(`PAST  ${year.headline}`);
  console.log(formatTrends(year.trends));
  console.log(`NOW   ${shift.headline}`);
  console.log(`      ${shift.direction ?? "none"}  window=${shift.window}  lump=${shift.fromKwh} kWh`);
  console.log("");
}

function formatTrends(t: Trends): string {
  if (!t.days) return "      trends  missing";
  const peak = t.daily.reduce((a, b) => (b.kwh > a.kwh ? b : a));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const week = t.weekly
    .map((w) => {
      const p = w.daily.reduce((a, b) => (b.kwh > a.kwh ? b : a));
      return `${days[w.weekday]} ${formatHours([p.hour])} ${p.kwh}`;
    })
    .join("  ");
  const months = t.annual.map((m) => `${m.month} ${formatHours([m.peakHour])} ${m.peakKwh}`).join("  ");
  return [
    `      daily  peak ${formatHours([peak.hour])} ${peak.kwh} kWh  days=${t.days}`,
    `      weekly ${week}`,
    `      annual ${months}`,
  ].join("\n");
}
