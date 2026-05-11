import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Weather Skill ─────────────────────────────────────────────────
// Get weather forecasts using Open-Meteo (free, no API key).
// Geocodes location names, then fetches current + daily forecast.

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const WeatherParams = z.object({
  location: z.string().describe("Location name (city, address, or place name)"),
  days: z
    .number()
    .int()
    .min(1)
    .max(7)
    .default(3)
    .describe("Number of forecast days (default 3, max 7)"),
});

interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  country: string;
  admin1?: string;
}

interface GeoResponse {
  results?: GeoResult[];
}

// WMO weather code descriptions
const WMO_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Foggy",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snowfall",
  73: "Moderate snowfall",
  75: "Heavy snowfall",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

function describeWeatherCode(code: number): string {
  return WMO_CODES[code] ?? `Unknown (code ${code})`;
}

const weatherSkill: SkillDefinition = {
  name: "weather",
  version: "1.0.0",

  manifest: {
    id: "weather",
    name: "Weather",
    description:
      "Get current weather and daily forecasts for any location. Uses Open-Meteo (free, no API key needed).",
    category: "search",
    tools: ["weather"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "weather",
      description:
        "Get current weather and daily forecast for a location. Returns temperature, conditions, and daily highs/lows.",
      parameters: WeatherParams,

      async execute(params) {
        // Step 1: Geocode the location name
        const geoUrl = `${GEOCODING_URL}?name=${encodeURIComponent(params.location)}&count=1&language=en&format=json`;
        const geoResponse = await safeFetch(geoUrl, {
          ssrfProtection: false,
        });

        if (!geoResponse.ok) {
          return {
            error: `Geocoding failed: ${geoResponse.status} ${geoResponse.statusText}`,
          };
        }

        const geoData = (await geoResponse.json()) as GeoResponse;
        const place = geoData.results?.[0];

        if (!place) {
          return {
            error: `Could not find location: "${params.location}". Try a more specific name.`,
          };
        }

        // Step 2: Fetch weather forecast
        const forecastUrl = new URL(FORECAST_URL);
        forecastUrl.searchParams.set("latitude", String(place.latitude));
        forecastUrl.searchParams.set("longitude", String(place.longitude));
        forecastUrl.searchParams.set(
          "current",
          "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m",
        );
        forecastUrl.searchParams.set(
          "daily",
          "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
        );
        forecastUrl.searchParams.set("forecast_days", String(params.days));
        forecastUrl.searchParams.set("timezone", "auto");

        const forecastResponse = await safeFetch(forecastUrl.toString(), {
          ssrfProtection: false,
        });

        if (!forecastResponse.ok) {
          return {
            error: `Forecast API failed: ${forecastResponse.status} ${forecastResponse.statusText}`,
          };
        }

        const forecast = (await forecastResponse.json()) as {
          current: {
            temperature_2m: number;
            relative_humidity_2m: number;
            apparent_temperature: number;
            weather_code: number;
            wind_speed_10m: number;
            wind_direction_10m: number;
          };
          current_units: {
            temperature_2m: string;
            wind_speed_10m: string;
          };
          daily: {
            time: string[];
            weather_code: number[];
            temperature_2m_max: number[];
            temperature_2m_min: number[];
            precipitation_sum: number[];
            wind_speed_10m_max: number[];
          };
          daily_units: {
            temperature_2m_max: string;
            precipitation_sum: string;
            wind_speed_10m_max: string;
          };
        };

        const current = forecast.current;
        const daily = forecast.daily;

        return {
          location: {
            name: place.name,
            region: place.admin1 ?? "",
            country: place.country,
            latitude: place.latitude,
            longitude: place.longitude,
          },
          current: {
            temperature: `${current.temperature_2m}${forecast.current_units.temperature_2m}`,
            feelsLike: `${current.apparent_temperature}${forecast.current_units.temperature_2m}`,
            humidity: `${current.relative_humidity_2m}%`,
            conditions: describeWeatherCode(current.weather_code),
            wind: `${current.wind_speed_10m} ${forecast.current_units.wind_speed_10m} from ${current.wind_direction_10m}°`,
          },
          forecast: daily.time.map((date, i) => ({
            date,
            conditions: describeWeatherCode(daily.weather_code[i]),
            high: `${daily.temperature_2m_max[i]}${forecast.daily_units.temperature_2m_max}`,
            low: `${daily.temperature_2m_min[i]}${forecast.daily_units.temperature_2m_max}`,
            precipitation: `${daily.precipitation_sum[i]} ${forecast.daily_units.precipitation_sum}`,
            windMax: `${daily.wind_speed_10m_max[i]} ${forecast.daily_units.wind_speed_10m_max}`,
          })),
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "weather",
      instructions:
        "You can get weather forecasts using the `weather` tool. Provide a location name and optionally the number of forecast days (1-7, default 3). Returns current conditions and daily forecast.",
    };
  },
};

export default weatherSkill;
