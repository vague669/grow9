const { pool } = require('./db');
const { verifySocketToken } = require('./auth');
const { ITEMS, STORE_ITEMS, randInt, craftResult, SEEDPACK_TABLE, LATHE_ONLY_RESULTS } = require('./items');
const { liveWorlds, tradeSessions, onlineUsers, mutedUsers, missionSessions, setIO, getIO } = require('./state');
const { newWorldTiles, newMatrixWorldTiles, WORLD_W, WORLD_H, DOOR_TX, DOOR_TY, MATRIX_W, MATRIX_H, MATRIX_DOOR_TX, MATRIX_DOOR_TY, getMatrixDaySeed, generateMatrixWorld, MISSION_W, MISSION_H, generateMissionWorld } = require('./worldgen');
// Updated imports: only import new inventory constants
const { MAX_INVENTORY_SLOTS, SLOT_PURCHASE_SIZE, MAX_SLOT_PURCHASES, SLOT_COST_GEMS } = require('./constants');

const GLOBAL_MATRIX_NAME = 'MATRIX'; // tüm sunucudaki oyuncuların paylaştığı tek, sistem-yönetimli dünya adı

const FLUSH_INTERVAL_MS = 6000;
const EMPTY_WORLD_EVICT_MS = 60000;

function migrateTilesToCurrentSize(tiles) {
  const oldH = tiles.length, oldW = tiles[0] ? tiles[0].length : 0;
  if (oldH === WORLD_H && oldW === WORLD_W) return tiles;
  const fresh = newWorldTiles();
  const merged = [];
  for (let y = 0; y < WORLD_H; y++) {
    const row = [];
    for (let x = 0; x < WORLD_W; x++) {
      row.push((y < oldH && x < oldW) ? tiles[y][x] : fresh[y][x]);
    }
    merged.push(row);
  }
  return merged;
}

// Global Matrix, DB'de gerçek bir "worlds" satırı değildir — sistem-yönetimlidir, kalıcı oyuncu
// değişikliği kabul etmez (vizyon md.18), bu yüzden owner_id NOT NULL kısıtına da takılmaz.
// Sadece bellekte tutulur; günlük seed değiştiğinde otomatik yeniden üretilir.
function buildGlobalMatrixLive() {
  const seed = getMatrixDaySeed();
  const gen = generateMatrixWorld(seed);
  return {
    id: null,
    ownerId: null,
    ownerUsername: 'SYSTEM',
    tiles: gen.tiles,
    plants: [],
    drops: [],
    locked: true, lockType: 'system', // Matrix'te blok kırma/koyma tamamen kapalı (server-controlled)
    access: [],
    shops: [],
    hits: new Map(),
    players: new Map(),
    dirty: false,
    evictTimer: null,
    isMatrix: true,
    daySeed: seed,
    npcs: gen.npcSpawns.map((n, i) => ({
      id: `npc_${i}`, x: n.x * 32, y: n.y * 32, region: n.region,
      // ilk 2 NPC Telephone Line, sonraki 2'si Courier görevi verir; kalanlar süs (lore) NPC'si — deterministik, seed'e bağlı.
      questType: i === 0 || i === 1 ? 'telephone' : (i === 2 || i === 3 ? 'courier' : null),
    })),
    booths: gen.boothSpawns.map((b, i) => ({ id: `booth_${i}`, x: b.x * 32, y: b.y * 32, region: b.region })),
    mainSpawn: gen.mainSpawn,
  };
}
function getOrCreateGlobalMatrix() {
  let live = liveWorlds.get(GLOBAL_MATRIX_NAME);
  const currentSeed = getMatrixDaySeed();
  if (!live || live.daySeed !== currentSeed) {
    // gün değişti (veya ilk kez isteniyor) — yeni layout üret, mevcut oyuncuları koruyarak devret
    const fresh = buildGlobalMatrixLive();
    if (live) { fresh.players = live.players; if (live.evictTimer) clearTimeout(live.evictTimer); }
    liveWorlds.set(GLOBAL_MATRIX_NAME, fresh);
    if (live && live.daySeed !== currentSeed) {
      getIO() && getIO().to(`world:${GLOBAL_MATRIX_NAME}`).emit('matrix:layoutChanged', { reason: 'Matrix günlük olarak yeniden düzenlendi.' });
    }
    return fresh;
  }
  if (live.evictTimer) { clearTimeout(live.evictTimer); live.evictTimer = null; }
  return live;
}

async function loadWorldIntoMemory(name) {
  if (name === GLOBAL_MATRIX_NAME) return getOrCreateGlobalMatrix();
  if (liveWorlds.has(name)) return liveWorlds.get(name);
  const r = await pool.query(
    `SELECT w.*, u.username as owner_username FROM worlds w JOIN users u ON u.id = w.owner_id WHERE w.name=$1`,
    [name]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const wasSmallerSize = row.tiles.length !== WORLD_H || (row.tiles[0] && row.tiles[0].length !== WORLD_W);
  const live = {
    id: row.id,
    ownerId: row.owner_id,
    ownerUsername: row.owner_username,
    tiles: migrateTilesToCurrentSize(row.tiles),
    plants: row.plants || [],
    drops: row.drops || [],
    locked: row.locked,
    lockType: row.lock_type,
    access: normalizeAccess(row.access || []),
    shops: (row.shops || []).map(s => ({ ...s, _busy: false })), // _busy: eşzamanlı satın alma kilidini bellekte tutar (DB'ye yazılmaz)
    hits: new Map(),
    players: new Map(), // socketId -> {uid, username, x, y, dir, anim, worn}
    dirty: wasSmallerSize,
    evictTimer: null,
  };
  liveWorlds.set(name, live);
  return live;
}

async function persistWorld(name) {
  const live = liveWorlds.get(name);
  if (!live || !live.dirty || live.isMatrix) return; // Matrix DB'de tutulmaz, sistem tarafından günlük yeniden üretilir
  live.dirty = false;
  await pool.query(
    `UPDATE worlds SET tiles=$1, plants=$2, drops=$3, locked=$4, lock_type=$5, access=$6, shops=$7, updated_at=now() WHERE id=$8`,
    [JSON.stringify(live.tiles), JSON.stringify(live.plants), JSON.stringify(live.drops), live.locked, live.lockType, JSON.stringify(live.access), JSON.stringify(live.shops.map(({_busy, ...s}) => s)), live.id]
  );
}

async function persistUserRow(uid, patch) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const k of Object.keys(patch)) {
    sets.push(`${k}=$${i++}`);
    vals.push(typeof patch[k] === 'object' ? JSON.stringify(patch[k]) : patch[k]);
  }
  vals.push(uid);
  await pool.query(`UPDATE users SET ${sets.join(',')} WHERE id=$${i}`, vals);
}

// Permission grupları: OWNER (örtük, ownerId ile), CO_OWNER, BUILDER, VISITOR, BANNED.
// Eski veri formatı (düz username string dizisi) BUILDER olarak yorumlanır — geriye dönük uyumluluk.
const ROLE_BUILDER = 'BUILDER', ROLE_CO_OWNER = 'CO_OWNER', ROLE_VISITOR = 'VISITOR', ROLE_BANNED = 'BANNED';
function normalizeAccess(access) {
  if (!Array.isArray(access)) return [];
  return access.map(entry => {
    if (typeof entry === 'string') return { username: entry, role: ROLE_BUILDER }; // eski format migration
    return { username: entry.username, role: entry.role || ROLE_BUILDER };
  });
}
function findAccessEntry(live, username) {
  return live.access.find(e => e.username === username);
}
function canBuildAt(live, uid, username) {
  if (live.ownerId === uid) return true;
  const entry = findAccessEntry(live, username);
  if (entry && entry.role === ROLE_BANNED) return false;
  if (!live.locked) return true;
  return !!entry && (entry.role === ROLE_BUILDER || entry.role === ROLE_CO_OWNER);
}
function canManageAccess(live, uid, username) {
  if (live.ownerId === uid) return true;
  const entry = findAccessEntry(live, username);
  return !!entry && entry.role === ROLE_CO_OWNER;
}
function isBanned(live, username) {
  const entry = findAccessEntry(live, username);
  return !!entry && entry.role === ROLE_BANNED;
}

const REACH_TILES = 3; // karakterin etrafında kaç blok erişim mesafesi (sunucu tarafı doğrulama)
function inReach(live, socketId, tx, ty) {
  const p = live.players.get(socketId);
  if (!p) return false;
  const ptx = Math.floor(p.x / 32), pty = Math.floor(p.y / 32);
  return Math.abs(tx - ptx) <= REACH_TILES && Math.abs(ty - pty) <= REACH_TILES;
}

function invAdd(inventory, id, count) {
  const row = inventory.find(i => i.id === id);
  if (row) row.count += count; else inventory.push({ id, count });
}
function invRemove(inventory, id, count) {
  const row = inventory.find(i => i.id === id);
  if (!row || row.count < count) return false;
  row.count -= count;
  if (row.count <= 0) {
    const idx = inventory.indexOf(row);
    inventory.splice(idx, 1);
  }
  return true;
}

function attachSocketHandlers(io) {
  // kullanıcı adı(lowercase) -> son özel mesajlaştığı kullanıcı adı (/reply için)
  const lastWhisperTarget = new Map();
  // periyodik flush: her açık dünyayı belli aralıklarla DB'ye yaz
  setInterval(() => {
    for (const name of liveWorlds.keys()) persistWorld(name).catch(console.error);
  }, FLUSH_INTERVAL_MS);

  io.on('connection', (socket) => {
    let ctx = null; // {uid, username, worldName}

    socket.on('auth:join', async ({ token, worldName }, ack) => {
      try {
        const payload = verifySocketToken(token);
        const uname = String(worldName || '').toUpperCase();
        const userRes = await pool.query('SELECT id, username, gems, inventory, worn, is_admin, banned_until FROM users WHERE id=$1', [payload.uid]);
        if (!userRes.rows.length) return ack && ack({ error: 'Kullanıcı bulunamadı.' });
        const user = userRes.rows[0];

        // Global admin banı (/sban) — kalıcı DB kaydı, dünya bazlı BANNED rolünden ayrı.
        if (user.banned_until && new Date(user.banned_until).getTime() > Date.now()) {
          const mins = Math.ceil((new Date(user.banned_until).getTime() - Date.now()) / 60000);
          return ack && ack({ error: mins > 60 * 24 * 365 ? 'Hesabın sunucudan kalıcı olarak banlandı.' : `Hesabın sunucudan ${mins} dakika daha banlı.` });
        }

        const live = await loadWorldIntoMemory(uname);
        if (!live) return ack && ack({ error: 'Dünya bulunamadı.' });

        // Dünya-özel ban (owner'ın /ban attığı BANNED rolü) — kilit tipi (WL/DL/BL vb.) fark etmeksizin
        // owner'ın kendisi ve global admin muaf; başka herkes engellenir.
        if (live.ownerId !== user.id && !user.is_admin) {
          const accessEntry = findAccessEntry(live, user.username);
          if (accessEntry && accessEntry.role === ROLE_BANNED) {
            return ack && ack({ error: 'Bu dünyadan banlısın, sahibi /unban yapana kadar giremezsin.' });
          }
        }

        if (live.evictTimer) { clearTimeout(live.evictTimer); live.evictTimer = null; }

        // hayalet oturum temizliği: aynı kullanıcı başka bir socket ile hâlâ kayıtlıysa (hızlı çıkış/giriş,
        // sekme kapatma vb.) onu önce temizle ki oyuncu kendini "çoğalmış" görmesin
        for (const [wname, wlive] of liveWorlds) {
          for (const [sid, p] of wlive.players) {
            if (p.uid === user.id && sid !== socket.id) {
              wlive.players.delete(sid);
              io.to(`world:${wname}`).emit('player:leave', { id: sid });
              const staleSocket = io.sockets.sockets.get(sid);
              if (staleSocket) staleSocket.disconnect(true);
            }
          }
        }

        ctx = { uid: user.id, username: user.username, worldName: uname, isAdmin: user.is_admin };
        socket.join(`world:${uname}`);
        const spawnX = live.isMatrix ? live.mainSpawn.x * 32 : DOOR_TX * 32;
        const spawnY = live.isMatrix ? live.mainSpawn.y * 32 : DOOR_TY * 32;
        onlineUsers.set(user.username.toLowerCase(), { socketId: socket.id, uid: user.id, username: user.username, worldName: uname, isAdmin: user.is_admin });
        live.players.set(socket.id, {
          uid: user.id, username: user.username, x: spawnX, y: spawnY, dir: 1, anim: 'idle',
          worn: user.worn || {}, health: 10, maxSlots: MAX_INVENTORY_SLOTS,
        });

        ack && ack({
          ok: true,
          you: { id: socket.id, uid: user.id, username: user.username, gems: user.gems, inventory: user.inventory, worn: user.worn, isAdmin: user.is_admin, spawnX, spawnY },
          world: {
            name: uname, ownerId: live.ownerId, ownerUsername: live.ownerUsername,
            locked: live.locked, lockType: live.lockType, access: live.access,
            tiles: live.tiles, plants: live.plants, drops: live.drops,
            shops: live.shops.map(({_busy, ...s}) => s),
            isOwner: live.ownerId === user.id,
            isMatrix: !!live.isMatrix,
            npcs: live.isMatrix ? live.npcs : undefined,
            booths: live.isMatrix ? live.booths : undefined,
            doorTx: live.isMatrix ? MATRIX_DOOR_TX : DOOR_TX,
            doorTy: live.isMatrix ? MATRIX_DOOR_TY : DOOR_TY,
          },
          players: Array.from(live.players.entries())
            .filter(([sid]) => sid !== socket.id)
            .map(([sid, p]) => ({ id: sid, uid: p.uid, username: p.username, x: p.x, y: p.y, dir: p.dir, worn: p.worn })),
        });

        socket.to(`world:${uname}`).emit('player:join', {
          id: socket.id, uid: user.id, username: user.username, x: 30 * 32, y: 5 * 32, dir: 1, worn: user.worn,
        });
      } catch (e) {
        console.error('auth:join error', e.message);
        ack && ack({ error: 'Oturum geçersiz, tekrar giriş yap.' });
      }
    });

    socket.on('player:move', (data) => {
      if (!ctx) return;
      const live = liveWorlds.get(ctx.worldName);
      if (!live) return;
      const p = live.players.get(socket.id);
      if (!p) return;
      p.x = data.x; p.y = data.y; p.dir = data.dir; p.anim = data.anim;
      socket.to(`world:${ctx.worldName}`).emit('player:moved', { id: socket.id, x: p.x, y: p.y, dir: p.dir, anim: p.anim });

      // Hazard damage check (lava, vb.)
      const tx = Math.floor(p.x / 32);
      const ty = Math.floor(p.y / 32);
      const tileId = live.tiles[ty] && live.tiles[ty][tx];
      const tileDef = tileId ? ITEMS[tileId] : null;
      if (tileDef && tileDef.hazard && !p._hazardCooldown) {
        p._hazardCooldown = true;
        setTimeout(() => { if (p) p._hazardCooldown = false; }, 800);
        p.health = Math.max(0, (p.health ?? 10) - 2);
        io.to(socket.id).emit('player:damage', { health: p.health, maxHealth: 10, source: tileDef.name });
        if (p.health <= 0) {
          p.health = 10; // reset immediately to prevent spam
          io.to(`world:${ctx.worldName}`).emit('player:death', { id: socket.id, username: ctx.username });
          // Respawn after 5 seconds
          setTimeout(() => {
            const live2 = liveWorlds.get(ctx.worldName);
            const p2 = live2 && live2.players.get(socket.id);
            if (!p2) return;
            p2.x = DOOR_TX * 32; p2.y = DOOR_TY * 32; p2.health = 10;
            io.to(`world:${ctx.worldName}`).emit('player:respawn', { id: socket.id, x: p2.x, y: p2.y });
          }, 5000);
        }
      }
    });

    // Wrench: kendi üzerine kullanılırsa envanter açar, başka oyuncuya kullanılırsa trade başlatır
    socket.on('wrench:use', (data, ack) => {
      if (!ctx) return;
      const targetSocketId = data && data.targetSocketId;
      if (!targetSocketId || targetSocketId === socket.id) {
        return ack && ack({ ok: true, action: 'openInventory' });
      }
      const live = liveWorlds.get(ctx.worldName);
      if (!live) return ack && ack({ error: 'Dünya bulunamadı.' });
      const target = live.players.get(targetSocketId);
      if (!target) return ack && ack({ error: 'Oyuncu bulunamadı.' });
      // trade isteği gönder
      io.to(targetSocketId).emit('trade:incoming', { fromSocketId: socket.id, fromUsername: ctx.username });
      ack && ack({ ok: true, action: 'tradeRequested', targetUsername: target.username });
    });

    // Envanter slot satın alma: 1000 gem = +10 slot, max 5 satın alma
    socket.on('shop:buySlot', async (data, ack) => {
      if (!ctx) return;
      const userRes = await pool.query('SELECT gems FROM users WHERE id=$1', [ctx.uid]);
      let { gems } = userRes.rows[0];
      const purchaseKey = `slotPurchases_${ctx.uid}`;
      let purchases = mutedUsers.get(purchaseKey) || 0; // geçici in-memory sayaç
      if (purchases >= MAX_SLOT_PURCHASES) return ack && ack({ error: 'Maksimum 5 slot paketi satın alabilirsin.' });
      if (gems < SLOT_COST_GEMS) return ack && ack({ error: `${SLOT_COST_GEMS} gem gerekli.` });
      gems -= SLOT_COST_GEMS;
      purchases += 1;
      mutedUsers.set(purchaseKey, purchases);
      await persistUserRow(ctx.uid, { gems });
      const newMaxSlots = MAX_INVENTORY_SLOTS + purchases * SLOT_PURCHASE_SIZE;
      ack && ack({ ok: true, gems, newMaxSlots, purchases });
    });



    socket.on('block:break', async ({ tx, ty }, ack) => {
      if (!ctx) return;
      const live = liveWorlds.get(ctx.worldName);
      if (!live) return;
      if (ty < 0 || ty >= live.tiles.length || tx < 0 || tx >= live.tiles[0].length) return ack && ack({ error: 'Geçersiz konum.' });
      if (!inReach(live, socket.id, tx, ty)) return ack && ack({ error: 'Çok uzak.' });
      if (!canBuildAt(live, ctx.uid, ctx.username)) return ack && ack({ error: 'Bu dünya kilitli.' });

      const id = live.tiles[ty][tx];
      if (!id) return ack && ack({ ok: true, broken: false, empty: true });
      const def = ITEMS[id];
      if (!def || def.unbreak) return ack && ack({ ok: true, broken: false, unbreakable: true });

      const key = `${tx},${ty}`;
      const hits = (live.hits.get(key) || 0) + 1;
      if (hits < def.hp) {
        live.hits.set(key, hits);
        io.to(`world:${ctx.worldName}`).emit('block:hit', { tx, ty, hits, hp: def.hp });
        return ack && ack({ ok: true, broken: false, hits, hp: def.hp });
      }
      live.hits.delete(key);
      live.tiles[ty][tx] = null;
      live.dirty = true;

      if (id === 'worldlock') {
        live.locked = false; live.lockType = null; live.access = [];
        io.to(`world:${ctx.worldName}`).emit('world:lockChanged', { locked: false });
      }
      if (id === 'shop_stand') {
        const shopId = `shop_${tx}_${ty}`;
        const shop = live.shops.find(s => s.id === shopId);
        if (shop) {
          // dükkan kırılınca satılmamış stok sahibinin envanterine iade edilir (item kaybı olmasın)
          const ownerRes = await pool.query('SELECT inventory FROM users WHERE id=$1', [shop.ownerId]);
          if (ownerRes.rows.length) {
            const ownerInv = ownerRes.rows[0].inventory;
            for (const listing of shop.listings) { if (listing.stock > 0) invAdd(ownerInv, listing.itemId, listing.stock); }
            await persistUserRow(shop.ownerId, { inventory: ownerInv });
          }
          live.shops = live.shops.filter(s => s.id !== shopId);
          io.to(`world:${ctx.worldName}`).emit('shop:removed', { shopId });
        }
      }

      let drops = [];
      const mkDrop = (itemId, count) => ({ itemId, count, tx, ty, id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}` });
      if (def.gemDrop && Math.random() < 0.55) {
        drops.push(mkDrop('gem', randInt(def.gemDrop[0], def.gemDrop[1])));
      }
      if (!def.noBlockDrop && Math.random() < 0.35) {
        drops.push(mkDrop(id, 1));
      }
      if (def.seedDrop && Math.random() < (def.seedDropChance || 0)) {
        drops.push(mkDrop(def.seedDrop, 1));
      }
      drops.forEach(d => live.drops.push(d));

      io.to(`world:${ctx.worldName}`).emit('block:broken', { tx, ty, drops });
      ack && ack({ ok: true, broken: true, drops });
    });

    socket.on('block:place', async ({ tx, ty, itemId }, ack) => {
      if (!ctx) return;
      const live = liveWorlds.get(ctx.worldName);
      if (!live) return;
      if (ty < 0 || ty >= live.tiles.length || tx < 0 || tx >= live.tiles[0].length) return ack && ack({ error: 'Geçersiz konum.' });
      if (!inReach(live, socket.id, tx, ty)) return ack && ack({ error: 'Çok uzak.' });
      if (!canBuildAt(live, ctx.uid, ctx.username)) return ack && ack({ error: 'Bu dünya kilitli.' });
      if (live.tiles[ty][tx]) return ack && ack({ error: 'Burada zaten bir blok var.' });
      if (tx === DOOR_TX && ty === DOOR_TY) return ack && ack({ error: 'Buraya (çıkış kapısı) blok koyamazsın.' });
      const tileRect = { x1: tx * 32, y1: ty * 32, x2: tx * 32 + 32, y2: ty * 32 + 32 };
      for (const [sid, p] of live.players) {
        if (sid === socket.id) continue;
        const pRect = { x1: p.x - 10, y1: p.y - 16, x2: p.x + 10, y2: p.y + 16 };
        if (pRect.x1 < tileRect.x2 && pRect.x2 > tileRect.x1 && pRect.y1 < tileRect.y2 && pRect.y2 > tileRect.y1) {
          return ack && ack({ error: 'Burada bir oyuncu var, üzerine blok koyamazsın.' });
        }
      }
      const def = ITEMS[itemId];
      if (!def || (def.type !== 'block' && def.type !== 'lock')) return ack && ack({ error: 'Bu eşya yerleştirilemez.' });

      const userRes = await pool.query('SELECT inventory FROM users WHERE id=$1', [ctx.uid]);
      const inventory = userRes.rows[0].inventory;
      if (!invRemove(inventory, itemId, 1)) return ack && ack({ error: 'Envanterinde bu eşyadan yok.' });
      await persistUserRow(ctx.uid, { inventory });

      live.tiles[ty][tx] = itemId;
      live.dirty = true;
      if (itemId === 'worldlock') {
        live.locked = true; live.lockType = 'worldlock'; live.access = [];
        live.ownerId = ctx.uid; live.ownerUsername = ctx.username;
        await pool.query('UPDATE worlds SET owner_id=$1 WHERE id=$2', [ctx.uid, live.id]);
        io.to(`world:${ctx.worldName}`).emit('world:lockChanged', { locked: true, ownerId: live.ownerId, ownerUsername: live.ownerUsername });
      }
      if (itemId === 'shop_stand') {
        const shopId = `shop_${tx}_${ty}`;
        if (!live.shops.find(s => s.id === shopId)) {
          live.shops.push({ id: shopId, tx, ty, ownerId: ctx.uid, ownerUsername: ctx.username, listings: [], _busy: false });
        }
      }
      io.to(`world:${ctx.worldName}`).emit('block:placed', { tx, ty, itemId });
      ack && ack({ ok: true, inventory });
    });

    socket.on('drop:collect', async ({ id }, ack) => {
      if (!ctx) return;
      const live = liveWorlds.get(ctx.worldName);
      if (!live) return;
      const idx = live.drops.findIndex(d => d.id === id);
      if (idx === -1) return ack && ack({ error: 'Drop artık orada değil.' });
      const drop = live.drops[idx];
      live.drops.splice(idx, 1);
      live.dirty = true;

      const userRes = await pool.query('SELECT gems, inventory FROM users WHERE id=$1', [ctx.uid]);
      let { gems, inventory } = userRes.rows[0];
      if (drop.itemId === 'gem') gems += drop.count;
      else invAdd(inventory, drop.itemId, drop.count);
      await persistUserRow(ctx.uid, { gems, inventory });

      io.to(`world:${ctx.worldName}`).emit('drop:removed', { id });
      ack && ack({ ok: true, gems, inventory });
    });

    socket.on('plant:seed', async ({ tx, ty, itemId }, ack) => {
      if (!ctx) return;
      const live = liveWorlds.get(ctx.worldName);
      if (!live) return;
      if (!inReach(live, socket.id, tx, ty)) return ack && ack({ error: 'Çok uzak.' });
      if (!canBuildAt(live, ctx.uid, ctx.username)) return ack && ack({ error: 'Bu dünya kilitli.' });
      const below = live.tiles[ty + 1] ? live.tiles[ty + 1][tx] : null;
      const belowDef = below && ITEMS[below];
      if (!belowDef || belowDef.type !== 'block') return ack && ack({ error: 'Tohum ancak toprak üzerine ekilir.' });
      if (live.tiles[ty][tx]) return ack && ack({ error: 'Burası dolu.' });
      if (live.plants.find(p => p.tx === tx && p.ty === ty)) return ack && ack({ error: 'Burada zaten bir bitki var.' });
      const def = ITEMS[itemId];
      if (!def || def.type !== 'seed') return ack && ack({ error: 'Bu bir tohum değil.' });

      const userRes = await pool.query('SELECT inventory FROM users WHERE id=$1', [ctx.uid]);
      const inventory = userRes.rows[0].inventory;
      if (!invRemove(inventory, itemId, 1)) return ack && ack({ error: 'Bu tohumdan yok.' });
      await persistUserRow(ctx.uid, { inventory });

      const plant = { tx, ty, seedId: itemId, plantedAt: Date.now() };
      live.plants.push(plant);
      live.dirty = true;
      io.to(`world:${ctx.worldName}`).emit('plant:added', plant);
      ack && ack({ ok: true, inventory });
    });

    socket.on('plant:break', async ({ tx, ty }, ack) => {
      if (!ctx) return;
      const live = liveWorlds.get(ctx.worldName);
      if (!live) return;
      if (!inReach(live, socket.id, tx, ty)) return ack && ack({ error: 'Çok uzak.' });
      const idx = live.plants.findIndex(p => p.tx === tx && p.ty === ty);
      if (idx === -1) return ack && ack({ error: 'Bitki yok.' });
      const plant = live.plants[idx];
      const seedDef = ITEMS[plant.seedId];
      const ready = Date.now() >= plant.plantedAt + seedDef.growSeconds * 1000;

      const key = `plant:${tx},${ty}`;
      const needed = ready ? 3 : 2;
      const hits = (live.hits.get(key) || 0) + 1;
      if (hits < needed) {
        live.hits.set(key, hits);
        io.to(`world:${ctx.worldName}`).emit('block:hit', { tx, ty, hits, hp: needed });
        return ack && ack({ ok: true, broken: false, hits, hp: needed });
      }
      live.hits.delete(key);
      live.plants.splice(idx, 1);
      live.dirty = true;

      const drops = [];
      const mkDrop = (itemId, count) => ({ itemId, count, tx, ty, id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}` });
      if (ready) {
        if (Math.random() < 0.6) drops.push(mkDrop('gem', randInt(seedDef.rarity, seedDef.rarity * 3)));
        if (Math.random() < 0.75) drops.push(mkDrop(seedDef.fruit, 1));
        if (Math.random() < 0.25) drops.push(mkDrop(plant.seedId, 1)); // bazen tohumun kendisi de geri düşer
      } else {
        if (Math.random() < 0.8) drops.push(mkDrop(plant.seedId, 1)); // olgunlaşmadan sökülünce çoğunlukla tohum geri düşer
      }
      drops.forEach(d => live.drops.push(d));

      io.to(`world:${ctx.worldName}`).emit('plant:removed', { tx, ty });
      io.to(`world:${ctx.worldName}`).emit('block:broken', { tx, ty, drops, isPlant: true });
      ack && ack({ ok: true, broken: true, drops });
    });

    socket.on('lock:addAccess', async ({ username, role }, ack) => {
      if (!ctx) return;
      const live = liveWorlds.get(ctx.worldName);
      if (!live) return ack && ack({ error: 'Dünya bulunamadı.' });
      if (!canManageAccess(live, ctx.uid, ctx.username)) return ack && ack({ error: 'Bu yetkiye sahip değilsin.' });
      const r = await pool.query('SELECT id, username FROM users WHERE username=$1', [String(username).toLowerCase()]);
      if (!r.rows.length) return ack && ack({ error: 'Kullanıcı bulunamadı.' });
      const uname = r.rows[0].username;
      // sadece OWNER bir kullanıcıyı CO_OWNER veya BANNED yapabilir; BUILDER ise CO_OWNER de sadece VISITOR/BUILDER verebilir
      let finalRole = ROLE_BUILDER;
      if (role === ROLE_CO_OWNER || role === ROLE_BANNED) {
        if (live.ownerId !== ctx.uid) return ack && ack({ error: 'Sadece dünya sahibi bu rolü verebilir.' });
        finalRole = role;
      } else if (role === ROLE_VISITOR || role === ROLE_BUILDER) {
        finalRole = role;
      }
      const existing = findAccessEntry(live, uname);
      if (existing) existing.role = finalRole;
      else live.access.push({ username: uname, role: finalRole });
      live.dirty = true;
      io.to(`world:${ctx.worldName}`).emit('world:accessUpdated', { access: live.access });
      ack && ack({ ok: true, access: live.access });
    });

    socket.on('store:buy', async ({ itemId }, ack) => {
      if (!ctx) return;
      const item = STORE_ITEMS.find(i => i.id === itemId);
      if (!item) return ack && ack({ error: 'Bu eşya markette yok.' });
      const userRes = await pool.query('SELECT gems, inventory FROM users WHERE id=$1', [ctx.uid]);
      let { gems, inventory } = userRes.rows[0];
      if (gems < item.price) return ack && ack({ error: 'Yeterli gemin yok.' });
      gems -= item.price;
      invAdd(inventory, itemId, item.qty || 1);
      await persistUserRow(ctx.uid, { gems, inventory });
      ack && ack({ ok: true, gems, inventory });
    });

    socket.on('admin:setgems', async ({ amount }, ack) => {
      if (!ctx || !ctx.isAdmin) return ack && ack({ error: 'Yetkin yok.' });
      const gems = Math.max(0, parseInt(amount) || 0);
      await persistUserRow(ctx.uid, { gems });
      ack && ack({ ok: true, gems });
    });

    socket.on('admin:giveitem', async ({ itemId, count }, ack) => {
      if (!ctx || !ctx.isAdmin) return ack && ack({ error: 'Yetkin yok.' });
      if (!ITEMS[itemId]) return ack && ack({ error: 'Böyle bir eşya yok.' });
      const userRes = await pool.query('SELECT inventory FROM users WHERE id=$1', [ctx.uid]);
      const inventory = userRes.rows[0].inventory;
      invAdd(inventory, itemId, Math.max(1, parseInt(count) || 1));
      await persistUserRow(ctx.uid, { inventory });
      ack && ack({ ok: true, inventory });
    });

    socket.on('item:openpack', async ({ itemId }, ack) => {
      if (!ctx) return;
      const validPacks = ['seedpack', 'pack_ssp', 'pack_lsp', 'pack_sip', 'pack_wearables'];
      if (!validPacks.includes(itemId)) return ack && ack({ error: 'Bu eşya açılamaz.' });
      const userRes = await pool.query('SELECT inventory FROM users WHERE id=$1', [ctx.uid]);
      const inventory = userRes.rows[0].inventory;
      if (!invRemove(inventory, itemId, 1)) return ack && ack({ error: `Envanterinde ${itemId} yok.` });
      
      const openedItems = [];
      if (itemId === 'seedpack') {
        SEEDPACK_TABLE.forEach(entry => { invAdd(inventory, entry.id, entry.count); openedItems.push(entry); });
      } else if (itemId === 'pack_ssp') {
        const items = [{ id: 'seed_pepper', count: 3 }, { id: 'seed_stone_common', count: 3 }, { id: 'elem_dirt', count: 2 }, { id: 'elem_water', count: 2 }];
        items.forEach(e => { invAdd(inventory, e.id, e.count); openedItems.push(e); });
      } else if (itemId === 'pack_lsp') {
        const items = [{ id: 'seed_rare', count: 3 }, { id: 'seed_copper', count: 5 }, { id: 'seed_iron', count: 5 }, { id: 'seed_coal', count: 5 }, { id: 'seed_gold', count: 2 }];
        items.forEach(e => { invAdd(inventory, e.id, e.count); openedItems.push(e); });
      } else if (itemId === 'pack_sip') {
        const items = [{ id: 'dirt', count: 20 }, { id: 'wood_block', count: 10 }, { id: 'brick', count: 5 }, { id: 'ladder', count: 5 }];
        items.forEach(e => { invAdd(inventory, e.id, e.count); openedItems.push(e); });
      } else if (itemId === 'pack_wearables') {
        const wearablesPool = ['wings_basic', 'wings_fire', 'wings_crystal', 'wings_shadow', 'item_robot_armor', 'item_metal_glove'];
        const chosen = wearablesPool[Math.floor(Math.random() * wearablesPool.length)];
        invAdd(inventory, chosen, 1);
        openedItems.push({ id: chosen, count: 1 });
      }

      await persistUserRow(ctx.uid, { inventory });
      ack && ack({ ok: true, inventory, opened: openedItems });
    });

    // Kilit dönüştürme: 100 World Lock <-> 1 Diamond Lock, 100 Diamond Lock <-> 1 Blue Gem Lock
    socket.on('lock:convert', async ({ fromId, toId }, ack) => {
      if (!ctx) return;
      const userRes = await pool.query('SELECT inventory FROM users WHERE id=$1', [ctx.uid]);
      const inventory = userRes.rows[0].inventory;

      if (fromId === 'worldlock' && toId === 'diamondlock') {
        if (!invRemove(inventory, 'worldlock', 100)) return ack && ack({ error: '100 World Lock gerekli.' });
        invAdd(inventory, 'diamondlock', 1);
      } else if (fromId === 'diamondlock' && toId === 'worldlock') {
        if (!invRemove(inventory, 'diamondlock', 1)) return ack && ack({ error: 'Diamond Lock bulunamadı.' });
        invAdd(inventory, 'worldlock', 100);
      } else if (fromId === 'diamondlock' && toId === 'bluegemlock') {
        if (!invRemove(inventory, 'diamondlock', 100)) return ack && ack({ error: '100 Diamond Lock gerekli.' });
        invAdd(inventory, 'bluegemlock', 1);
      } else if (fromId === 'bluegemlock' && toId === 'diamondlock') {
        if (!invRemove(inventory, 'bluegemlock', 1)) return ack && ack({ error: 'Blue Gem Lock bulunamadı.' });
        invAdd(inventory, 'diamondlock', 100);
      } else {
        return ack && ack({ error: 'Geçersiz kilit dönüştürme işlemi.' });
      }

      await persistUserRow(ctx.uid, { inventory });
      ack && ack({ ok: true, inventory });
    });

    // Arkadaş sistemi socket istekleri
    socket.on('friend:list', async (_, ack) => {
      if (!ctx) return;
      try {
        const userRes = await pool.query('SELECT friends FROM users WHERE id=$1', [ctx.uid]);
        const friendsList = userRes.rows[0]?.friends || [];
        const result = friendsList.map(fname => {
          const onlineInfo = onlineUsers.get(String(fname).toLowerCase());
          return {
            username: fname,
            isOnline: !!onlineInfo,
            worldName: onlineInfo ? onlineInfo.worldName : null,
          };
        });
        ack && ack({ ok: true, friends: result });
      } catch (e) { ack && ack({ error: 'Arkadaş listesi alınamadı.' }); }
    });

    socket.on('friend:add', async ({ targetUsername }, ack) => {
      if (!ctx) return;
      const target = String(targetUsername || '').trim();
      if (!target || target.toLowerCase() === ctx.username.toLowerCase()) return ack && ack({ error: 'Geçersiz kullanıcı.' });
      try {
        const targetRes = await pool.query('SELECT id, username, friends FROM users WHERE LOWER(username)=$1', [target.toLowerCase()]);
        if (!targetRes.rows.length) return ack && ack({ error: 'Kullanıcı bulunamadı.' });
        const targetUser = targetRes.rows[0];

        const myRes = await pool.query('SELECT friends FROM users WHERE id=$1', [ctx.uid]);
        const myFriends = myRes.rows[0]?.friends || [];
        if (myFriends.includes(targetUser.username)) return ack && ack({ error: 'Bu kullanıcı zaten arkadaşınız.' });

        myFriends.push(targetUser.username);
        await pool.query('UPDATE users SET friends=$1 WHERE id=$2', [JSON.stringify(myFriends), ctx.uid]);

        const targetFriends = targetUser.friends || [];
        if (!targetFriends.includes(ctx.username)) {
          targetFriends.push(ctx.username);
          await pool.query('UPDATE users SET friends=$1 WHERE id=$2', [JSON.stringify(targetFriends), targetUser.id]);
        }

        ack && ack({ ok: true, added: targetUser.username });
      } catch (e) { ack && ack({ error: 'Arkadaş eklenemedi.' }); }
    });

    socket.on('craft:combine', async ({ itemIds }, ack) => {
      if (!ctx) return;
      if (!Array.isArray(itemIds) || itemIds.length < 2 || itemIds.length > 3) {
        return ack && ack({ error: '2 veya 3 eşya seçmelisin.' });
      }
      const result = craftResult(itemIds);
      if (!result) return ack && ack({ error: 'Bu eşyalar birleşmiyor (geçerli bir tarif değil).' });
      if (LATHE_ONLY_RESULTS.has(result)) {
        const live = liveWorlds.get(ctx.worldName);
        const p = live && live.players.get(socket.id);
        let nearLathe = false;
        if (p && live) {
          const ptx = Math.floor(p.x / 32), pty = Math.floor(p.y / 32);
          for (let dy = -3; dy <= 3 && !nearLathe; dy++) {
            for (let dx = -3; dx <= 3; dx++) {
              const ty = pty + dy, tx = ptx + dx;
              if (live.tiles[ty] && live.tiles[ty][tx] === 'lathe') { nearLathe = true; break; }
            }
          }
        }
        if (!nearLathe) return ack && ack({ error: 'Bu eşya için bir Torna Bloğu\'nun yanında olman lazım.' });
      }
      const userRes = await pool.query('SELECT inventory FROM users WHERE id=$1', [ctx.uid]);
      const inventory = userRes.rows[0].inventory;
      // önce hepsinin yeterli olduğunu kontrol et, sonra hepsini birden düş (yarım işlemi önlemek için)
      for (const id of itemIds) {
        const row = inventory.find(i => i.id === id);
        if (!row || row.count < 1) return ack && ack({ error: `${(ITEMS[id] || {}).name || id} yeterli değil.` });
      }
      itemIds.forEach(id => invRemove(inventory, id, 1));
      invAdd(inventory, result, 1);
      await persistUserRow(ctx.uid, { inventory });
      ack && ack({ ok: true, inventory, result });
    });

    socket.on('inventory:equip', async ({ itemId, equip }, ack) => {
      if (!ctx) return;
      const userRes = await pool.query('SELECT inventory, worn FROM users WHERE id=$1', [ctx.uid]);
      const inventory = userRes.rows[0].inventory;
      const worn = userRes.rows[0].worn || {};
      const def = ITEMS[itemId];
      if (!def || !def.wearable) return ack && ack({ error: 'Bu giyilemez.' });
      if (equip) {
        if (!invRemove(inventory, itemId, 1)) return ack && ack({ error: 'Envanterinde bu eşyadan yok.' });
        const previous = worn[def.type];
        if (previous && previous !== itemId) invAdd(inventory, previous, 1); // önceki giyilen eşya envantere geri dönsün
        worn[def.type] = itemId;
      } else {
        if (worn[def.type] !== itemId) return ack && ack({ error: 'Bu eşya zaten giyili değil.' });
        worn[def.type] = null;
        invAdd(inventory, itemId, 1);
      }
      await persistUserRow(ctx.uid, { inventory, worn });
      const live = liveWorlds.get(ctx.worldName);
      if (live) {
        const p = live.players.get(socket.id);
        if (p) { p.worn = worn; io.to(`world:${ctx.worldName}`).emit('player:wornChanged', { id: socket.id, worn }); }
      }
      ack && ack({ ok: true, worn, inventory });
    });

    socket.on('inventory:drop', async ({ itemId, count }, ack) => {
      if (!ctx) return;
      const def = ITEMS[itemId];
      if (!def || def.droppable === false) return ack && ack({ error: 'Bu eşya yere bırakılamaz.' });
      const live = liveWorlds.get(ctx.worldName);
      if (!live) return;
      const userRes = await pool.query('SELECT inventory FROM users WHERE id=$1', [ctx.uid]);
      const inventory = userRes.rows[0].inventory;
      const n = Math.max(1, parseInt(count) || 1);
      if (!invRemove(inventory, itemId, n)) return ack && ack({ error: 'Envanterinde bu kadar yok.' });
      await persistUserRow(ctx.uid, { inventory });

      const p = live.players.get(socket.id);
      const facing = p && p.dir ? p.dir : 1;
      const tx = p ? Math.floor(p.x / 32) + facing : 0, ty = p ? Math.floor(p.y / 32) : 0;
      const dropObj = { itemId, count: n, tx, ty, id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}` };
      live.drops.push(dropObj); live.dirty = true;
      io.to(`world:${ctx.worldName}`).emit('drop:spawned', dropObj);
      ack && ack({ ok: true, inventory });
    });

    socket.on('inventory:trash', async ({ itemId, count }, ack) => {
      if (!ctx) return;
      const userRes = await pool.query('SELECT inventory FROM users WHERE id=$1', [ctx.uid]);
      const inventory = userRes.rows[0].inventory;
      const n = Math.max(1, parseInt(count) || 1);
      if (!invRemove(inventory, itemId, n)) return ack && ack({ error: 'Envanterinde bu kadar yok.' });
      await persistUserRow(ctx.uid, { inventory });
      ack && ack({ ok: true, inventory });
    });

    socket.on('lock:removeAccess', async ({ username }, ack) => {
      if (!ctx) return;
      const live = liveWorlds.get(ctx.worldName);
      if (!live) return ack && ack({ error: 'Dünya bulunamadı.' });
      if (!canManageAccess(live, ctx.uid, ctx.username)) return ack && ack({ error: 'Bu yetkiye sahip değilsin.' });
      const uname = String(username).toLowerCase();
      const target = findAccessEntry(live, uname);
      // BUILDER-seviyesi yönetici (CO_OWNER) başka bir CO_OWNER'ı çıkaramaz, sadece sahibi çıkarabilir
      if (target && target.role === ROLE_CO_OWNER && live.ownerId !== ctx.uid) {
        return ack && ack({ error: 'Sadece dünya sahibi bir Co-Owner\'ı çıkarabilir.' });
      }
      live.access = live.access.filter(e => e.username !== uname);
      live.dirty = true;
      io.to(`world:${ctx.worldName}`).emit('world:accessUpdated', { access: live.access });
      ack && ack({ ok: true, access: live.access });
    });

    // Basit spam koruması: kullanıcı başına kısa pencere içinde mesaj sayısı sınırlanır.
    const chatRate = { count: 0, windowStart: Date.now() };
    socket.on('chat:send', async (data) => {
      if (!ctx) return;
      const text = String(data.text || '').slice(0, 140).trim();
      if (!text) return;

      // rate limit: 8 saniyede en fazla 6 mesaj/komut
      const now = Date.now();
      if (now - chatRate.windowStart > 8000) { chatRate.windowStart = now; chatRate.count = 0; }
      chatRate.count++;
      if (chatRate.count > 6) return socket.emit('chat:message', { channel: 'world', who: 'Sistem', text: 'Çok hızlı mesaj gönderiyorsun, biraz yavaşla.', ts: now });

      if (text.startsWith('/')) {
        return handleChatCommand(text, data.channel, ack => socket.emit('chat:message', { channel: 'world', who: 'Sistem', text: ack, ts: Date.now() }));
      }

      // mute kontrolü (komut olmayan normal mesajlar için)
      const muteUntil = mutedUsers.get(ctx.username.toLowerCase());
      if (muteUntil && muteUntil > now) {
        const secs = Math.ceil((muteUntil - now) / 1000);
        return socket.emit('chat:message', { channel: 'world', who: 'Sistem', text: `Susturuldun, ${secs} saniye sonra tekrar yazabilirsin.`, ts: now });
      }

      const payload = { who: ctx.username, text, ts: now };
      if (data.channel === 'global') {
        io.emit('chat:message', { channel: 'global', ...payload });
      } else {
        io.to(`world:${ctx.worldName}`).emit('chat:message', { channel: 'world', ...payload });
      }
    });

    // Komut yönlendirme merkezi. Yeni bir komut eklemek için sadece bu switch'e bir case eklemek yeterli
    // (data-driven değil ama tek nokta — modüler handlers/chatCommands.js'e taşınabilir ileride).
    async function handleChatCommand(raw, channel, systemReply) {
      const parts = raw.slice(1).split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);
      const live = liveWorlds.get(ctx.worldName);

      switch (cmd) {
        case 'help': {
          const lines = ['/help — komut listesi', '/who — dünyandaki oyuncular', '/msg <kullanıcı> <mesaj> — özel mesaj', '/reply <mesaj> — son özel mesaja yanıt', '/status — hesap bilgin', '/sit — Matrix Sandalyesine otur'];
          if (live && live.ownerId === ctx.uid) lines.push('/kick <oyuncu> — dünyandan kicker (spawn kapısında yeniden doğar)', '/ban <oyuncu> — dünyandan banla', '/unban <oyuncu> — dünya banını kaldır');
          if (ctx.isAdmin) lines.push('/sban <kullanıcı> [dakika] — sunucudan banla (süresiz için boş bırak)', '/sunban <kullanıcı>', '/mute <kullanıcı> [dakika]', '/unmute <kullanıcı>');
          return systemReply(lines.join('\n'));
        }
        case 'who': {
          if (!live) return systemReply('Dünya bulunamadı.');
          const names = [...live.players.values()].map(p => p.username);
          return systemReply(names.length ? `Bu dünyada: ${names.join(', ')}` : 'Bu dünyada yalnızsın.');
        }
        case 'status': {
          const r = await pool.query('SELECT gems FROM users WHERE id=$1', [ctx.uid]);
          return systemReply(`${ctx.username} — ${r.rows[0].gems} Gems — Dünya: ${ctx.worldName}`);
        }
        case 'sit': {
          // /sit artık merkezi komut sisteminden geçiyor; asıl mantık chair:sit ile aynı, tekrar yazmamak için doğrudan çağırıyoruz.
          const result = await performChairSit();
          if (result.error) return systemReply(result.error);
          socket.emit('matrix:enter', { targetWorld: result.targetWorld });
          return;
        }
        case 'msg': {
          if (args.length < 2) return systemReply('Kullanım: /msg <kullanıcı> <mesaj>');
          const targetName = args[0].toLowerCase();
          const msgText = args.slice(1).join(' ').slice(0, 140);
          const target = onlineUsers.get(targetName);
          if (!target) return systemReply('Bu kullanıcı çevrimiçi değil.');
          if (targetName === ctx.username.toLowerCase()) return systemReply('Kendine mesaj gönderemezsin.');
          lastWhisperTarget.set(ctx.username.toLowerCase(), target.username);
          lastWhisperTarget.set(target.username.toLowerCase(), ctx.username);
          io.to(target.socketId).emit('chat:whisper', { from: ctx.username, text: msgText, ts: Date.now() });
          return systemReply(`(fısıltı → ${target.username}): ${msgText}`);
        }
        case 'reply': {
          if (!args.length) return systemReply('Kullanım: /reply <mesaj>');
          const lastTarget = lastWhisperTarget.get(ctx.username.toLowerCase());
          if (!lastTarget) return systemReply('Yanıtlanacak bir özel mesaj yok.');
          const target = onlineUsers.get(lastTarget.toLowerCase());
          if (!target) return systemReply(`${lastTarget} artık çevrimiçi değil.`);
          const msgText = args.join(' ').slice(0, 140);
          lastWhisperTarget.set(target.username.toLowerCase(), ctx.username);
          io.to(target.socketId).emit('chat:whisper', { from: ctx.username, text: msgText, ts: Date.now() });
          return systemReply(`(fısıltı → ${target.username}): ${msgText}`);
        }
        case 'kick': {
          // World-scoped: sadece bu dünyanın (WL/DL/BL vb. kilit türü fark etmez) OWNER'ı kullanabilir.
          // Kicklenen oyuncu dünyadan atılmaz, sadece "ölür" ve spawn kapısında yeniden doğar.
          if (!live) return systemReply('Dünya bulunamadı.');
          if (live.ownerId !== ctx.uid) return systemReply('Bu dünyada kick atma yetkin yok, sadece dünya sahibi kullanabilir.');
          if (!args.length) return systemReply('Kullanım: /kick <oyuncu ismi>');
          const targetName = args[0].toLowerCase();
          const targetEntry = [...live.players.entries()].find(([, p]) => p.username.toLowerCase() === targetName);
          if (!targetEntry) return systemReply('Bu oyuncu şu an bu dünyada değil.');
          const [targetSid, targetP] = targetEntry;
          if (targetP.uid === ctx.uid) return systemReply('Kendini kickleyemezsin.');
          targetP.x = DOOR_TX * 32; targetP.y = DOOR_TY * 32;
          io.to(`world:${ctx.worldName}`).emit('player:moved', { id: targetSid, x: targetP.x, y: targetP.y, dir: targetP.dir, anim: 'idle' });
          io.to(targetSid).emit('player:kicked', { x: targetP.x, y: targetP.y, reason: 'Kicklendin!' });
          return systemReply(`${targetP.username} kicklendi.`);
        }
        case 'ban': {
          // World-scoped: sadece bu dünyanın OWNER'ı kullanabilir.
          // Hedef, mevcut permission sistemindeki BANNED rolüne eklenir (access listesi) — /unban ile geri alınır.
          if (!live) return systemReply('Dünya bulunamadı.');
          if (live.ownerId !== ctx.uid) return systemReply('Bu dünyada ban atma yetkin yok, sadece dünya sahibi kullanabilir.');
          if (!args.length) return systemReply('Kullanım: /ban <oyuncu ismi>');
          const targetName = args[0].toLowerCase();
          if (targetName === ctx.username.toLowerCase()) return systemReply('Kendini banlayamazsın.');
          const r = await pool.query('SELECT id, username FROM users WHERE username=$1', [targetName]);
          if (!r.rows.length) return systemReply('Kullanıcı bulunamadı.');
          const uname = r.rows[0].username;
          const existing = findAccessEntry(live, uname);
          if (existing) existing.role = ROLE_BANNED;
          else live.access.push({ username: uname, role: ROLE_BANNED });
          live.dirty = true;
          io.to(`world:${ctx.worldName}`).emit('world:accessUpdated', { access: live.access });
          // dünyadaysa hemen kapıya at ve bilgilendir
          const targetEntry = [...live.players.entries()].find(([, p]) => p.username.toLowerCase() === targetName);
          if (targetEntry) {
            const [targetSid, targetP] = targetEntry;
            targetP.x = DOOR_TX * 32; targetP.y = DOOR_TY * 32;
            io.to(`world:${ctx.worldName}`).emit('player:moved', { id: targetSid, x: targetP.x, y: targetP.y, dir: targetP.dir, anim: 'idle' });
            io.to(targetSid).emit('player:kicked', { x: targetP.x, y: targetP.y, reason: 'Banlandın!' });
            io.to(targetSid).emit('chat:message', { channel: 'world', who: 'Sistem', text: 'Bu dünyadan banlandın, /unban yapılana kadar giremeyeceksin.', ts: Date.now() });
          }
          return systemReply(`${uname} bu dünyadan banlandı.`);
        }
        case 'unban': {
          // World-scoped unban: dünya sahibi BANNED rolünü kaldırır.
          if (!live) return systemReply('Dünya bulunamadı.');
          if (live.ownerId !== ctx.uid) return systemReply('Bu dünyada unban yetkin yok, sadece dünya sahibi kullanabilir.');
          if (!args.length) return systemReply('Kullanım: /unban <oyuncu ismi>');
          const targetName = args[0].toLowerCase();
          const before = live.access.length;
          live.access = live.access.filter(e => !(e.username === targetName && e.role === ROLE_BANNED));
          if (live.access.length === before) return systemReply('Bu oyuncu bu dünyada banlı değil.');
          live.dirty = true;
          io.to(`world:${ctx.worldName}`).emit('world:accessUpdated', { access: live.access });
          return systemReply(`${targetName} bu dünyanın banından çıkarıldı.`);
        }
        case 'sban': {
          // Global admin banı: sunucu geneli, kalıcı (DB'de banned_until), belirli süreli.
          if (!ctx.isAdmin) return systemReply('Bu komutu kullanma yetkin yok.');
          if (!args.length) return systemReply('Kullanım: /sban <kullanıcı> [dakika, boş=kalıcı]');
          const targetName = args[0].toLowerCase();
          if (targetName === ctx.username.toLowerCase()) return systemReply('Kendini banlayamazsın.');
          const r = await pool.query('SELECT id, username FROM users WHERE username=$1', [targetName]);
          if (!r.rows.length) return systemReply('Kullanıcı bulunamadı.');
          const minutesArg = args[1] ? parseInt(args[1]) : null;
          const bannedUntil = minutesArg ? new Date(Date.now() + minutesArg * 60000) : new Date('9999-12-31');
          await pool.query('UPDATE users SET banned_until=$1 WHERE id=$2', [bannedUntil, r.rows[0].id]);
          const target = onlineUsers.get(targetName);
          if (target) {
            io.to(target.socketId).emit('chat:message', { channel: 'world', who: 'Sistem', text: minutesArg ? `Sunucudan ${minutesArg} dakikalığına banlandın.` : 'Sunucudan kalıcı olarak banlandın.', ts: Date.now() });
            io.sockets.sockets.get(target.socketId)?.disconnect(true);
          }
          return systemReply(minutesArg ? `${r.rows[0].username} sunucudan ${minutesArg} dakikalığına banlandı.` : `${r.rows[0].username} sunucudan kalıcı olarak banlandı.`);
        }
        case 'sunban': {
          if (!ctx.isAdmin) return systemReply('Bu komutu kullanma yetkin yok.');
          if (!args.length) return systemReply('Kullanım: /sunban <kullanıcı>');
          const targetName = args[0].toLowerCase();
          const r = await pool.query('SELECT id FROM users WHERE username=$1', [targetName]);
          if (!r.rows.length) return systemReply('Kullanıcı bulunamadı.');
          await pool.query('UPDATE users SET banned_until=NULL WHERE id=$1', [r.rows[0].id]);
          return systemReply(`${args[0]} sunucu banı kaldırıldı.`);
        }
        case 'mute': {
          if (!ctx.isAdmin) return systemReply('Bu komutu kullanma yetkin yok.');
          if (!args.length) return systemReply('Kullanım: /mute <kullanıcı> [dakika]');
          const targetName = args[0].toLowerCase();
          const minutes = Math.max(1, parseInt(args[1]) || 10);
          mutedUsers.set(targetName, Date.now() + minutes * 60000);
          return systemReply(`${args[0]} ${minutes} dakikalığına susturuldu.`);
        }
        case 'unmute': {
          if (!ctx.isAdmin) return systemReply('Bu komutu kullanma yetkin yok.');
          if (!args.length) return systemReply('Kullanım: /unmute <kullanıcı>');
          mutedUsers.delete(args[0].toLowerCase());
          return systemReply(`${args[0]} susturması kaldırıldı.`);
        }
        default:
          return systemReply(`Bilinmeyen komut: /${cmd} — /help yazarak listeye bakabilirsin.`);
      }
    }

    socket.on('trade:request', (data, ack) => {
      if (!ctx) return;
      const live = liveWorlds.get(ctx.worldName);
      if (!live) return;
      const targetSocketId = data && data.targetSocketId;
      const target = live.players.get(targetSocketId);
      if (!target) return ack && ack({ error: 'Oyuncu bulunamadı.' });
      if (targetSocketId === socket.id) return ack && ack({ error: 'Kendine trade isteği gönderemezsin.' });
      io.to(targetSocketId).emit('trade:incoming', { fromSocketId: socket.id, fromUsername: ctx.username });
      ack && ack({ ok: true });
    });

    socket.on('trade:accept', (data, ack) => {
      if (!ctx) return;
      const withSocketId = data && data.withSocketId;
      const live = liveWorlds.get(ctx.worldName);
      const otherPlayer = live && live.players.get(withSocketId);
      if (!otherPlayer) return ack && ack({ error: 'Karşı taraf artık burada değil.' });
      for (const s of tradeSessions.values()) {
        if ([s.socketA, s.socketB].includes(socket.id) || [s.socketA, s.socketB].includes(withSocketId)) {
          return ack && ack({ error: 'Zaten aktif bir trade var.' });
        }
      }
      const sessionId = `${withSocketId}_${socket.id}_${Date.now()}`;
      const session = {
        socketA: withSocketId, socketB: socket.id,
        usernameA: otherPlayer.username, usernameB: ctx.username,
        offerA: [], offerB: [], readyA: false, readyB: false, confirmedA: false, confirmedB: false, reviewPhase: false,
      };
      tradeSessions.set(sessionId, session);
      io.to(withSocketId).emit('trade:started', { sessionId, otherUsername: ctx.username, youAreA: true });
      io.to(socket.id).emit('trade:started', { sessionId, otherUsername: otherPlayer.username, youAreA: false });
      ack && ack({ ok: true, sessionId });
    });

    async function tradeSetItem(sessionId, itemId, count, ack) {
      const session = tradeSessions.get(sessionId);
      if (!session || !ctx) return ack && ack({ error: 'Trade oturumu bulunamadı.' });
      const isA = session.socketA === socket.id;
      if (!isA && session.socketB !== socket.id) return ack && ack({ error: 'Bu trade sana ait değil.' });
      const n = Math.max(0, parseInt(count) || 0);
      if (n > 0) {
        const def = ITEMS[itemId];
        if (!def || def.tradeable === false) return ack && ack({ error: 'Bu eşya takas edilemez.' });
      }
      const userRes = await pool.query('SELECT inventory FROM users WHERE id=$1', [ctx.uid]);
      const owned = userRes.rows[0].inventory.find(i => i.id === itemId);
      if (n > 0 && (!owned || owned.count < n)) return ack && ack({ error: 'Envanterinde bu kadar yok.' });
      const offerKey = isA ? 'offerA' : 'offerB';
      session[offerKey] = session[offerKey].filter(i => i.id !== itemId);
      if (n > 0) session[offerKey].push({ id: itemId, count: n });
      session.readyA = false; session.readyB = false; session.reviewPhase = false;
      io.to(session.socketA).emit('trade:offerUpdated', { sessionId, offerA: session.offerA, offerB: session.offerB, readyA: false, readyB: false });
      io.to(session.socketB).emit('trade:offerUpdated', { sessionId, offerA: session.offerA, offerB: session.offerB, readyA: false, readyB: false });
      ack && ack({ ok: true });
    }
    socket.on('trade:setItem', ({ sessionId, itemId, count }, ack) => tradeSetItem(sessionId, itemId, count, ack));

    socket.on('trade:ready', ({ sessionId }, ack) => {
      const session = tradeSessions.get(sessionId);
      if (!session) return ack && ack({ error: 'Trade oturumu bulunamadı.' });
      const isA = session.socketA === socket.id;
      if (isA) session.readyA = true; else session.readyB = true;
      if (session.readyA && session.readyB) {
        session.reviewPhase = true; session.confirmedA = false; session.confirmedB = false;
        io.to(session.socketA).emit('trade:review', { sessionId, offerMine: session.offerA, offerTheirs: session.offerB, otherUsername: session.usernameA });
        io.to(session.socketB).emit('trade:review', { sessionId, offerMine: session.offerB, offerTheirs: session.offerA, otherUsername: session.usernameB });
      } else {
        io.to(session.socketA).emit('trade:offerUpdated', { sessionId, offerA: session.offerA, offerB: session.offerB, readyA: session.readyA, readyB: session.readyB });
        io.to(session.socketB).emit('trade:offerUpdated', { sessionId, offerA: session.offerA, offerB: session.offerB, readyA: session.readyA, readyB: session.readyB });
      }
      ack && ack({ ok: true });
    });

    socket.on('trade:confirm', async ({ sessionId }, ack) => {
      const session = tradeSessions.get(sessionId);
      if (!session || !session.reviewPhase) return ack && ack({ error: 'Trade oturumu bulunamadı.' });
      const isA = session.socketA === socket.id;
      if (isA) session.confirmedA = true; else session.confirmedB = true;
      if (!(session.confirmedA && session.confirmedB)) { ack && ack({ ok: true, waiting: true }); return; }

      // her iki tarafın da hâlâ teklif ettiği eşyalara sahip olduğunu doğrula (aradaki sürede harcamış olabilirler)
      const uidRes = await pool.query('SELECT id, username FROM users WHERE username=$1 OR username=$2', [session.usernameA.toLowerCase(), session.usernameB.toLowerCase()]);
      const uidA = uidRes.rows.find(r => r.username === session.usernameA.toLowerCase())?.id;
      const uidB = uidRes.rows.find(r => r.username === session.usernameB.toLowerCase())?.id;
      if (!uidA || !uidB) { tradeSessions.delete(sessionId); return ack && ack({ error: 'Kullanıcı bulunamadı.' }); }
      const invAres = await pool.query('SELECT inventory FROM users WHERE id=$1', [uidA]);
      const invBres = await pool.query('SELECT inventory FROM users WHERE id=$1', [uidB]);
      let invA = invAres.rows[0].inventory, invB = invBres.rows[0].inventory;
      const stillHas = (inv, offer) => offer.every(o => { const row = inv.find(i => i.id === o.id); return row && row.count >= o.count; });
      if (!stillHas(invA, session.offerA) || !stillHas(invB, session.offerB)) {
        tradeSessions.delete(sessionId);
        io.to(session.socketA).emit('trade:cancelled', { sessionId, reason: 'Eşyalar artık yeterli değil, trade iptal edildi.' });
        io.to(session.socketB).emit('trade:cancelled', { sessionId, reason: 'Eşyalar artık yeterli değil, trade iptal edildi.' });
        return ack && ack({ ok: false });
      }
      session.offerA.forEach(o => invRemove(invA, o.id, o.count));
      session.offerB.forEach(o => invRemove(invB, o.id, o.count));
      session.offerB.forEach(o => invAdd(invA, o.id, o.count));
      session.offerA.forEach(o => invAdd(invB, o.id, o.count));
      await persistUserRow(uidA, { inventory: invA });
      await persistUserRow(uidB, { inventory: invB });
      io.to(session.socketA).emit('trade:completed', { sessionId, yourInventory: invA });
      io.to(session.socketB).emit('trade:completed', { sessionId, yourInventory: invB });
      tradeSessions.delete(sessionId);
      ack && ack({ ok: true, done: true });
    });

    socket.on('trade:cancel', ({ sessionId }, ack) => {
      const session = tradeSessions.get(sessionId);
      if (!session) return ack && ack({ ok: true });
      io.to(session.socketA).emit('trade:cancelled', { sessionId, reason: 'Karşı taraf trade\'i iptal etti.' });
      io.to(session.socketB).emit('trade:cancelled', { sessionId, reason: 'Karşı taraf trade\'i iptal etti.' });
      tradeSessions.delete(sessionId);
      activeTradeId = null;
      ack && ack({ ok: true });
    });

    async function performChairSit() {
      const live = liveWorlds.get(ctx.worldName);
      if (!live) return { error: 'Dünya bulunamadı.' };
      if (live.isMatrix) return { error: 'Zaten Matrix\'tesin, çıkmak için kapıyı kullan.' };
      if (!live.locked) return { error: 'Bu sandalye sadece World Lock ile korunan bir dünyada çalışır.' };
      const p = live.players.get(socket.id);
      if (!p) return { error: 'Konum bulunamadı.' };
      const ptx = Math.floor(p.x / 32), pty = Math.floor(p.y / 32);
      let nearChair = false;
      for (let dy = -2; dy <= 2 && !nearChair; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ty = pty + dy, tx = ptx + dx;
          if (live.tiles[ty] && live.tiles[ty][tx] === 'matrix_chair') { nearChair = true; break; }
        }
      }
      if (!nearChair) return { error: 'Yakınında bir Matrix Sandalyesi yok.' };
      return { ok: true, targetWorld: GLOBAL_MATRIX_NAME };
    }
    socket.on('chair:sit', async (data, ack) => {
      if (!ctx) return;
      const result = await performChairSit();
      ack && ack(result);
    });

    // ---------- Player Shop ----------
    socket.on('shop:open', ({ shopId }, ack) => {
      if (!ctx) return;
      const live = liveWorlds.get(ctx.worldName);
      if (!live) return ack && ack({ error: 'Dünya bulunamadı.' });
      const shop = live.shops.find(s => s.id === shopId);
      if (!shop) return ack && ack({ error: 'Dükkan bulunamadı.' });
      ack && ack({ ok: true, shop: { id: shop.id, ownerId: shop.ownerId, ownerUsername: shop.ownerUsername, listings: shop.listings } });
    });

    // Dükkan sahibi (veya SHOP_MANAGER yetkili CO_OWNER) stok/fiyat belirler.
    // count=0 gönderilirse listing kaldırılır ve kalan stok sahibine iade edilir.
    socket.on('shop:setListing', async ({ shopId, itemId, price, addStock }, ack) => {
      if (!ctx) return;
      const live = liveWorlds.get(ctx.worldName);
      if (!live) return ack && ack({ error: 'Dünya bulunamadı.' });
      const shop = live.shops.find(s => s.id === shopId);
      if (!shop) return ack && ack({ error: 'Dükkan bulunamadı.' });
      const isManager = shop.ownerId === ctx.uid || live.ownerId === ctx.uid || canManageAccess(live, ctx.uid, ctx.username);
      if (!isManager) return ack && ack({ error: 'Bu dükkanı yönetme yetkin yok.' });

      const def = ITEMS[itemId];
      if (!def) return ack && ack({ error: 'Geçersiz eşya.' });
      if (def.sellable === false) return ack && ack({ error: 'Bu eşya satılamaz.' });
      const p = Math.max(0, parseInt(price) || 0);
      const addN = Math.max(0, parseInt(addStock) || 0);

      if (addN > 0) {
        // stok eklerken oyuncunun envanterinden gerçekten düşülür — sanal stok üretimi yok
        const userRes = await pool.query('SELECT inventory FROM users WHERE id=$1', [ctx.uid]);
        const inventory = userRes.rows[0].inventory;
        if (!invRemove(inventory, itemId, addN)) return ack && ack({ error: 'Envanterinde bu kadar yok.' });
        await persistUserRow(ctx.uid, { inventory });
      }

      let listing = shop.listings.find(l => l.itemId === itemId);
      if (!listing) { listing = { itemId, price: p, stock: 0 }; shop.listings.push(listing); }
      listing.price = p;
      listing.stock += addN;
      if (listing.stock <= 0 && addN === 0 && price === undefined) {
        shop.listings = shop.listings.filter(l => l.itemId !== itemId);
      }
      live.dirty = true;
      io.to(`world:${ctx.worldName}`).emit('shop:listingUpdated', { shopId, listings: shop.listings });
      ack && ack({ ok: true, listings: shop.listings });
    });

    // Satın alma: dükkanın _busy kilidiyle senkron (aynı stoktan iki oyuncu aynı anda alamaz),
    // envanterden/parasından düşme ve dükkan sahibine ödeme tek bir atomik DB transaction içinde.
    socket.on('shop:buy', async ({ shopId, itemId, count }, ack) => {
      if (!ctx) return;
      const live = liveWorlds.get(ctx.worldName);
      if (!live) return ack && ack({ error: 'Dünya bulunamadı.' });
      const shop = live.shops.find(s => s.id === shopId);
      if (!shop) return ack && ack({ error: 'Dükkan bulunamadı.' });
      if (shop.ownerId === ctx.uid) return ack && ack({ error: 'Kendi dükkanından alışveriş yapamazsın.' });
      if (shop._busy) return ack && ack({ error: 'Dükkan meşgul, tekrar dene.' });

      shop._busy = true;
      try {
        const listing = shop.listings.find(l => l.itemId === itemId);
        if (!listing) return ack && ack({ error: 'Bu eşya dükkanda yok.' });
        const n = Math.max(1, parseInt(count) || 1);
        if (listing.stock < n) return ack && ack({ error: 'Yetersiz stok.' });
        const totalPrice = listing.price * n;

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const buyerRes = await client.query('SELECT gems, inventory FROM users WHERE id=$1 FOR UPDATE', [ctx.uid]);
          const buyer = buyerRes.rows[0];
          if (buyer.gems < totalPrice) { await client.query('ROLLBACK'); return ack && ack({ error: 'Yetersiz Gems.' }); }
          const sellerRes = await client.query('SELECT gems FROM users WHERE id=$1 FOR UPDATE', [shop.ownerId]);
          if (!sellerRes.rows.length) { await client.query('ROLLBACK'); return ack && ack({ error: 'Dükkan sahibi bulunamadı.' }); }

          const buyerInv = buyer.inventory;
          invAdd(buyerInv, itemId, n);
          const newBuyerGems = buyer.gems - totalPrice;
          const newSellerGems = sellerRes.rows[0].gems + totalPrice;

          await client.query('UPDATE users SET gems=$1, inventory=$2 WHERE id=$3', [newBuyerGems, JSON.stringify(buyerInv), ctx.uid]);
          await client.query('UPDATE users SET gems=$1 WHERE id=$2', [newSellerGems, shop.ownerId]);
          await client.query(
            `INSERT INTO shop_transactions (world_name, shop_id, seller_id, buyer_id, item_id, quantity, unit_price, total_price) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [ctx.worldName, shopId, shop.ownerId, ctx.uid, itemId, n, listing.price, totalPrice]
          );
          await client.query('COMMIT');

          listing.stock -= n;
          if (listing.stock <= 0) shop.listings = shop.listings.filter(l => l.itemId !== itemId);
          live.dirty = true;

          io.to(`world:${ctx.worldName}`).emit('shop:listingUpdated', { shopId, listings: shop.listings });
          const sellerSocket = [...live.players.entries()].find(([, p]) => p.uid === shop.ownerId);
          if (sellerSocket) io.to(sellerSocket[0]).emit('shop:sale', { shopId, itemId, count: n, totalPrice, buyerUsername: ctx.username });

          ack && ack({ ok: true, gems: newBuyerGems, inventory: buyerInv });
        } catch (e) {
          await client.query('ROLLBACK');
          console.error('[shop:buy] transaction error', e);
          ack && ack({ error: 'İşlem başarısız oldu, tekrar dene.' });
        } finally {
          client.release();
        }
      } finally {
        shop._busy = false;
      }
    });


    // ---------- Matrix Görev Sistemi (Telephone Line & Courier) ----------
    // Mission World tamamen bellek-içi ve kişiye özeldir; DB'ye hiç yazılmaz (vizyon md.26).
    // Server "mission seed" üretir, client sadece server'ın gönderdiği tiles/spawn/enemy verisini render eder.
    const QUEST_DEFS = {
      telephone: { label: 'Telephone Line Connection', durationMs: 60000 },
      courier: { label: 'Courier Mission', durationMs: 120000 },
    };
    socket.on('matrix:npcTalk', ({ npcId }, ack) => {
      if (!ctx) return;
      const live = liveWorlds.get(ctx.worldName);
      if (!live || !live.isMatrix) return ack && ack({ error: 'Bu sadece Matrix içinde çalışır.' });
      const npc = (live.npcs || []).find(n => n.id === npcId);
      if (!npc) return ack && ack({ error: 'NPC bulunamadı.' });
      if (missionSessions.has(socket.id)) return ack && ack({ error: 'Zaten aktif bir görevdesin.' });
      if (!npc.questType) return ack && ack({ ok: true, dialog: 'Merhaba, dışarısı bugün de tuhaf...', hasQuest: false });
      const def = QUEST_DEFS[npc.questType];
      return ack && ack({ ok: true, dialog: `Bana yardım eder misin? "${def.label}" görevini kabul ediyor musun?`, hasQuest: true, questType: npc.questType, questLabel: def.label, durationMs: def.durationMs });
    });

    socket.on('matrix:questAccept', async ({ questType }, ack) => {
      if (!ctx) return;
      const live = liveWorlds.get(ctx.worldName);
      if (!live || !live.isMatrix) return ack && ack({ error: 'Bu sadece Matrix içinde çalışır.' });
      if (!QUEST_DEFS[questType]) return ack && ack({ error: 'Geçersiz görev.' });
      if (missionSessions.has(socket.id)) return ack && ack({ error: 'Zaten aktif bir görevdesin.' });

      const seed = Math.floor(Math.random() * 1e9);
      const gen = generateMissionWorld(seed, questType);
      const session = {
        type: questType, seed, startedAt: Date.now(), durationMs: QUEST_DEFS[questType].durationMs,
        tiles: gen.tiles, spawn: gen.spawn, uid: ctx.uid, username: ctx.username,
        booths: gen.booths || null, enemies: gen.enemies || null, deliveryPoint: gen.deliveryPoint || null,
        completed: false,
      };
      missionSessions.set(socket.id, session);

      // Görev süresince oyuncu Matrix'teki diğer oyunculara görünmez olsun (ayrı, kişiye özel bir alanda).
      io.to(`world:${ctx.worldName}`).emit('player:leave', { id: socket.id });

      if (questType === 'courier') {
        // görev başında Hard Drive envantere eklenir (vizyon md.24)
        const userRes = await pool.query('SELECT inventory FROM users WHERE id=$1', [ctx.uid]);
        const inv = userRes.rows[0].inventory;
        invAdd(inv, 'hard_drive', 1);
        await persistUserRow(ctx.uid, { inventory: inv });
      }

      // otomatik zaman aşımı: süre dolunca görev başarısız sayılır ve oyuncu Matrix'e geri gönderilir
      session.timeoutHandle = setTimeout(() => {
        const s = missionSessions.get(socket.id);
        if (s && !s.completed) {
          missionSessions.delete(socket.id);
          io.to(socket.id).emit('matrix:missionEnded', { success: false, reason: 'Süre doldu.' });
        }
      }, session.durationMs + 2000); // +2sn ağ gecikmesi payı

      ack && ack({
        ok: true, questType, seed, spawn: gen.spawn, tiles: gen.tiles,
        booths: session.booths, enemies: session.enemies, deliveryPoint: session.deliveryPoint,
        durationMs: session.durationMs,
      });
    });

    // Telephone Line: kablo bağlama mini-game — her booth ayrı ayrı "bağlandı" işaretlenir, hepsi bağlanınca görev biter.
    socket.on('matrix:connectBooth', ({ boothId }, ack) => {
      if (!ctx) return;
      const session = missionSessions.get(socket.id);
      if (!session || session.type !== 'telephone' || session.completed) return ack && ack({ error: 'Aktif bir Telephone Line görevin yok.' });
      const booth = (session.booths || []).find(b => b.id === boothId);
      if (!booth) return ack && ack({ error: 'Kulübe bulunamadı.' });
      if (booth.connected) return ack && ack({ ok: true, alreadyConnected: true, connectedCount: session.booths.filter(b=>b.connected).length, total: session.booths.length });
      booth.connected = true;
      const connectedCount = session.booths.filter(b => b.connected).length;
      const allDone = connectedCount === session.booths.length;
      if (allDone) completeMission(socket, session, true);
      ack && ack({ ok: true, connectedCount, total: session.booths.length, missionComplete: allDone });
    });

    // Courier: teslimat noktasına ulaşınca Hard Drive teslim edilir, görev biter.
    socket.on('matrix:deliverPackage', async ({}, ack) => {
      if (!ctx) return;
      const session = missionSessions.get(socket.id);
      if (!session || session.type !== 'courier' || session.completed) return ack && ack({ error: 'Aktif bir Courier görevin yok.' });
      const userRes = await pool.query('SELECT inventory FROM users WHERE id=$1', [ctx.uid]);
      const inv = userRes.rows[0].inventory;
      if (!invRemove(inv, 'hard_drive', 1)) return ack && ack({ error: 'Hard Drive envanterinde yok.' });
      await persistUserRow(ctx.uid, { inventory: inv });
      completeMission(socket, session, true);
      ack && ack({ ok: true });
    });

    // Enemy Agent'a vurma — basit state machine yerine (görev süresi kısa olduğu için) doğrudan hasar,
    // 3 vuruşta ölür, loot olarak USB Drive düşürür.
    socket.on('matrix:hitEnemy', async ({ enemyId }, ack) => {
      if (!ctx) return;
      const session = missionSessions.get(socket.id);
      if (!session || session.completed) return ack && ack({ error: 'Aktif görev yok.' });
      const enemy = (session.enemies || []).find(e => e.id === enemyId);
      if (!enemy || !enemy.alive) return ack && ack({ ok: true, alive: false });
      enemy.hp -= 1;
      if (enemy.hp <= 0) {
        enemy.alive = false;
        // rarity ağırlıklı USB Drive loot (vizyon md.23: common..legendary)
        const roll = Math.random();
        const lootId = roll < 0.5 ? 'usb_common' : roll < 0.78 ? 'usb_uncommon' : roll < 0.93 ? 'usb_rare' : roll < 0.99 ? 'usb_epic' : 'usb_legendary';
        const userRes = await pool.query('SELECT inventory FROM users WHERE id=$1', [ctx.uid]);
        const inv = userRes.rows[0].inventory;
        invAdd(inv, lootId, 1);
        await persistUserRow(ctx.uid, { inventory: inv });
        return ack && ack({ ok: true, alive: false, loot: lootId });
      }
      ack && ack({ ok: true, alive: true, hp: enemy.hp });
    });

    socket.on('matrix:abandonMission', (data, ack) => {
      if (!ctx) return;
      const session = missionSessions.get(socket.id);
      if (session) { clearTimeout(session.timeoutHandle); missionSessions.delete(socket.id); }
      ack && ack({ ok: true });
    });

    async function completeMission(sock, session, success) {
      if (session.completed) return;
      session.completed = true;
      clearTimeout(session.timeoutHandle);
      missionSessions.delete(sock.id);
      if (success) {
        // ödül: rastgele bir USB Drive (rarity ağırlıklı, agent loot'undan biraz daha cömert)
        const roll = Math.random();
        const rewardId = roll < 0.4 ? 'usb_common' : roll < 0.7 ? 'usb_uncommon' : roll < 0.9 ? 'usb_rare' : roll < 0.98 ? 'usb_epic' : 'usb_legendary';
        const userRes = await pool.query('SELECT inventory FROM users WHERE id=$1', [session.uid]);
        const inv = userRes.rows[0].inventory;
        invAdd(inv, rewardId, 1);
        await persistUserRow(session.uid, { inventory: inv });
        io.to(sock.id).emit('matrix:missionEnded', { success: true, reward: rewardId });
      } else {
        io.to(sock.id).emit('matrix:missionEnded', { success: false, reason: 'Görev tamamlanamadı.' });
      }
    }

    socket.on('friend:add', async ({ username }, ack) => {
      if (!ctx) return;
      const target = String(username || '').toLowerCase();
      if (target === ctx.username) return ack && ack({ error: 'Kendini ekleyemezsin.' });
      const r = await pool.query('SELECT id FROM users WHERE username=$1', [target]);
      if (!r.rows.length) return ack && ack({ error: 'Kullanıcı bulunamadı.' });
      const userRes = await pool.query('SELECT friends FROM users WHERE id=$1', [ctx.uid]);
      const friends = userRes.rows[0].friends || [];
      if (!friends.includes(target)) friends.push(target);
      await persistUserRow(ctx.uid, { friends });
      ack && ack({ ok: true, friends });
    });

    socket.on('disconnect', () => {
      const activeMission = missionSessions.get(socket.id);
      if (activeMission) { clearTimeout(activeMission.timeoutHandle); missionSessions.delete(socket.id); }
      for (const [sid, session] of tradeSessions) {
        if (session.socketA === socket.id || session.socketB === socket.id) {
          const otherSocket = session.socketA === socket.id ? session.socketB : session.socketA;
          io.to(otherSocket).emit('trade:cancelled', { sessionId: sid, reason: 'Karşı taraf bağlantıyı kesti.' });
          tradeSessions.delete(sid);
        }
      }
      if (!ctx) return;
      onlineUsers.delete(ctx.username.toLowerCase());
      const live = liveWorlds.get(ctx.worldName);
      if (!live) return;
      live.players.delete(socket.id);
      io.to(`world:${ctx.worldName}`).emit('player:leave', { id: socket.id });
      if (live.players.size === 0 && !live.isMatrix) {
        live.evictTimer = setTimeout(async () => {
          await persistWorld(ctx.worldName).catch(console.error);
          liveWorlds.delete(ctx.worldName);
        }, EMPTY_WORLD_EVICT_MS);
      }
    });
  });
}

module.exports = { attachSocketHandlers, persistWorld };
