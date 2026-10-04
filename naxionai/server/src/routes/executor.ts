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

async function hermesPreflight(local: boolean): Promise<{ ready: boolean; detail: string; localModelAvailable: boolean | null; providerConfigured: boolean | null }> {
  if (!hermesAvailable()) return { ready: false, detail: "Hermes CLI is not installed", localModelAvailable: null, providerConfigured: null };
  if (local) {
    const model = await checkLocalHermesModel();
    return { ready: model.available === true, detail: model.detail ?? "Local model status unknown", localModelAvailable: model.available, providerConfigured: true };
  }
  const providerConfigured = config.hermesProvider === "openrouter" ? config.openrouterEnabled : null;
  return {
    ready: providerConfigured !== false,
    detail: providerConfigured === false ? "Configure OPENROUTER_API_KEY or select local Ollama" : "Cloud provider configuration is present",
    localModelAvailable: null,
    providerConfigured,
  };
}

executorRouter.get("/", async (_req, res) => {
  const cfg = getExecutorConfig();
  const local = cfg.hermesLocal === true;
  const readiness = await hermesPreflight(local);
  res.json({
    mode: cfg.mode,
    hermesModelOverride: cfg.hermesModel ?? null,
    hermesLocal: local,
    crosscheck: cfg.crosscheck === true,
    hermesCodeTasks: cfg.hermesCodeTasks === true,
    fallbackToNaxie: process.env.NAXION_HERMES_FALLBACK !== "0",
    qualityGate: process.env.NAXION_HERMES_QUALITY_GATE !== "0",
    hermes: {
      available: hermesAvailable(),
      binPath: detectHermesBin() ?? undefined,
      model: cfg.hermesModel ?? (local ? config.hermesLocalModel : config.hermesModel),
      provider: local ? config.hermesLocalProvider : config.hermesProvider,
      localModel: config.hermesLocalModel,
      localModelAvailable: readiness.localModelAvailable,
      localModelDetail: local ? readiness.detail : undefined,
      providerConfigured: readiness.providerConfigured,
      readiness: readiness.ready ? "ready" : !hermesAvailable() ? "install" : "configure-model",
      readinessDetail: readiness.detail,
    },
  });
});

// POST { mode?: "naxie" | "hermes", hermesModel?: string | null,
//        hermesLocal?: boolean, crosscheck?: boolean }
// hermesLocal:true points Hermes at the local Ollama daemon running
// config.hermesLocalModel (default north-mini-code-10) — free + offline.
// crosscheck:true has a peer judge Hermes's answer against Naxie's on a
// quality-fail offload instead of always taking Naxie's (see chat.ts).
executorRouter.post("/", async (req, res) => {
  const body = req.body ?? {};
  const mode = body.mode as ExecutorMode | undefined;
  if (mode !== undefined && mode !== "naxie" && mode !== "hermes") {
    return res.status(400).json({ error: 'mode must be "naxie" or "hermes"' });
  }
  if (body.hermesLocal !== undefined && typeof body.hermesLocal !== "boolean") return res.status(400).json({ error: "hermesLocal must be a boolean" });
  if (body.crosscheck !== undefined && typeof body.crosscheck !== "boolean") return res.status(400).json({ error: "crosscheck must be a boolean" });
  if (body.hermesCodeTasks !== undefined && typeof body.hermesCodeTasks !== "boolean") return res.status(400).json({ error: "hermesCodeTasks must be a boolean" });
  if (body.hermesModel !== undefined && body.hermesModel !== null && typeof body.hermesModel !== "string") return res.status(400).json({ error: "hermesModel must be a string or null" });
  if (typeof body.hermesModel === "string" && body.hermesModel.trim().length > 160) return res.status(400).json({ error: "hermesModel must be 160 characters or fewer" });
  const current = getExecutorConfig();
  const nextMode = mode ?? current.mode;
  const nextLocal = body.hermesLocal === undefined ? current.hermesLocal === true : body.hermesLocal;
  if (nextMode === "hermes") {
    const preflight = await hermesPreflight(nextLocal);
    if (!preflight.ready) return res.status(400).json({ error: `Hermes isn't ready: ${preflight.detail}` });
  }
  try {
    const next = setExecutorConfig({
      ...(mode !== undefined ? { mode } : {}),
      ...(body.hermesModel !== undefined ? { hermesModel: body.hermesModel } : {}),
      ...(body.hermesLocal !== undefined ? { hermesLocal: body.hermesLocal === true } : {}),
      ...(body.crosscheck !== undefined ? { crosscheck: body.crosscheck === true } : {}),
      ...(body.hermesCodeTasks !== undefined ? { hermesCodeTasks: body.hermesCodeTasks } : {}),
    });
    res.json({ ok: true, mode: next.mode, hermesModelOverride: next.hermesModel ?? null, hermesLocal: next.hermesLocal === true, crosscheck: next.crosscheck === true, hermesCodeTasks: next.hermesCodeTasks === true });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});
