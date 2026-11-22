-- Recommendation AI (hybrid CF + content embedding + logistic-regression ranker). Additive only.
-- Account engagement is stored as aggregated counters per (user, track), never as an event log.
BEGIN;

CREATE TABLE IF NOT EXISTS track_engagement (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  starts INTEGER NOT NULL DEFAULT 0 CHECK (starts >= 0),
  skips INTEGER NOT NULL DEFAULT 0 CHECK (skips >= 0),
  completes INTEGER NOT NULL DEFAULT 0 CHECK (completes >= 0),
  last_event_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_token_id UUID,
  -- startedAtMs of the newest accepted start; older listen tokens can never start again (replay guard).
  last_started_at_ms BIGINT NOT NULL DEFAULT 0 CHECK (last_started_at_ms >= 0),
  CONSTRAINT track_engagement_pkey PRIMARY KEY (user_id, track_id)
);
CREATE INDEX IF NOT EXISTS track_engagement_track_idx ON track_engagement(track_id);

CREATE TABLE IF NOT EXISTS recommendation_impressions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  request_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  surface VARCHAR(32) NOT NULL CHECK (surface ~ '^[A-Za-z0-9_:-]{1,32}$'),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 1000),
  reason VARCHAR(16) NOT NULL CHECK (reason ~ '^[A-Z_]{1,16}$'),
  model_version VARCHAR(64),
  shown_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  clicked_at TIMESTAMPTZ,
  CONSTRAINT recommendation_impressions_request_track_key UNIQUE (request_id, track_id)
);
CREATE INDEX IF NOT EXISTS recommendation_impressions_user_shown_idx ON recommendation_impressions(user_id, shown_at DESC);
CREATE INDEX IF NOT EXISTS recommendation_impressions_track_shown_idx ON recommendation_impressions(track_id, shown_at);

CREATE TABLE IF NOT EXISTS track_embeddings (
  track_id UUID NOT NULL PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  content_hash CHAR(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  model VARCHAR(128) NOT NULL CHECK (length(model) > 0),
  dims INTEGER NOT NULL CHECK (dims BETWEEN 1 AND 4096),
  vector REAL[] NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT track_embeddings_vector_shape CHECK (
    array_ndims(vector) = 1 AND cardinality(vector) = dims AND array_position(vector, NULL) IS NULL
  )
);

CREATE TABLE IF NOT EXISTS recommendation_models (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  version VARCHAR(64) NOT NULL CHECK (length(version) > 0),
  feature_names TEXT[] NOT NULL,
  weights DOUBLE PRECISION[] NOT NULL,
  bias DOUBLE PRECISION NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recommendation_models_version_key UNIQUE (version),
  CONSTRAINT recommendation_models_shape CHECK (
    array_ndims(feature_names) = 1 AND array_ndims(weights) = 1
    AND cardinality(feature_names) = cardinality(weights) AND cardinality(weights) BETWEEN 1 AND 64
    AND array_position(feature_names, NULL) IS NULL AND array_position(weights, NULL) IS NULL
  )
);
-- At most one active model; activation swaps rows inside one transaction (batch job, owner role).
CREATE UNIQUE INDEX IF NOT EXISTS recommendation_models_single_active_idx ON recommendation_models(active) WHERE active;

REVOKE ALL ON track_engagement, recommendation_impressions, track_embeddings, recommendation_models
  FROM PUBLIC, infosound_api, infosound_audio, infosound_background;
GRANT SELECT ON track_embeddings, recommendation_models TO infosound_api;
GRANT SELECT, INSERT, UPDATE ON track_engagement, recommendation_impressions TO infosound_api;

COMMIT;
