require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const { initSchema } = require('./db');
const authRoutes = require('./auth').router;
const worldsRoutes = require('./worldsRoutes');
const { attachSocketHandlers, persistWorld } = require('./socket');
const { setIO } = require('./state');

async function main() {
  await initSchema();

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes);
  app.use('/api/worlds', worldsRoutes);

  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });
  setIO(io);
  attachSocketHandlers(io);

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`[server] listening on :${PORT}`));

  async function gracefulShutdown(signal) {
    console.log(`[server] ${signal} alındı, tüm dünyalar kaydediliyor...`);
    const { liveWorlds } = require('./state');
    const names = Array.from(liveWorlds.keys());
    await Promise.all(names.map((n) => persistWorld(n).catch((e) => console.error('flush error', n, e))));
    console.log('[server] kayıt tamamlandı, kapanıyor.');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000); // güvenlik: 5sn'de zorla çık
  }
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
