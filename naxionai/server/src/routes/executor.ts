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

async function checkLocalHermesModel(): Promise<{ available: boolean | null; detail?: string }> {
  if (config.hermesLocalProvider !== "ollama") return { available: null, detail: `Local provider check not implemented for ${config.hermesLocalProvider}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1800);
  try {
    const response = await fetch(`${config.ollamaHost}/api/tags`, { signal: controller.signal });
    if (!response.ok) return { available: false, detail: `Ollama returned HTTP ${response.status}` };
    const body = await response.json() as { models?: { name?: string }[] };
    const models = (body.models ?? []).map(model => model.name ?? "");
    const available = models.some(name => name === config.hermesLocalModel || name.startsWith(`${config.hermesLocalModel}:`));
    return { available, detail: available ? "Model is installed" : `Pull ${config.hermesLocalModel} in Ollama` };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

executorRouter.get("/", async (_req, res) => {
  const cfg = getExecutorConfig();
  const local = cfg.hermesLocal === true;
  const installed = hermesAvailable();
  const localModel = local ? await checkLocalHermesModel() : null;
  const cloudProviderConfigured = config.hermesProvider === "openrouter" ? config.openrouterEnabled : null;
  const modelReady = local ? localModel?.available === true : cloudProviderConfigured !== false;
  res.json({
    mode: cfg.mode,
    hermesModelOverride: cfg.hermesModel ?? null,
    hermesLocal: local,
    crosscheck: cfg.crosscheck === true,
    fallbackToNaxie: process.env.NAXION_HERMES_FALLBACK !== "0",
    qualityGate: process.env.NAXION_HERMES_QUALITY_GATE !== "0",
    hermes: {
      available: installed,
      binPath: detectHermesBin() ?? undefined,
      model: cfg.hermesModel ?? (local ? config.hermesLocalModel : config.hermesModel),
      provider: local ? config.hermesLocalProvider : config.hermesProvider,
      localModel: config.hermesLocalModel,
      localModelAvailable: localModel?.available ?? null,
      localModelDetail: localModel?.detail,
      providerConfigured: local ? true : cloudProviderConfigured,
      readiness: installed && modelReady ? "ready" : !installed ? "install" : "configure-model",
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
