// Regression test for the on-disk TTS cache ported from naxionai/backend/
// api/voice.py's _tts_cache_key/_tts_cache_load/_tts_cache_store — same
// sha256(text|voice|tier) key shape, same <hash>.<ext> file naming.

import { describe, expect, it, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ttsCacheKey, ttsCacheLoad, ttsCacheStore, TTS_CACHE_DIR } from "../src/lib/voice.js";

function cleanupKey(key: string) {
  for (const ext of ["mp3", "wav"]) {
    const p = join(TTS_CACHE_DIR, `${key}.${ext}`);
    if (existsSync(p)) rmSync(p);
  }
}

describe("ttsCacheKey", () => {
  it("is deterministic for the same text/voice/tier", () => {
    expect(ttsCacheKey("hello world", "nova", "openai")).toBe(ttsCacheKey("hello world", "nova", "openai"));
  });

  it("differs when the tier differs, even with identical text/voice", () => {
    expect(ttsCacheKey("hello world", "nova", "openai")).not.toBe(ttsCacheKey("hello world", "nova", "local"));
  });

  it("differs when the voice differs", () => {
    expect(ttsCacheKey("hello world", "nova", "openai")).not.toBe(ttsCacheKey("hello world", "onyx", "openai"));
  });

  it("differs when the text differs", () => {
    expect(ttsCacheKey("hello world", "nova", "openai")).not.toBe(ttsCacheKey("goodbye world", "nova", "openai"));
  });
});

describe("ttsCacheStore / ttsCacheLoad", () => {
  afterEach(() => {
    cleanupKey(ttsCacheKey("cache round trip", "nova", "openai"));
    cleanupKey(ttsCacheKey("unsupported content type", "nova", "openai"));
  });

  it("round-trips audio bytes and content type through disk", () => {
    const key = ttsCacheKey("cache round trip", "nova", "openai");
    expect(ttsCacheLoad(key)).toBeNull();
    const audio = Buffer.from([1, 2, 3, 4]);
    ttsCacheStore(key, audio, "audio/mpeg");
    const loaded = ttsCacheLoad(key);
    expect(loaded).not.toBeNull();
    expect(loaded!.contentType).toBe("audio/mpeg");
    expect(Buffer.compare(loaded!.audio, audio)).toBe(0);
  });

  it("silently skips storing an unrecognised content type", () => {
    const key = ttsCacheKey("unsupported content type", "nova", "openai");
    ttsCacheStore(key, Buffer.from([1]), "audio/ogg");
    expect(ttsCacheLoad(key)).toBeNull();
  });
});
