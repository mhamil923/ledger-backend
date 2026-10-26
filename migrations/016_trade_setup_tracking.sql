-- Track which quant setup each journaled trade idea came from, and what its
-- backtest predicted, so the app can compare predicted vs actual hit rates.
ALTER TABLE trade_ideas
  ADD COLUMN setup_id    text,
  ADD COLUMN bt_win_rate numeric(6, 4),
  ADD COLUMN bt_n        integer,
  ADD COLUMN bt_avg_r    numeric(8, 4);
CREATE INDEX trade_ideas_setup_idx ON trade_ideas (user_id, setup_id);
