import { Router } from "express";
import { getExecutorConfig, setExecutorConfig, type ExecutorMode } from "../lib/executor-mode.js";
import { hermesAvailable, detectHermesBin } from "../lib/hermes.js";
import { config } from "../config.js";

// Executor mode API — flips which agent does the actual task work, LIVE (no
// server restart). "naxie" = the built-in pipeline + persona-shifter pool;
// "hermes" = the Hermes CLI agent with persona/governance framing, and an
// automatic OFFLOAD to Naxie for anything Hermes can't do. The optional
// hermesModel overrides the configured model live.

export const executorRouter = Router();

executorRouter.get("/", (_req, res) => {
  const cfg = getExecutorConfig();
  const local = cfg.hermesLocal === true;
  res.json({
    mode: cfg.mode,
    hermesModelOverride: cfg.hermesModel ?? null,
    hermesLocal: local,
    crosscheck: cfg.crosscheck === true,
    fallbackToNaxie: process.env.NAXION_HERMES_FALLBACK !== "0",
    qualityGate: process.env.NAXION_HERMES_QUALITY_GATE !== "0",
    hermes: {
      available: hermesAvailable(),
      binPath: detectHermesBin() ?? undefined,
      model: cfg.hermesModel ?? (local ? config.hermesLocalModel : config.hermesModel),
      provider: local ? config.hermesLocalProvider : config.hermesProvider,
      localModel: config.hermesLocalModel,
    },
  });
});

// POST { mode?: "naxie" | "hermes", hermesModel?: string | null,
//        hermesLocal?: boolean, crosscheck?: boolean }
// hermesLocal:true points Hermes at the local Ollama daemon running
// config.hermesLocalModel (default north-mini-code-10) — free + offline.
// crosscheck:true has a peer judge Hermes's answer against Naxie's on a
// quality-fail offload instead of always taking Naxie's (see chat.ts).
executorRouter.post("/", (req, res) => {
  const body = req.body ?? {};
  const mode = body.mode as ExecutorMode | undefined;
  if (mode !== undefined && mode !== "naxie" && mode !== "hermes") {
    return res.status(400).json({ error: 'mode must be "naxie" or "hermes"' });
  }
  if (mode === "hermes" && !hermesAvailable()) {
    return res.status(400).json({ error: "Hermes is not installed on this machine — cannot set it as the primary executor." });
  }
  try {
    const next = setExecutorConfig({
      ...(mode !== undefined ? { mode } : {}),
      ...(body.hermesModel !== undefined ? { hermesModel: body.hermesModel } : {}),
      ...(body.hermesLocal !== undefined ? { hermesLocal: body.hermesLocal === true } : {}),
      ...(body.crosscheck !== undefined ? { crosscheck: body.crosscheck === true } : {}),
    });
    res.json({ ok: true, mode: next.mode, hermesModelOverride: next.hermesModel ?? null, hermesLocal: next.hermesLocal === true, crosscheck: next.crosscheck === true });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});
