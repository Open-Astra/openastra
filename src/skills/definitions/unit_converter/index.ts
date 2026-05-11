import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Unit Converter Skill ─────────────────────────────────────────
// Pure local computation — converts between common units for
// length, weight, temperature, volume, speed, data, and time.

const UnitConverterParams = z.object({
  value: z.number().describe("Numeric value to convert"),
  fromUnit: z.string().describe("Source unit (e.g. 'meters', 'kg', 'celsius', 'GB')"),
  toUnit: z.string().describe("Target unit (e.g. 'feet', 'lbs', 'fahrenheit', 'MB')"),
  category: z
    .enum(["length", "weight", "temperature", "volume", "speed", "data", "time"])
    .optional()
    .describe("Unit category (auto-detected if omitted)"),
});

// Conversion tables: each unit maps to a base unit multiplier
// To convert A → B: value * (A_to_base) / (B_to_base)

type ConversionTable = Record<string, number>;

const LENGTH_BASE = "meters";
const LENGTH: ConversionTable = {
  meters: 1,
  m: 1,
  kilometers: 1000,
  km: 1000,
  centimeters: 0.01,
  cm: 0.01,
  millimeters: 0.001,
  mm: 0.001,
  feet: 0.3048,
  ft: 0.3048,
  inches: 0.0254,
  in: 0.0254,
  yards: 0.9144,
  yd: 0.9144,
  miles: 1609.344,
  mi: 1609.344,
  nautical_miles: 1852,
  nm: 1852,
};

const WEIGHT_BASE = "kilograms";
const WEIGHT: ConversionTable = {
  kilograms: 1,
  kg: 1,
  grams: 0.001,
  g: 0.001,
  milligrams: 0.000001,
  mg: 0.000001,
  pounds: 0.45359237,
  lbs: 0.45359237,
  lb: 0.45359237,
  ounces: 0.0283495231,
  oz: 0.0283495231,
  tons: 907.18474,
  metric_tons: 1000,
  stones: 6.35029318,
  st: 6.35029318,
};

const VOLUME_BASE = "liters";
const VOLUME: ConversionTable = {
  liters: 1,
  l: 1,
  milliliters: 0.001,
  ml: 0.001,
  gallons: 3.785411784,
  gal: 3.785411784,
  quarts: 0.946352946,
  qt: 0.946352946,
  pints: 0.473176473,
  pt: 0.473176473,
  cups: 0.236588236,
  fluid_ounces: 0.0295735296,
  fl_oz: 0.0295735296,
  tablespoons: 0.0147867648,
  tbsp: 0.0147867648,
  teaspoons: 0.00492892159,
  tsp: 0.00492892159,
};

const SPEED_BASE = "meters_per_second";
const SPEED: ConversionTable = {
  meters_per_second: 1,
  "m/s": 1,
  mps: 1,
  kilometers_per_hour: 0.277778,
  kph: 0.277778,
  "km/h": 0.277778,
  kmh: 0.277778,
  miles_per_hour: 0.44704,
  mph: 0.44704,
  knots: 0.514444,
  kn: 0.514444,
  feet_per_second: 0.3048,
  "ft/s": 0.3048,
  fps: 0.3048,
};

const DATA_BASE = "bytes";
const DATA: ConversionTable = {
  bytes: 1,
  b: 1,
  kilobytes: 1024,
  kb: 1024,
  megabytes: 1024 ** 2,
  mb: 1024 ** 2,
  gigabytes: 1024 ** 3,
  gb: 1024 ** 3,
  terabytes: 1024 ** 4,
  tb: 1024 ** 4,
  petabytes: 1024 ** 5,
  pb: 1024 ** 5,
  bits: 0.125,
  kilobits: 128,
  kbit: 128,
  megabits: 131072,
  mbit: 131072,
  gigabits: 134217728,
  gbit: 134217728,
};

const TIME_BASE = "seconds";
const TIME: ConversionTable = {
  seconds: 1,
  s: 1,
  sec: 1,
  milliseconds: 0.001,
  ms: 0.001,
  microseconds: 0.000001,
  us: 0.000001,
  nanoseconds: 0.000000001,
  ns: 0.000000001,
  minutes: 60,
  min: 60,
  hours: 3600,
  h: 3600,
  hr: 3600,
  days: 86400,
  d: 86400,
  weeks: 604800,
  w: 604800,
  months: 2629746,
  years: 31556952,
  yr: 31556952,
};

interface CategoryDef {
  name: string;
  base: string;
  table: ConversionTable;
}

const CATEGORIES: CategoryDef[] = [
  { name: "length", base: LENGTH_BASE, table: LENGTH },
  { name: "weight", base: WEIGHT_BASE, table: WEIGHT },
  { name: "volume", base: VOLUME_BASE, table: VOLUME },
  { name: "speed", base: SPEED_BASE, table: SPEED },
  { name: "data", base: DATA_BASE, table: DATA },
  { name: "time", base: TIME_BASE, table: TIME },
];

function normalizeUnit(unit: string): string {
  return unit.toLowerCase().trim().replace(/\s+/g, "_");
}

function findCategory(
  fromUnit: string,
  toUnit: string,
  hint?: string,
): CategoryDef | undefined {
  const from = normalizeUnit(fromUnit);
  const to = normalizeUnit(toUnit);

  if (hint) {
    const cat = CATEGORIES.find((c) => c.name === hint);
    if (cat && from in cat.table && to in cat.table) return cat;
  }

  return CATEGORIES.find((c) => from in c.table && to in c.table);
}

function convertTemperature(
  value: number,
  from: string,
  to: string,
): number | null {
  const f = normalizeUnit(from);
  const t = normalizeUnit(to);

  // Normalize aliases
  const tempMap: Record<string, string> = {
    celsius: "c", c: "c",
    fahrenheit: "f", f: "f",
    kelvin: "k", k: "k",
  };

  const fKey = tempMap[f];
  const tKey = tempMap[t];
  if (!fKey || !tKey) return null;
  if (fKey === tKey) return value;

  // Convert to Celsius first
  let celsius: number;
  switch (fKey) {
    case "c": celsius = value; break;
    case "f": celsius = (value - 32) * (5 / 9); break;
    case "k": celsius = value - 273.15; break;
    default: return null;
  }

  // Convert from Celsius to target
  switch (tKey) {
    case "c": return celsius;
    case "f": return celsius * (9 / 5) + 32;
    case "k": return celsius + 273.15;
    default: return null;
  }
}

function isTemperatureUnit(unit: string): boolean {
  const temps = ["celsius", "c", "fahrenheit", "f", "kelvin", "k"];
  return temps.includes(normalizeUnit(unit));
}

const unitConverterSkill: SkillDefinition = {
  name: "unit_converter",
  version: "1.0.0",

  manifest: {
    id: "unit_converter",
    name: "Unit Converter",
    description:
      "Converts between common units for length, weight, temperature, volume, speed, data size, and time. Pure local computation.",
    category: "transform",
    tools: ["unit_converter"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "unit_converter",
      description:
        "Convert between units. Supports length (m/ft/in/km/mi), weight (kg/lbs/oz), temperature (C/F/K), volume (L/gal), speed (mph/kph), data (bytes/KB/MB/GB/TB), and time (s/min/h/d).",
      parameters: UnitConverterParams,

      async execute(params) {
        const { value, fromUnit, toUnit, category } = params;

        // Handle temperature separately (non-linear conversions)
        if (
          category === "temperature" ||
          (isTemperatureUnit(fromUnit) && isTemperatureUnit(toUnit))
        ) {
          const result = convertTemperature(value, fromUnit, toUnit);
          if (result === null) {
            return {
              error: `Unrecognized temperature units: ${fromUnit} → ${toUnit}. Supported: celsius/c, fahrenheit/f, kelvin/k.`,
            };
          }
          return {
            value,
            fromUnit,
            toUnit,
            category: "temperature",
            result: Math.round(result * 1e8) / 1e8,
          };
        }

        // Linear conversions
        const cat = findCategory(fromUnit, toUnit, category);
        if (!cat) {
          const from = normalizeUnit(fromUnit);
          const to = normalizeUnit(toUnit);

          // Check if units exist in different categories
          const fromCat = CATEGORIES.find((c) => from in c.table);
          const toCat = CATEGORIES.find((c) => to in c.table);

          if (fromCat && toCat && fromCat.name !== toCat.name) {
            return {
              error: `Cannot convert between different categories: ${fromUnit} (${fromCat.name}) → ${toUnit} (${toCat.name}).`,
            };
          }

          return {
            error: `Unrecognized unit pair: ${fromUnit} → ${toUnit}. Provide a category hint or check supported units.`,
            supportedCategories: CATEGORIES.map((c) => ({
              category: c.name,
              units: Object.keys(c.table),
            })),
          };
        }

        const from = normalizeUnit(fromUnit);
        const to = normalizeUnit(toUnit);
        const baseValue = value * cat.table[from];
        const result = baseValue / cat.table[to];

        return {
          value,
          fromUnit,
          toUnit,
          category: cat.name,
          result: Math.round(result * 1e8) / 1e8,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "unit_converter",
      instructions:
        "You can convert between units using the `unit_converter` tool. Supports length, weight, temperature, volume, speed, data size, and time conversions.",
    };
  },
};

export default unitConverterSkill;
