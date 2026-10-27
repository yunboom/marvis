-- pgvector backs the vector half of knowledge base hybrid search. The images
-- this repo ships (pgvector/pgvector) bundle it, but the desktop standalone
-- Postgres does not, so cmd/migrate only runs this where the extension is
-- available and records it as a no-op elsewhere; search then stays
-- keyword-only. Recovery after installing pgvector: cmd/migrate/README.md.
CREATE EXTENSION IF NOT EXISTS vector;
