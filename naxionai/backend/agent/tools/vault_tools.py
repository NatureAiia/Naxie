"""
NAXIONAI — Vault agent tools

Chat-driven equivalent of neuroworks' `search-brain`/`add-note`/`browse-vault`
templates: lets the agent search, read, and write vault notes as part of a
normal ReAct turn, on top of the filesystem + RAG-mirroring implementation
in vault.py.
"""

from langchain_core.tools import tool


def get_vault_tools(state: dict):
    @tool
    def vault_search(query: str) -> str:
        """Search the user's vault (saved notes) by keyword. Returns matching
        note paths with a short snippet of surrounding text."""
        import vault as _vault
        results = _vault.search_notes(query)
        if not results:
            return f'No vault notes matched "{query}".'
        return "\n".join(f"- {r['path']}: ...{r['snippet']}..." for r in results)

    @tool
    def vault_read(path: str) -> str:
        """Read the full content of a vault note by its path (as returned by
        vault_search or vault_browse)."""
        import vault as _vault
        try:
            return _vault.read_note(path)
        except _vault.VaultError as e:
            return f"Could not read '{path}': {e}"

    @tool
    def vault_browse() -> str:
        """List every note currently stored in the vault (path + size)."""
        import vault as _vault
        entries = _vault.list_tree()
        if not entries:
            return "The vault is empty."
        return "\n".join(f"- {e['path']} ({e['size_bytes']} bytes)" for e in entries)

    @tool
    async def vault_write(path: str, content: str) -> str:
        """Save a note to the vault (creates or overwrites) at the given
        relative path, e.g. 'research/cognify-rollup.md'. The note is also
        embedded into the knowledge base so future questions can retrieve it."""
        import vault as _vault
        try:
            result = await _vault.save_note(path, content, uploaded_by=state.get("created_by"))
        except _vault.VaultError as e:
            return f"Could not save '{path}': {e}"
        return f"Saved to vault: {result['path']}"

    return [vault_search, vault_read, vault_browse, vault_write]
