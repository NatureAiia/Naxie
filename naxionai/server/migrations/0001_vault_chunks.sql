-- vault_chunks: pgvector-backed semantic search over the vault (RAG Phase 2,
-- see docs/naxie-storage-architecture.md). Populated by the re-embed job in
-- lib/rag-embed.ts, queried by lib/rag.ts's pgvectorSearch().
--
-- Run this ONCE against the Supabase project's Postgres database (this repo
-- has no migration runner — apply by hand):
--   psql "$SUPABASE_DB_URL" -f neuroworks/server/migrations/0001_vault_chunks.sql
-- or paste it into the Supabase dashboard's SQL editor.
--
-- Requires the pgvector extension, which Supabase ships and allows enabling
-- via `create extension`.

create extension if not exists vector;

create table if not exists vault_chunks (
  id uuid primary key default gen_random_uuid(),
  path text not null,
  heading text,
  title text,
  chunk_index int not null,
  content text not null,
  embedding vector(1536),
  embedding_model text not null default 'text-embedding-3-small',
  updated_at timestamptz not null default now()
);

create index if not exists vault_chunks_embedding_idx
  on vault_chunks using hnsw (embedding vector_cosine_ops);

create unique index if not exists vault_chunks_path_chunk_idx
  on vault_chunks (path, chunk_index);
