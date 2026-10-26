# Trade analysis: how ideas are made (and measured)

Every trade idea comes from a **quant engine** (`src/services/quant.ts`), and Claude explains it. Claude no longer picks entries, stops and targets by eye.

1. **Data**: daily (~600 bars) and hourly (~900 bars) candles. Crypto comes from Coinbase, stocks and ETFs from Twelve Data. Stocks also get their next earnings date from Finnhub.
2. **Indicators**: ATR, EMA 20/50/200, RSI, ADX, Bollinger Bands, relative volume, and support/resistance clustered from swing pivots.
3. **Six setups**, each long and short: trend pullback to EMA20 (limit order), 20-bar breakout or breakdown (stop order), and range reversion off the Bollinger bands (market order).
4. **Backtest**: each setup is replayed on the asset's own history for three timeframes. Day trades use hourly bars with a 24-bar time limit. Swings use daily bars with a 10-bar limit. Positions use daily bars with a 40-bar limit and wider stops.
   - Stops are 1.5 ATR away (2.5 ATR for positions). Targets are 1R, 2R and 3R.
   - A trade counts as a win if it reaches target 1 before the stop.
   - The backtest is deliberately pessimistic. If a bar touches both the stop and the target, it counts as a stop. Stop orders slip by 0.1 ATR. Limit orders need price to trade 0.05 ATR through the level. A pending order that fills mid-bar counts as stopped out if that same bar also reaches the stop.
   - Sanity check: on synthetic random-walk markets with no edge, every setup comes out at about 50% and roughly 0R.
5. **Grounding**:
   - The server replaces each idea's numbers with those of the measured setup Claude names.
   - Conviction comes from the setup's Wilson lower-bound win rate (the "conservative" figure) and its average R. Claude can lower conviction but not raise it.
   - If no setup with a measured edge (at least 8 past trades and positive average R) is firing on a timeframe, that timeframe shows "watch only".
   - If earnings fall inside a stock trade's holding window, conviction is capped at 2.
6. **Your bar**: in the app you choose a minimum conservative win rate (50%, 60% or 70%). Each idea shows whether it clears that bar.
7. **Live scorecard**: every journaled idea stores its setup and the win rate its backtest predicted. `/api/trades/summary` compares the actual hit rate of measured ideas against that prediction, and against the older eyeballed ideas, which went 29 wins and 39 losses (43%).

**Why not "90%"?** Any system can hit 90% by setting tiny targets and huge stops, and lose money anyway. What matters is win rate × average win compared with average loss. The engine shows both figures for every setup, so you can see the real odds.

Run `npm run backtest` (or double-click `backtest-watchlist.command`) to see every setup's real numbers for your whole watchlist.
