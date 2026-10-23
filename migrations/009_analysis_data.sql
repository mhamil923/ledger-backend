-- Structured trade-idea output from Claude (entry zone, stop, targets, etc).
-- Nullable so old rows without tool-use data still load.
ALTER TABLE ai_analyses ADD COLUMN analysis_data jsonb;
