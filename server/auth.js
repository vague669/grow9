const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const router = express.Router();

function validName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_]{3,16}$/.test(name);
}

function isConfiguredAdmin(uname) {
  const list = (process.env.ADMIN_USERNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(uname);
}

router.post('/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!validName(username)) {
    return res.status(400).json({ error: 'Kullanıcı adı 3-16 karakter, sadece harf/rakam/_ olabilir.' });
  }
  if (typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ error: 'Şifre en az 4 karakter olmalı.' });
  }
  const uname = username.toLowerCase();
  try {
    const existing = await pool.query('SELECT id FROM users WHERE username=$1', [uname]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Bu kullanıcı adı zaten alınmış.' });
    }
    const hash = await bcrypt.hash(password, 10);
    const starterInventory = [
      { id: 'fist', count: 1 },
      { id: 'dirt', count: 100 },
      { id: 'seed_pepper', count: 5 },
      { id: 'wings_basic', count: 1 },
    ];
    const isAdmin = isConfiguredAdmin(uname);
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, gems, inventory, worn, is_admin) VALUES ($1,$2,80,$3,'{"wings":null}',$4)
       RETURNING id, username, gems, inventory, worn, is_admin`,
      [uname, hash, JSON.stringify(starterInventory), isAdmin]
    );
    const user = result.rows[0];
    const token = jwt.sign({ uid: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası.' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli.' });
  const uname = String(username).toLowerCase();
  try {
    const result = await pool.query('SELECT * FROM users WHERE username=$1', [uname]);
    if (!result.rows.length) return res.status(401).json({ error: 'Hatalı kullanıcı adı veya şifre.' });
    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Hatalı kullanıcı adı veya şifre.' });
    if (isConfiguredAdmin(uname) && !user.is_admin) {
      await pool.query('UPDATE users SET is_admin=true WHERE id=$1', [user.id]);
      user.is_admin = true;
    }
    const token = jwt.sign({ uid: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    delete user.password_hash;
    res.json({ token, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası.' });
  }
});

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Giriş gerekli.' });
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Oturum geçersiz, tekrar giriş yap.' });
  }
}

function verifySocketToken(token) {
  return jwt.verify(token, JWT_SECRET); // throws if invalid
}

module.exports = { router, authMiddleware, verifySocketToken, JWT_SECRET };
