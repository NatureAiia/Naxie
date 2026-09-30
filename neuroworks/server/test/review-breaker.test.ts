import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewSkipReason, noteReviewSuccess, noteReviewTimeout, reviewBreakerState, resetReviewBreakers } from "../src/lib/review-breaker.js";

beforeEach(() => {
  resetReviewBreakers();
  delete process.env.NEUROWORKS_REVIEW_BREAKER_TRIP;
  delete process.env.NEUROWORKS_REVIEW_BREAKER_COOLDOWN_MS;
});

afterEach(() => { vi.useRealTimers(); });

describe("review-breaker", () => {
  it("never skips a healthy step", () => {
    expect(reviewSkipReason("quality.check")).toBeNull();
  });

  it("one or two timeouts alone do not trip the circuit", () => {
    noteReviewTimeout("quality.check");
    noteReviewTimeout("quality.check");
    expect(reviewSkipReason("quality.check")).toBeNull();
  });

  it("trips after the configured number of consecutive timeouts", () => {
    process.env.NEUROWORKS_REVIEW_BREAKER_TRIP = "3";
    noteReviewTimeout("quality.check");
    noteReviewTimeout("quality.check");
    noteReviewTimeout("quality.check");
    expect(reviewSkipReason("quality.check")).toMatch(/skipped/);
  });

  it("a success closes the circuit immediately", () => {
    process.env.NEUROWORKS_REVIEW_BREAKER_TRIP = "3";
    noteReviewTimeout("quality.check");
    noteReviewTimeout("quality.check");
    noteReviewTimeout("quality.check");
    expect(reviewSkipReason("quality.check")).not.toBeNull();
    noteReviewSuccess("quality.check");
    expect(reviewSkipReason("quality.check")).toBeNull();
  });

  it("breakers for different steps are independent", () => {
    process.env.NEUROWORKS_REVIEW_BREAKER_TRIP = "3";
    noteReviewTimeout("quality.check");
    noteReviewTimeout("quality.check");
    noteReviewTimeout("quality.check");
    expect(reviewSkipReason("quality.check")).not.toBeNull();
    expect(reviewSkipReason("peer.review")).toBeNull();
  });

  it("reopens (half-open) after the cooldown elapses", () => {
    vi.useFakeTimers();
    process.env.NEUROWORKS_REVIEW_BREAKER_TRIP = "3";
    process.env.NEUROWORKS_REVIEW_BREAKER_COOLDOWN_MS = "1000";
    noteReviewTimeout("quality.check");
    noteReviewTimeout("quality.check");
    noteReviewTimeout("quality.check");
    expect(reviewSkipReason("quality.check")).not.toBeNull();
    vi.advanceTimersByTime(1001);
    expect(reviewSkipReason("quality.check")).toBeNull();
  });

  it("reviewBreakerState reports open/closed and remaining cooldown", () => {
    process.env.NEUROWORKS_REVIEW_BREAKER_TRIP = "3";
    noteReviewTimeout("peer.review");
    noteReviewTimeout("peer.review");
    noteReviewTimeout("peer.review");
    const state = reviewBreakerState();
    expect(state["peer.review"].open).toBe(true);
    expect(state["peer.review"].consecutiveTimeouts).toBe(3);
    expect(state["peer.review"].msRemaining).toBeGreaterThan(0);
  });
});
