import { describe, expect, it } from "vitest";
import { classifyCustomTemplate } from "../src/lib/template-classifier.js";

describe("template-classifier", () => {
  it("classifies based on persona-id prefix", () => {
    expect(classifyCustomTemplate({ id: "custom-software-engineer-fix-bug" })).toBe("Engineering");
    expect(classifyCustomTemplate({ id: "custom-researcher-explain-topic" })).toBe("Knowledge");
    expect(classifyCustomTemplate({ id: "custom-it-support-reset-password" })).toBe("Operations");
    expect(classifyCustomTemplate({ id: "custom-accountant-reconcile-books" })).toBe("Operations");
    expect(classifyCustomTemplate({ id: "custom-social-media-manager-schedule-post" })).toBe("Operations");
  });

  it("classifies based on keywords when no persona prefix", () => {
    expect(classifyCustomTemplate({ id: "custom-task-123", title: "Debug API issue", description: "Investigate backend endpoint" })).toBe("Engineering");
    expect(classifyCustomTemplate({ id: "custom-task-124", title: "Research market trends", description: "Deep dive analysis" })).toBe("Knowledge");
    expect(classifyCustomTemplate({ id: "custom-task-125", title: "Process invoice", description: "Reconciliation needed" })).toBe("Operations");
  });

  it("returns Custom for unclassifiable templates", () => {
    expect(classifyCustomTemplate({ id: "custom-misc-xyz", title: "Random thing", description: "Do something odd" })).toBe("Custom");
    expect(classifyCustomTemplate({ id: "custom-hello-world", title: "Hello", description: "World" })).toBe("Custom");
  });

  it("handles multi-word persona prefixes correctly", () => {
    expect(classifyCustomTemplate({ id: "custom-software-engineer-optimize-query" })).toBe("Engineering");
  });
});
