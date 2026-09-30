-- vault_chunks entity/keyword sidecar (RAG RIFTS-X upgrade).
-- Adds per-chunk extracted entities, keywords, and source kind so retrieval
-- can boost on entity overlap without re-parsing content at query time.
--
-- Apply by hand (no migration runner in this repo):
--   psql "$SUPABASE_DB_URL" -f neuroworks/server/migrations/0003_vault_chunks_entities.sql

alter table if exists vault_chunks
  add column if not exists entities jsonb not null default '{}'::jsonb,
  add column if not exists keywords text[] not null default '{}',
  add column if not exists source_kind text not null default 'md';

create index if not exists vault_chunks_keywords_idx
  on vault_chunks using gin (keywords);
