# CLAUDE.md

Guidance for Claude Code (and other AI assistants) working in this repository.

## Repositories — do not confuse these

This project spans **two separate GitHub repositories** with distinct purposes:

| Repo | URL | Purpose |
|---|---|---|
| **Main code repo** (this repo, `origin`) | https://github.com/NatureAiia/NaxionAI-Powered-by-Neuroworks | Application source code. All code changes, commits, and PRs go here. |
| **Vault repo** | https://github.com/marknature/NaxionAI_Vault-Repo | Knowledge/data storage — actual knowledge-vault content and operator data, kept separate from source code. |

Note: the local `neuroworks/vault/` folder *inside* the main code repo is unrelated —
it's just an empty placeholder directory the app reads/writes local notes to at
runtime (see `neuroworks/vault/README.md`). It is not the vault repo above and
should stay empty/generic in the main code repo.

**Rule of thumb:** code changes go to the main code repo. Knowledge/data/vault
content goes to the vault repo. Never push code to the vault repo or vault
content/data into the main code repo.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
