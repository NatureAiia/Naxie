// Naxie host tools — disk/process-free core only (resolveAppExecutable,
// knownAppNames, clampBrightnessPercent, resolveBrowserTarget). The settings
// store and the actual PowerShell/spawn-invoking functions aren't unit-tested
// here, consistent with this repo's convention (see governance.test.ts,
// org-tasks.test.ts) of testing pure decision logic, not file/process I/O.

import { describe, expect, it } from "vitest";
import {
  clampBrightnessPercent,
  knownAppNames,
  resolveAppExecutable,
  resolveBrowserTarget,
} from "../src/lib/host-tools.js";

describe("resolveAppExecutable", () => {
  it("resolves known aliases case-insensitively, with surrounding whitespace trimmed", () => {
    expect(resolveAppExecutable("Chrome")).toBe("chrome");
    expect(resolveAppExecutable("  notepad  ")).toBe("notepad.exe");
    expect(resolveAppExecutable("Microsoft Edge")).toBe("msedge");
  });

  it("returns null for anything not in the allowlist — never a free-form string reaching the shell", () => {
    expect(resolveAppExecutable("powershell")).toBeNull();
    expect(resolveAppExecutable("calc.exe & del C:\\important")).toBeNull();
    expect(resolveAppExecutable("")).toBeNull();
  });
});

describe("knownAppNames", () => {
  it("returns a deduped, sorted list of the actual allowlisted executables (not the aliases)", () => {
    const names = knownAppNames();
    expect(names).toContain("chrome");
    expect(names).toContain("notepad.exe");
    // "chrome" and "google chrome" are two aliases for the same exe — only one entry.
    expect(names.filter(n => n === "chrome")).toHaveLength(1);
    expect(names).toEqual([...names].sort());
  });
});

describe("clampBrightnessPercent", () => {
  it("accepts a clean integer, with or without a trailing %", () => {
    expect(clampBrightnessPercent("50")).toBe(50);
    expect(clampBrightnessPercent("50%")).toBe(50);
    expect(clampBrightnessPercent(" 0 ")).toBe(0);
  });

  it("clamps out-of-range values into 0-100", () => {
    expect(clampBrightnessPercent("150")).toBe(100);
  });

  it("rejects anything that isn't a clean integer — no silent partial-parse", () => {
    expect(clampBrightnessPercent("50abc")).toBeNull();
    expect(clampBrightnessPercent("abc")).toBeNull();
    expect(clampBrightnessPercent("")).toBeNull();
    expect(clampBrightnessPercent("-10")).toBeNull();
    expect(clampBrightnessPercent("3.5")).toBeNull();
  });
});

describe("resolveBrowserTarget", () => {
  it("passes an http(s) URL through unmodified", () => {
    expect(resolveBrowserTarget("https://example.com/page")).toBe("https://example.com/page");
    expect(resolveBrowserTarget("http://example.com")).toBe("http://example.com");
  });

  it("wraps plain text into a Google search query", () => {
    expect(resolveBrowserTarget("latest AI news")).toBe("https://www.google.com/search?q=latest%20AI%20news");
  });

  it("wraps anything shaped like a non-http(s) URI scheme into a search query instead of opening it directly", () => {
    expect(resolveBrowserTarget("file:///C:/secret.txt")).toContain("google.com/search?q=");
    expect(resolveBrowserTarget("javascript:alert(1)")).toContain("google.com/search?q=");
    expect(resolveBrowserTarget("ms-settings:privacy")).toContain("google.com/search?q=");
  });

  it("trims surrounding whitespace before deciding", () => {
    expect(resolveBrowserTarget("  https://example.com  ")).toBe("https://example.com");
  });
});
