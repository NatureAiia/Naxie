<div align="center">

# Naxie

**Naxie** is the nickname for Nature's (Mark's) personal AI assistant system.
It runs on **NaxionAI** — the engine that powers it.

</div>

## What this is

This is a **personal, non-commercial project**, owned and run by one person. It
is not a product, it is not for sale, and it is not distributed to anyone
else — the running instance holds Mark's own operator data, connected
accounts, and credentials, which is exactly why it stays private. If you're
looking at this expecting a general-purpose product or a multi-tenant SaaS,
this isn't that: it's one person's own AI staff.

- **NaxionAI** — the engine. A local-first TypeScript stack (Express API +
  React SPA) that plans, executes, and synthesizes agent work against an
  Obsidian second-brain vault. Lives in [`naxionai/`](naxionai/), one port,
  `http://localhost:7471`.
- **Naxie** — the nickname for the whole running system: the assistant you
  actually talk to, backed by the NaxionAI engine.

## Start here

Everything runs from the [`naxionai/`](naxionai/) workspace:

```bash
cp naxionai/.env.example naxionai/.env
# fill in the keys you want (see naxionai/.env.example for what each does)
cd naxionai && pnpm install && pnpm dev
# → web http://localhost:7470 · server http://localhost:7471
```

See [`naxionai/README.md`](naxionai/README.md) for the full console tour,
pages, security model, and configuration.

## Naming & inspiration

| Name | What it is |
|---|---|
| **NaxionAI** | The engine — the platform/codebase that powers everything. |
| **Naxie** | The system's nickname — the personal assistant this engine runs. |
| **NeuroWorks** | An **inspiration only**, not a dependency: the "local-first AI workforce + second-brain" idea that shaped early design. All NeuroWorks/Clawbot/Neuro naming was retired 2026-10-02 — NaxionAI is the engine, not a fork of NeuroWorks. |
| **Jarvis** | An **inspiration only**: the "build your own AI assistant" concept — a single-user loop that listens, thinks, and acts on your behalf — scaled here into a multi-agent workforce with memory, governance, and network reach. |

Earlier working names (**Digital Force**, and a voice page once called
**Jarvis**) were retired once the project became Mark's own personal
assistant rather than a product.

## License

See [`naxionai/LICENSE`](naxionai/LICENSE).
