-- Enable accent-insensitive text search (e.g. "medellin" matches "Medellín").
-- Used by the reference city search, which filters with
-- `unaccent(name) ILIKE unaccent(:q)`.
CREATE EXTENSION IF NOT EXISTS unaccent;
