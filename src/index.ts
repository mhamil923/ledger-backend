import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

const app = createApp();

const server = app.listen(config.PORT, () => {
  console.log(`ledger-backend listening on http://localhost:${config.PORT}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, shutting down...`);
  server.close(() => {
    void pool.end().then(() => {
      console.log('Shutdown complete.');
      process.exit(0);
    });
  });
  setTimeout(() => {
    console.error('Forced exit after 10s timeout.');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Safety net: keep the server up even if a route handler or upstream library
// throws an unhandled rejection. Log it loudly so we can find the source.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
