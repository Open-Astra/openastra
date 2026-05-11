-- Add compression flag to semantic cache entries
ALTER TABLE semantic_cache ADD COLUMN compressed boolean NOT NULL DEFAULT false;
