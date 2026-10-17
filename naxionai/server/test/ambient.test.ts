import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emitAmbientEvent,
  getAmbientConfig,
  judgeRelevance,
  listAmbientEvents,
  updateAmbientConfig,
  clearAmbientEvents,
} from "../src/lib/ambient.js";
import { _resetForTests } from "../src/lib/scheduler-registry.js";

beforeEach(() => {
  process.env.NAXION_STATE_DIR = mkdtempSync(join(tmpdir(), "ambient-"));
  _resetForTests();
});

afterEach(() => {
  delete process.env.NAXION_STATE_DIR;
  _resetForTests();
});

describe("ambient config", () => {
  it("defaults to enabled with all sources on and email off", () => {
    const c = getAmbientConfig();
    expect(c.enabled).toBe(true);
    expect(Object.values(c.sources).every(Boolean)).toBe(true);
    expect(c.channels.email).toBe(false);
  });

  it("rejects an invalid emailTo", () => {
    expect(() => updateAmbientConfig({ emailTo: "not-an-address" })).toThrow();
  });

  it("toggles one source without touching the others", () => {
    const c = updateAmbientConfig({ sources: { ...getAmbientConfig().sources, github: false } });
    expect(c.sources.github).toBe(false);
    expect(c.sources.job).toBe(true);
  });
});

describe("ambient judge", () => {
  it("brings attention, files info", async () => {
    const att = await judgeRelevance({ id: "1", at: new Date().toISOString(), source: "job", title: "x", severity: "attention", notified: [] });
    expect(att.bring).toBe(true);
    const info = await judgeRelevance({ id: "2", at: new Date().toISOString(), source: "github", title: "y", severity: "info", notified: [] });
    expect(info.bring).toBe(false);
  });
});

describe("ambient emit", () => {
  it("records an event and dedupes by key within the window", async () => {
    const first = await emitAmbientEvent({ source: "job", title: "Job finished — t", severity: "info", dedupeKey: "job:abc" });
    expect(first).not.toBeNull();
    const second = await emitAmbientEvent({ source: "job", title: "Job finished — t", severity: "info", dedupeKey: "job:abc" });
    expect(second?.id).toBe(first?.id);
    expect(listAmbientEvents({}).length).toBe(1);
  });

  it("returns null when the source is disabled", async () => {
    updateAmbientConfig({ sources: { ...getAmbientConfig().sources, flow: false } });
    const ev = await emitAmbientEvent({ source: "flow", title: "Flow run failed", severity: "attention" });
    expect(ev).toBeNull();
  });

  it("clears the feed", async () => {
    await emitAmbientEvent({ source: "job", title: "hello", severity: "info" });
    expect(clearAmbientEvents().cleared).toBe(1);
    expect(listAmbientEvents({}).length).toBe(0);
  });
});
