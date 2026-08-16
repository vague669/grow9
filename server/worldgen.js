const WORLD_W = 100;
const WORLD_H = 60;
// Matrix dünyası normal dünyadan ~3 kat geniş — vizyon dokümanındaki 300x180 hedefine yakın, ama hard-code değil, buradan tek yerden ayarlanabilir.
const MATRIX_W = 300;
const MATRIX_H = 100;

function newWorldTiles() {
  const tiles = [];
  const surfaceY = 28;
  for (let y = 0; y < WORLD_H; y++) {
    const row = [];
    for (let x = 0; x < WORLD_W; x++) {
      let id = null;
      if (y === surfaceY - 1 && x === 50) {
        id = 'metal_door'; // Giriş kapısı (spawn kapısı)
      } else if (y === surfaceY) {
        id = 'grassdirt';
      } else if (y > surfaceY && y < WORLD_H - 3) {
        const randVal = Math.random();
        if (randVal < 0.15) id = 'cave';
        else if (randVal < 0.19) id = 'crystal';
        else id = 'dirt';
      } else if (y >= WORLD_H - 3 && y < WORLD_H - 1) {
        // En alttan 2 blok yukarıda lav havuzları (can yakar/savurur)
        id = Math.random() < 0.75 ? 'lava' : (Math.random() < 0.5 ? 'cave' : 'dirt');
      } else if (y === WORLD_H - 1) {
        id = 'bedrock';
      }
      row.push(id);
    }
    tiles.push(row);
  }
  return tiles;
}

// Basit, deterministik seed'li rastgele sayı üreteci (mulberry32) — aynı seed = aynı sonuç,
// bu sayede "tüm oyuncular aynı gün aynı Matrix layout'unu görür" garantisi sağlanır.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Server-seed üretimi: gün başına deterministik bir sayı. Client bu hesabı asla kendisi yapmaz,
// sadece server'ın gönderdiği tiles/spawn verisini render eder (vizyon dok. madde 21).
function getMatrixDaySeed(dateObj = new Date()) {
  const y = dateObj.getUTCFullYear(), m = dateObj.getUTCMonth() + 1, d = dateObj.getUTCDate();
  return y * 10000 + m * 100 + d; // örn. 20260801
}

// Matrix bölgeleri — her biri X ekseninde bir aralık kaplar, kendi zemin/bina paletine sahiptir.
// Ana spawn (harita ortası, DOWNTOWN içinde) her gün sabit kalır ki oyuncu yönünü kaybetmesin;
// bina/dükkan/NPC/metro konumları ise günlük seed'e göre değişir.
const MATRIX_REGIONS = [
  { id: 'SUBWAY_W', label: 'Subway Tunnels (Batı)', xStart: 0.00, xEnd: 0.14 },
  { id: 'INDUSTRIAL', label: 'Industrial Area', xStart: 0.14, xEnd: 0.28 },
  { id: 'RESIDENTIAL_W', label: 'Residential Sector (Batı)', xStart: 0.28, xEnd: 0.42 },
  { id: 'DOWNTOWN', label: 'Downtown', xStart: 0.42, xEnd: 0.58 },
  { id: 'COMMERCIAL', label: 'Commercial Sector', xStart: 0.58, xEnd: 0.72 },
  { id: 'RESIDENTIAL_E', label: 'Residential Sector (Doğu)', xStart: 0.72, xEnd: 0.86 },
  { id: 'ROOFTOPS_SUBWAY_E', label: 'Subway / Rooftops (Doğu)', xStart: 0.86, xEnd: 1.00 },
];
function regionAt(txRatio) {
  return MATRIX_REGIONS.find(r => txRatio >= r.xStart && txRatio < r.xEnd) || MATRIX_REGIONS[3];
}

// Prosedürel + handcrafted karışım: zemin/gökyüzü siluetinin şekli el yapımı kurallarla (bölge bazlı yükseklik,
// bina şablonu genişlikleri), iç detaylar (pencere, kapı, telefon kulübesi, NPC noktası) seed'li rastgele ile.
function generateMatrixWorld(seed) {
  const rng = mulberry32(seed);
  const tiles = [];
  for (let y = 0; y < MATRIX_H; y++) tiles.push(new Array(MATRIX_W).fill(null));

  const groundY = MATRIX_H - 12; // zemin hattı, altı asfalt+toprak+kaya+bedrock
  for (let x = 0; x < MATRIX_W; x++) {
    for (let y = groundY; y < MATRIX_H; y++) {
      let id;
      if (y === groundY) id = 'asphalt';
      else if (y === MATRIX_H - 1) id = 'bedrock';
      else if (y > MATRIX_H - 4) id = 'cave';
      else id = 'dirt';
      tiles[y][x] = id;
    }
  }

  // Basit bina siluetleri: her bölgede rastgele genişlik/yükseklikte "asphalt bloklarından" dikey duvarlar.
  // Amaç detaylı mimari değil, oyuncunun bölgeler arasındaki görsel farkı hissetmesi (vizyon md.21).
  const buildingSpawns = [];
  const npcSpawns = [];
  const boothSpawns = []; // telefon kulübesi aday noktaları (Mission 1 için)
  let x = 4;
  while (x < MATRIX_W - 6) {
    const txRatio = x / MATRIX_W;
    const region = regionAt(txRatio);
    const gapBeforeNext = 3 + Math.floor(rng() * 4);
    if (region.id.startsWith('SUBWAY') && rng() < 0.35) {
      // metro girişi: küçük bir merdiven boşluğu bırak, bina koyma
      x += gapBeforeNext + 6;
      continue;
    }
    const width = 6 + Math.floor(rng() * 6);
    const isCommercial = region.id === 'COMMERCIAL' || region.id === 'DOWNTOWN';
    const height = (isCommercial ? 10 : 6) + Math.floor(rng() * (isCommercial ? 12 : 6));
    if (x + width >= MATRIX_W - 2) break;
    for (let bx = x; bx < x + width; bx++) {
      for (let by = groundY - height; by < groundY; by++) {
        tiles[by][bx] = (by === groundY - height) ? 'crystal' : 'cave'; // çatı=crystal (siluet vurgusu), gövde=cave (bina dokusu)
      }
    }
    buildingSpawns.push({ x: x + Math.floor(width / 2), y: groundY - height, region: region.id, width, height });
    if (rng() < 0.4) npcSpawns.push({ x: x + Math.floor(width / 2), y: groundY - 1, region: region.id });
    if (rng() < 0.3) boothSpawns.push({ x: x + Math.floor(width / 2), y: groundY - 1, region: region.id });
    x += width + gapBeforeNext;
  }

  // Ana spawn / Matrix giriş noktası — DOWNTOWN'ın ortasında, her gün sabit (vizyon md.21: "ana spawn tutarlı kalmalı")
  const mainSpawn = { x: Math.floor(MATRIX_W / 2), y: groundY - 1 };
  // spawn etrafını temizle (bina basmasın)
  for (let cx = mainSpawn.x - 4; cx <= mainSpawn.x + 4; cx++) {
    for (let cy = groundY - 8; cy < groundY; cy++) { if (tiles[cy] && tiles[cy][cx] !== undefined) tiles[cy][cx] = null; }
  }

  return { tiles, mainSpawn, buildingSpawns, npcSpawns, boothSpawns, seed };
}

// Şu anki günün Matrix layout'unu üretir (bellekte cache'lenir, socket.js tarafında tutulur).
function newMatrixWorldTiles() {
  const seed = getMatrixDaySeed();
  const gen = generateMatrixWorld(seed);
  return gen.tiles;
}

const DOOR_TX = 50, DOOR_TY = 27;
const MATRIX_DOOR_TX = Math.floor(MATRIX_W/2), MATRIX_DOOR_TY = MATRIX_H - 13;

// Görev dünyaları (Mission World) — Matrix'e benzer ama küçük, kişiye özel, tek kullanımlık.
// Handcrafted + procedural karışım: bina/sokak iskeleti sabit desenlerden, telefon kulübesi/düşman/NPC
// konumları seed'e göre değişken (vizyon md.26).
const MISSION_W = 80, MISSION_H = 40;
function generateMissionWorld(seed, missionType) {
  const rng = mulberry32(seed);
  const tiles = [];
  for (let y = 0; y < MISSION_H; y++) tiles.push(new Array(MISSION_W).fill(null));
  const groundY = MISSION_H - 10;
  for (let x = 0; x < MISSION_W; x++) {
    for (let y = groundY; y < MISSION_H; y++) {
      tiles[y][x] = (y === groundY) ? 'asphalt' : (y === MISSION_H - 1 ? 'bedrock' : (y > MISSION_H - 4 ? 'cave' : 'dirt'));
    }
  }
  // birkaç bina silueti — labirent hissi için
  const buildingSpawns = [];
  let x = 4;
  while (x < MISSION_W - 8) {
    const width = 5 + Math.floor(rng() * 5);
    const height = 5 + Math.floor(rng() * 8);
    if (x + width >= MISSION_W - 4) break;
    for (let bx = x; bx < x + width; bx++) for (let by = groundY - height; by < groundY; by++) tiles[by][bx] = 'cave';
    buildingSpawns.push({ x: x + Math.floor(width / 2), y: groundY - height });
    x += width + 4 + Math.floor(rng() * 5);
  }
  const spawn = { x: 4, y: groundY - 1 };
  for (let cx = 0; cx <= 8; cx++) for (let cy = groundY - 6; cy < groundY; cy++) if (tiles[cy]) tiles[cy][cx] = null;

  const result = { tiles, spawn, seed };
  if (missionType === 'telephone') {
    // 2-4 telefon kulübesi rastgele bina noktalarına yakın yerleştirilir
    const boothCount = 2 + Math.floor(rng() * 3);
    result.booths = [];
    for (let i = 0; i < boothCount; i++) {
      const bx = 12 + Math.floor(rng() * (MISSION_W - 20));
      result.booths.push({ id: `mbooth_${i}`, x: bx, y: groundY - 1, connected: false });
    }
    result.enemies = [];
    const enemyCount = 1 + Math.floor(rng() * 2); // 1-2 düşman
    for (let i = 0; i < enemyCount; i++) {
      result.enemies.push({ id: `agent_${i}`, x: 20 + Math.floor(rng() * (MISSION_W - 30)), y: groundY - 1, hp: 3, alive: true });
    }
  } else if (missionType === 'courier') {
    // teslim NPC'si haritanın sonuna yakın rastgele bir noktada
    result.deliveryPoint = { x: MISSION_W - 8 - Math.floor(rng() * 10), y: groundY - 1 };
    result.enemies = [];
    const enemyCount = 1 + Math.floor(rng() * 3); // 1-3 düşman
    for (let i = 0; i < enemyCount; i++) {
      result.enemies.push({ id: `agent_${i}`, x: 15 + Math.floor(rng() * (MISSION_W - 30)), y: groundY - 1, hp: 3, alive: true });
    }
  }
  return result;
}

module.exports = {
  newWorldTiles, newMatrixWorldTiles, WORLD_W, WORLD_H, DOOR_TX, DOOR_TY,
  MATRIX_W, MATRIX_H, MATRIX_DOOR_TX, MATRIX_DOOR_TY,
  mulberry32, getMatrixDaySeed, generateMatrixWorld, MATRIX_REGIONS,
  MISSION_W, MISSION_H, generateMissionWorld,
};
