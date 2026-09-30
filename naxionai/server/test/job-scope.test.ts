import { describe, expect, it } from "vitest";
import { runInJobScope, currentJobId } from "../src/lib/job-scope.js";

describe("job-scope", () => {
  it("is undefined outside any job scope", () => {
    expect(currentJobId()).toBeUndefined();
  });

  it("is visible inside runInJobScope", () => {
    runInJobScope("job-1", () => {
      expect(currentJobId()).toBe("job-1");
    });
  });

  it("carries across an async subtree, including awaited promises", async () => {
    const seen = await runInJobScope("job-2", async () => {
      await new Promise(r => setTimeout(r, 1));
      await Promise.resolve();
      return currentJobId();
    });
    expect(seen).toBe("job-2");
  });

  it("does not leak between concurrent scopes", async () => {
    const [a, b] = await Promise.all([
      runInJobScope("job-a", async () => { await new Promise(r => setTimeout(r, 5)); return currentJobId(); }),
      runInJobScope("job-b", async () => { await new Promise(r => setTimeout(r, 1)); return currentJobId(); }),
    ]);
    expect(a).toBe("job-a");
    expect(b).toBe("job-b");
  });

  it("restores the outer scope (undefined) after the callback returns", () => {
    runInJobScope("job-3", () => {});
    expect(currentJobId()).toBeUndefined();
  });

  it("nested scopes shadow the outer one and restore it on exit", () => {
    runInJobScope("outer", () => {
      expect(currentJobId()).toBe("outer");
      runInJobScope("inner", () => {
        expect(currentJobId()).toBe("inner");
      });
      expect(currentJobId()).toBe("outer");
    });
  });
});
