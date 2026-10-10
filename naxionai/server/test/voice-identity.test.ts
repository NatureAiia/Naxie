// Voice identity rules (voice.ts): every persona resolves female; Naxie
// pins bf_emma (main) with af_heart for read-alouds. No audio needed.
import { describe, expect, it } from "vitest";
import { voiceForPersona } from "../src/lib/voice.js";

const MASCULINE = ["alloy", "ash", "ballad", "echo", "verse", "am_adam", "bm_george", "am_michael", "david"];

describe("female voices everywhere", () => {
  it("pins Naxie to bf_emma main", () => {
    expect(voiceForPersona("naxie").localVoice).toBe("bf_emma");
    expect(voiceForPersona("naxie-agent").localVoice).toBe("bf_emma");
  });

  it("never resolves a masculine voice for any persona", () => {
    for (const p of ["naxie", "researcher", "some-dude", "it-support", "procurement-officer", "HR Manager"]) {
      const v = voiceForPersona(p);
      for (const got of [v.openaiVoice, v.localVoice]) {
        expect(MASCULINE, `${p} -> ${got}`).not.toContain(got.toLowerCase());
      }
      expect(v.edgeVoice).toMatch(/libby/i);
    }
  });
});
