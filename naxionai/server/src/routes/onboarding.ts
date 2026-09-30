import { Router } from "express";
import { getOnboardingState, setOnboardingState, SECTORS } from "../lib/sector-packs.js";
import { getOperatorIdentity, writeOperatorIdentityFile } from "../lib/mag.js";
import { noteFact } from "../lib/memory.js";
import { applySectorBundle } from "../lib/sector-bundles.js";

// Operator onboarding wizard — finishes the half-built feature that already
// existed (sector-packs.ts's OnboardingState + SECTORS catalog, App.tsx's
// dead /onboarding stub) rather than inventing a new mechanism. Writes
// straight to the vault identity file + onboarding.json; deliberately
// bypasses users.json/auth entirely (see docs/naxie-architecture.md — this
// is a single-operator, no-login install; the auth/signup gate has no
// callers anywhere in the frontend today).
//
// No access-gating, matching the existing /api/naxie/remember precedent for
// this same single-operator trust model.
export const onboardingRouter = Router();

onboardingRouter.get("/sectors", (_req, res) => {
  res.json({ sectors: SECTORS });
});

onboardingRouter.get("/state", (_req, res) => {
  res.json({ state: getOnboardingState(), operator: getOperatorIdentity() });
});

onboardingRouter.post("/complete", (req, res) => {
  const b = req.body ?? {};
  const name = String(b.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  const email = String(b.email ?? "").trim();
  const title = String(b.title ?? "").trim();
  const orgName = String(b.orgName ?? "").trim();
  const sector = String(b.sector ?? "").trim() || undefined;
  const customSectorName = sector === "custom" ? String(b.customSectorName ?? "").trim() : undefined;
  const responseStyle = b.responseStyle === "caveman" ? "caveman" : "standard";
  const priorities = String(b.priorities ?? "").trim();
  const communicationStyle = String(b.communicationStyle ?? "").trim();
  const notes = String(b.notes ?? "").trim();

  try {
    // ORDER MATTERS: onboarding.json first — writeOperatorIdentityFile below
    // calls getOperatorIdentity(), which reads sector/orgName/language back
    // from this file, so it must already be fresh before the identity file
    // is rewritten.
    setOnboardingState({
      completed: true,
      sector,
      customSectorName,
      orgName: orgName || undefined,
      responseStyle,
      language: "en",
      completedAt: new Date().toISOString(),
      priorities: priorities || undefined,
      communicationStyle: communicationStyle || undefined,
      notes: notes || undefined,
    });

    writeOperatorIdentityFile({ name, email, title, orgName, sector });

    for (const [label, text] of [
      ["priorities", priorities],
      ["communication preference", communicationStyle],
      ["note", notes],
    ] as const) {
      if (text) noteFact({ subject: "operator", fact: `${label}: ${text}`, source: "onboarding" });
    }

    res.json({ ok: true, state: getOnboardingState(), operator: getOperatorIdentity() });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// POST /api/onboarding/apply-bundle — one-click install of a sector's
// knowledge pack + suggested departments (the "AI Employee bundle"). Never
// runs implicitly — always an explicit operator action, matching the rest of
// this app's "nothing installs itself" posture (connector templates, etc.).
onboardingRouter.post("/apply-bundle", (req, res) => {
  const sectorId = String((req.body ?? {}).sectorId ?? "").trim();
  if (!sectorId) return res.status(400).json({ error: "sectorId is required" });
  try {
    res.json({ ok: true, result: applySectorBundle(sectorId) });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});
