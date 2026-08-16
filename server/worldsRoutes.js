const express = require('express');
const { pool } = require('./db');
const { authMiddleware } = require('./auth');
const { newWorldTiles } = require('./worldgen');
const { liveWorlds } = require('./state');

const router = express.Router();
const VALID_WORLD_NAME = /^[a-zA-Z0-9]{3,20}$/;

// Aktif (en az 1 oyuncunun içinde olduğu) + DB'deki son 50 dünyayı listele
// Matrix companion dünyaları (adı _MATRIX ile biten) bu listede hiç gösterilmez
router.get('/', authMiddleware, async (req, res) => {
  try {
    const dbRows = await pool.query(
      `SELECT w.name, u.username as owner, w.locked, w.updated_at
       FROM worlds w JOIN users u ON u.id = w.owner_id
       WHERE w.name NOT LIKE '%\\_MATRIX' ESCAPE '\\'
       ORDER BY w.updated_at DESC LIMIT 50`
    );
    const list = dbRows.rows.map(r => {
      const live = liveWorlds.get(r.name);
      return {
        name: r.name,
        owner: r.owner,
        locked: r.locked,
        online: live ? live.players.size : 0,
      };
    });
    res.json({ worlds: list });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası.' });
  }
});

// Dünya oluştur (yoksa) veya var olanın temel bilgisini döndür (giriş öncesi kontrol için)
router.post('/', authMiddleware, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !VALID_WORLD_NAME.test(name)) {
    return res.status(400).json({ error: 'Dünya adı 3-20 karakter, sadece harf/rakam olabilir (alt çizgi kullanılamaz).' });
  }
  const wname = name.toUpperCase();
  if (wname === 'MATRIX' || wname.endsWith('_MATRIX')) {
    return res.status(400).json({ error: 'Bu isim sistem tarafından kullanılıyor, başka bir isim seç.' });
  }
  try {
    const existing = await pool.query('SELECT id, owner_id, locked FROM worlds WHERE name=$1', [wname]);
    if (existing.rows.length) {
      return res.json({ created: false, name: wname });
    }
    const tiles = newWorldTiles();
    await pool.query(
      `INSERT INTO worlds (name, owner_id, tiles, plants, drops) VALUES ($1,$2,$3,'[]','[]')`,
      [wname, req.auth.uid, JSON.stringify(tiles)]
    );
    res.json({ created: true, name: wname });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası.' });
  }
});

module.exports = router;
