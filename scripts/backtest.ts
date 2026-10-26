// Backtest every setup on your watchlist using REAL candles (Coinbase for
// crypto, Twelve Data for stocks). Usage:
//   npm run backtest            # whole watchlist
//   npm run backtest BTC NVDA   # just these
import { pool, query } from '../src/db.js';
import { getQuantCandles } from '../src/services/market-data.js';
import { convictionFromStats, runQuant } from '../src/services/quant.js';

const pct = (x: number): string => `${Math.round(x * 100)}%`.padStart(4);

async function main(): Promise<void> {
  const args = process.argv.slice(2).map((s) => s.toUpperCase());
  const rows = (
    await query<{ symbol: string; asset_type: 'stock' | 'crypto' | 'etf' }>(
      `SELECT DISTINCT symbol, asset_type FROM watchlist_items ORDER BY asset_type, symbol`,
    )
  ).rows.filter((r) => args.length === 0 || args.includes(r.symbol.toUpperCase()));
  if (rows.length === 0) {
    console.log('No matching watchlist symbols.');
    return;
  }
  for (const { symbol, asset_type } of rows) {
    try {
      const candles = await getQuantCandles(symbol, asset_type);
      if (!candles) {
        console.log(`\n${symbol}: no candle data (not on Coinbase / Twelve Data key missing)`);
        continue;
      }
      const q = runQuant(candles);
      const d = q.daily?.indicators;
      console.log(
        `\n=== ${symbol} (${asset_type}) — ${candles.daily.length} daily / ${candles.hourly.length} hourly bars` +
          (d ? ` · daily ${d.regime}, ADX ${d.adx14.toFixed(0)}, RSI ${d.rsi14.toFixed(0)}` : ''),
      );
      console.log('  timeframe   setup                         n   win  safe   avgR  stars');
      for (const b of q.backtests.filter((x) => x.stats.n > 0).sort((a, b) => b.stats.win_rate_lower - a.stats.win_rate_lower)) {
        console.log(
          `  ${b.horizon.padEnd(11)} ${b.label.padEnd(30)}${String(b.stats.n).padStart(3)}  ${pct(b.stats.win_rate)}  ${pct(b.stats.win_rate_lower)}  ${(b.stats.avg_r >= 0 ? '+' : '') + b.stats.avg_r.toFixed(2)}R  ${'★'.repeat(convictionFromStats(b.stats))}`,
        );
      }
      const live = q.candidates.filter((c) => c.stats.avg_r > 0 && c.stats.n >= 8);
      console.log(live.length ? '  FIRING NOW:' : '  Firing now: nothing with a measured edge.');
      for (const c of live) {
        console.log(`    [${c.horizon}] ${c.label} — entry ${c.entry_zone.map((x) => x.toPrecision(6)).join('–')}, stop ${c.stop_loss.toPrecision(6)}, T1 ${c.targets[0]!.toPrecision(6)} (${pct(c.stats.win_rate)} over ${c.stats.n})`);
      }
    } catch (err) {
      console.log(`\n${symbol}: failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    // Twelve Data free tier: 8 requests/minute.
    if (asset_type !== 'crypto') await new Promise((r) => setTimeout(r, 16_000));
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
