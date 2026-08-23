// extension-webhooks — pure decision logic only (verifySecret env fallback and
// secret shape). Store-backed functions (create/rotate/remove) touch the real
// .neuroworks store, consistent with repo convention we don't test I/O here.

import { afterEach, describe, expect, it } from "vitest";
import { verifySecret } from "../src/lib/extension-webhooks.js";

const ENV_KEYS = ["EXTENSION_WEBHOOK_SECRET", "NW_WEBHOOK_SIGNING_SECRET"] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("verifySecret — unknown webhook id", () => {
  it("rejects when no secret is provided", () => {
    expect(verifySecret("no-such-webhook", undefined)).toBe(false);
    expect(verifySecret("no-such-webhook", "")).toBe(false);
  });

  it("rejects an unknown id with no env fallback configured", () => {
    expect(verifySecret("no-such-webhook", "anything")).toBe(false);
  });

  it("accepts the EXTENSION_WEBHOOK_SECRET env shared secret as fallback", () => {
    process.env.EXTENSION_WEBHOOK_SECRET = "shared-env-secret";
    expect(verifySecret("no-such-webhook", "shared-env-secret")).toBe(true);
  });

  it("accepts the NW_WEBHOOK_SIGNING_SECRET legacy env fallback", () => {
    process.env.NW_WEBHOOK_SIGNING_SECRET = "legacy-shared-secret";
    expect(verifySecret("no-such-webhook", "legacy-shared-secret")).toBe(true);
  });

  it("EXTENSION_WEBHOOK_SECRET wins over the legacy var", () => {
    process.env.EXTENSION_WEBHOOK_SECRET = "primary";
    process.env.NW_WEBHOOK_SIGNING_SECRET = "legacy";
    expect(verifySecret("no-such-webhook", "primary")).toBe(true);
    expect(verifySecret("no-such-webhook", "legacy")).toBe(false);
  });

  it("rejects a wrong env secret", () => {
    process.env.EXTENSION_WEBHOOK_SECRET = "right";
    expect(verifySecret("no-such-webhook", "wrong")).toBe(false);
  });
});
