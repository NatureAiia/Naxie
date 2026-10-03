-- memory_facts: Supabase mirror of the local MAG memory store (lib/memory.ts's
-- noteFact/JSONL files under _naxion/memory/). See
-- docs/naxie-storage-architecture.md §5 (MAG — memory).
--
-- Local JSON stays canonical; this table exists purely for wipe-recovery
-- (hydrateMemoryFromSupabaseIfLocalEmpty in lib/memory.ts pulls facts back
-- only when local storage is empty at boot) — not a live two-way sync.
--
-- Run this ONCE against the Supabase project's Postgres database (this repo
-- has no migration runner — apply by hand), matching 0001_vault_chunks.sql's
-- convention:
--   psql "$SUPABASE_DB_URL" -f naxionai/server/migrations/0002_memory_facts.sql
-- or paste it into the Supabase dashboard's SQL editor.

create table if not exists memory_facts (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  fact text not null,
  source text,
  fact_date date,
  created_at timestamptz not null default now()
);

create index if not exists memory_facts_subject_idx on memory_facts (subject);
