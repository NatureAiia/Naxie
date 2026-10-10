// Model auto-pick guards (models.ts): embedding-only models are never chat
// candidates, oversized locals are capped out, explicit `must` bypasses both.
import { describe, expect, it, afterEach } from "vitest";
import {
  isEmbeddingModel,
  maxAutoGb,
  filterCandidates,
  type ModelInfo,
  type Capabilities,
} from "../src/lib/models.js";

const caps: Capabilities = { jsonStrict: 6, reasoning: 5, longForm: 6, speed: 6, cost: 5 };
const mk = (name: string, sizeGB?: number): ModelInfo => ({ name, family: "test", sizeGB, capabilities: caps });

describe("isEmbeddingModel", () => {
  it("flags embedders, spares chat models", () => {
    expect(isEmbeddingModel("nomic-embed-text:latest")).toBe(true);
    expect(isEmbeddingModel("mxbai-embed-large")).toBe(true);
    expect(isEmbeddingModel("qwen2.5:3b")).toBe(false);
    expect(isEmbeddingModel("gemma4:31b")).toBe(false);
  });
});

describe("maxAutoGb", () => {
  afterEach(() => { delete process.env.OLLAMA_MAX_AUTO_GB; });

  it("defaults to 13, honours env, 0 disables", () => {
    expect(maxAutoGb()).toBe(13);
    process.env.OLLAMA_MAX_AUTO_GB = "20";
    expect(maxAutoGb()).toBe(20);
    process.env.OLLAMA_MAX_AUTO_GB = "0";
    expect(maxAutoGb()).toBe(0);
  });
});

describe("filterCandidates", () => {
  const pool = [
    mk("qwen2.5:3b", 1.9),
    mk("nomic-embed-text:latest", 0.3),
    mk("muse-glimmer:latest", 18),
    mk("mistral-nemo:12b", 7.1),
    mk("deepseek-v4-flash:cloud", 0.1),
  ];

  it("drops embedders and giants, keeps chat models", () => {
    const names = filterCandidates(pool, {}, true).map((m) => m.name);
    expect(names).toContain("qwen2.5:3b");
    expect(names).toContain("mistral-nemo:12b");
    expect(names).not.toContain("nomic-embed-text:latest");
    expect(names).not.toContain("muse-glimmer:latest");
    expect(names).not.toContain("deepseek-v4-flash:cloud");
  });

  it("explicit must bypasses both guards", () => {
    const names = filterCandidates(pool, { must: [/muse-glimmer/] }, true).map((m) => m.name);
    expect(names).toEqual(["muse-glimmer:latest"]);
  });

  it("unknown size is not capped (can't judge what we can't measure)", () => {
    const names = filterCandidates([mk("mystery:model")], {}, true).map((m) => m.name);
    expect(names).toEqual(["mystery:model"]);
  });
});
