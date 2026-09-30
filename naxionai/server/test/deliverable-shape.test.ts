import { describe, expect, it } from "vitest";
import { detectFidelity, isShapeAmbiguous } from "../src/lib/deliverable-shape.js";

describe("detectFidelity", () => {
  it("detects an artifact request (deliver verb + file noun)", () => {
    expect(detectFidelity("send me all the candidates' CVs from my email")).toBe("artifact");
  });
  it("detects a full-text request", () => {
    expect(detectFidelity("give me the whole document, don't summarize")).toBe("full");
  });
  it("detects a summary request", () => {
    expect(detectFidelity("summarize the quarterly report")).toBe("summary");
  });
  it("returns undefined when nothing is stated", () => {
    expect(detectFidelity("what's the weather today")).toBeUndefined();
  });
  it("artifact outranks full when both are present", () => {
    expect(detectFidelity("send me the full document")).toBe("artifact");
  });
});

describe("isShapeAmbiguous", () => {
  it("is ambiguous for a bare file noun with no channel or fidelity", () => {
    expect(isShapeAmbiguous("get me the CVs")).toBe(true);
  });
  it("is not ambiguous once a channel is named", () => {
    expect(isShapeAmbiguous("send them here")).toBe(false);
  });
  it("is not ambiguous when fidelity is already stated", () => {
    expect(isShapeAmbiguous("summarize the CVs")).toBe(false);
  });
  it("is not ambiguous when there's no file noun at all", () => {
    expect(isShapeAmbiguous("what's the capital of Zimbabwe")).toBe(false);
  });
});
