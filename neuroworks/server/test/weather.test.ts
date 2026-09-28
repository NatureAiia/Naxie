// Weather provider fallback (see lib/host-tools.ts's getWeather): ported
// pattern from KimmyDeku/sebastian's weather.ts — try Google Weather when
// configured, swallow any failure, fall back to the always-free Open-Meteo
// path, and label the source honestly. Mocks global.fetch by URL so no real
// network call happens.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWeather } from "../src/lib/host-tools.js";

const OPEN_METEO_FORECAST = {
  current_weather: { temperature: 18, windspeed: 12, weathercode: 1, time: "2026-01-05T12:00" },
  hourly: { relativehumidity_2m: [55] },
  daily: { temperature_2m_max: [20], temperature_2m_min: [10] },
};

function mockFetch(opts: { googleOk?: boolean } = {}) {
  return vi.fn(async (url: string) => {
    if (url.includes("weather.googleapis.com")) {
      if (!opts.googleOk) throw new Error("network down");
      return {
        ok: true,
        json: async () => ({
          currentConditions: {
            temperature: { degrees: 21 }, wind: { speed: { value: 8 } },
            currentTime: "2026-01-05T12:00:00Z", relativeHumidity: 60,
            weatherCondition: { description: { text: "Sunny" } },
          },
        }),
      } as any;
    }
    if (url.includes("geocoding-api")) return { ok: true, json: async () => ({ results: [] }) } as any;
    if (url.includes("api.open-meteo.com")) return { ok: true, json: async () => OPEN_METEO_FORECAST } as any;
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("getWeather provider fallback", () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.NEUROWORKS_GOOGLE_WEATHER_API_KEY;

  beforeEach(() => { delete process.env.NEUROWORKS_GOOGLE_WEATHER_API_KEY; });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NEUROWORKS_GOOGLE_WEATHER_API_KEY;
    else process.env.NEUROWORKS_GOOGLE_WEATHER_API_KEY = originalKey;
  });

  it("behaves exactly as before (Open-Meteo only) when no Google key is set", async () => {
    global.fetch = mockFetch() as any;
    const out = await getWeather("auto");
    expect(out).toContain("Source: Open-Meteo");
    expect(out).not.toContain("Google Weather");
  });

  it("prefers Google Weather when configured and reachable", async () => {
    process.env.NEUROWORKS_GOOGLE_WEATHER_API_KEY = "test-key";
    global.fetch = mockFetch({ googleOk: true }) as any;
    const out = await getWeather("auto");
    expect(out).toContain("Source: Google Weather");
    expect(out).toContain("Sunny");
  });

  it("falls back to Open-Meteo silently when Google Weather fails", async () => {
    process.env.NEUROWORKS_GOOGLE_WEATHER_API_KEY = "test-key";
    global.fetch = mockFetch({ googleOk: false }) as any;
    const out = await getWeather("auto");
    expect(out).toContain("Source: Open-Meteo");
  });
});
