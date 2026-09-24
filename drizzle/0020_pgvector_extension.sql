-- Retrieval infrastructure. The docker image (pgvector/pgvector:pg17) can
-- provide the extension, but nothing has enabled it until now — see
-- docs/ARCHITECTURE.md's "Retrieval and chat" section.
CREATE EXTENSION IF NOT EXISTS vector;
