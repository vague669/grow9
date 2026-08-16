// Sunucu tarafı eşya kataloğu — client'taki ITEMS objesiyle birebir eşleşir.
// Loot/hasar/erişim kararları ARTIK BURADA (client'a güvenilmiyor).
//
// Metadata sözleşmesi (data-driven mimari — yeni item eklemek core kod değişikliği gerektirmemeli):
//   category: 'block'|'seed'|'fruit'|'material'|'tool'|'weapon'|'equipment'|'currency'|'consumable'|'element'|'lock'
//   rarity:   1=common .. 8+=legendary (ekonomik/loot ağırlığı için de kullanılabilir)
//   tradeable / droppable / sellable: bool, varsayılan true (aksi belirtilmedikçe)
//   equipSlot: wearable itemler için 'wings'|'head'|'face'|'body'|'back'|'hand'|'feet'|'aura' (yoksa giyilemez)
function withDefaults(id, def) {
  const tier = def.tier !== undefined ? def.tier : (def.rarity ? Math.min(def.rarity * 20, 200) : 1);
  return {
    id,
    tradeable: def.tradeable !== undefined ? def.tradeable : true,
    droppable: def.droppable !== undefined ? def.droppable : true,
    sellable: def.sellable !== undefined ? def.sellable : true,
    rarity: def.rarity !== undefined ? def.rarity : 1,
    tier,
    equipSlot: def.equipSlot || (def.wearable ? 'wings' : null),
    ...def,
  };
}

const RAW_ITEMS = {
  dirt:       { name: 'Toprak', type: 'block', category: 'block', hp: 3, gemDrop: [1, 3], seedDropChance: 0.26, seedDrop: 'seed_pepper', rarity: 1 },
  grassdirt:  { name: 'Çimen Toprağı', type: 'block', category: 'block', hp: 3, gemDrop: [1, 3], seedDropChance: 0.28, seedDrop: 'seed_pepper', rarity: 1 },
  cave:       { name: 'Kaya', type: 'block', category: 'block', hp: 5, gemDrop: [2, 5], seedDropChance: 0.16, seedDrop: 'seed_rare', rarity: 2 },
  crystal:    { name: 'Kristal Cevher', type: 'block', category: 'block', hp: 6, gemDrop: [4, 9], seedDropChance: 0.4, seedDrop: 'seed_rare', rarity: 4 },
  bedrock:    { name: 'Sağlam Blok', type: 'block', category: 'block', hp: 9999, unbreak: true, tradeable: false, droppable: false, sellable: false },
  lava:       { name: 'Lav', type: 'block', category: 'block', hp: 1, hazard: true, unbreak: true, tradeable: false, droppable: false, sellable: false },
  worldlock:  { name: 'World Lock', type: 'lock', category: 'currency', hp: 2, special: 'lock', rarity: 5 },
  diamondlock:{ name: 'Diamond Lock', type: 'lock', category: 'currency', hp: 2, special: 'lock', rarity: 7 },
  bluegemlock:{ name: 'Blue Gem Lock', type: 'lock', category: 'currency', hp: 2, special: 'lock', rarity: 9 },
  fist:       { name: 'Yumruk', type: 'tool', category: 'tool', tradeable: false, droppable: false, sellable: false },
  wrench:     { name: 'Wrench', type: 'tool', category: 'tool', tradeable: false, droppable: false, sellable: false },
  wings_basic:{ name: 'Temel Kanat', type: 'wings', category: 'equipment', wearable: true, equipSlot: 'wings', rarity: 1, animSet: 'flap_basic' },
  wings_fire:{ name: 'Alev Kanadı', type: 'wings', category: 'equipment', wearable: true, equipSlot: 'wings', rarity: 4, animSet: 'flap_fire' },
  wings_crystal:{ name: 'Kristal Kanat', type: 'wings', category: 'equipment', wearable: true, equipSlot: 'wings', rarity: 4, animSet: 'flap_crystal' },
  wings_shadow:{ name: 'Gölge Kanadı', type: 'wings', category: 'equipment', wearable: true, equipSlot: 'wings', rarity: 5, animSet: 'flap_shadow' },
  weapon_trident:{ name: 'Poseidon Trident', type: 'tool', category: 'weapon', rarity: 8, weaponEffect: 'trident_throw', desc: 'Denizler hakiminin üçlü mızrağı. Tıklanan yere mızrak fırlatır.' },
  weapon_lightning:{ name: 'Zeus Yıldırımı', type: 'tool', category: 'weapon', rarity: 9, weaponEffect: 'lightning_strike', desc: 'Gökyüzü lordunun yıldırımı. Bloklara veya hedefe yıldırım ışını çakar.' },
  seed_pepper:{ name: 'Biber Tohumu', type: 'seed', category: 'seed', growSeconds: 16, rarity: 1, fruit: 'fruit_pepper' },
  seed_rare:  { name: 'Nadir Tohum', type: 'seed', category: 'seed', growSeconds: 45, rarity: 6, fruit: 'fruit_rare' },
  fruit_pepper:{ name: 'Biber', type: 'fruit', category: 'fruit', rarity: 1 },
  fruit_rare: { name: 'Nadir Meyve', type: 'fruit', category: 'fruit', rarity: 6 },
  gem:        { name: 'Gem', type: 'currency', category: 'currency', tradeable: false, droppable: false, sellable: false },

  // Mimari & Geçiş Blokları
  ladder:       { name: 'Merdiven', type: 'block', category: 'block', hp: 2, isPassable: true, isLadder: true, rarity: 1, desc: 'Altından üstüne zıplanabilir birim.' },
  metal_door:   { name: 'Metal Kapı', type: 'block', category: 'block', hp: 4, isPassable: true, isDoor: true, doorType: 'metal', rarity: 3, desc: 'Geçilebilir sağlam metal kapı.' },
  sliding_door: { name: 'Sensörlü Sürgülü Kapı', type: 'block', category: 'block', hp: 4, isPassable: true, isDoor: true, doorType: 'sliding', rarity: 4, desc: 'Yaklaşınca otomatik açılan sürgülü cam/metal kapı.' },
  brick:        { name: 'Tuğla Blok', type: 'block', category: 'block', hp: 4, rarity: 2 },
  concrete:     { name: 'Beton Blok', type: 'block', category: 'block', hp: 5, rarity: 3 },
  wood_block:   { name: 'Ahşap Blok', type: 'block', category: 'block', hp: 3, rarity: 1 },

  // --- Katmanlı birleştirme (craft) ağacı ---
  // Katman 1: temel elementler
  elem_dirt:  { name: 'Toprak Özü', type: 'element', category: 'element', tier: 1, color: 0x8b5a2b, rarity: 1 },
  elem_water: { name: 'Su Özü', type: 'element', category: 'element', tier: 1, color: 0x4ac1ff, rarity: 1 },
  elem_stone: { name: 'Taş Özü', type: 'element', category: 'element', tier: 1, color: 0x8a8a8a, rarity: 1 },
  elem_lava:  { name: 'Lav Özü', type: 'element', category: 'element', tier: 1, color: 0xff5a1a, rarity: 1 },
  elem_sand:  { name: 'Kum Özü', type: 'element', category: 'element', tier: 1, color: 0xe8d18a, rarity: 1 },
  // Katman 2: doğa ve inşa
  elem_wood:  { name: 'Tahta Özü', type: 'element', category: 'element', tier: 2, color: 0x9a6b3a, rarity: 2 },
  elem_volcanic:{ name: 'Volkanik Taş Özü', type: 'element', category: 'element', tier: 2, color: 0x5a3a3a, rarity: 2 },
  elem_glass: { name: 'Cam Özü', type: 'element', category: 'element', tier: 2, color: 0xaeeaff, rarity: 2 },
  // Katman 3: madenler ve basit teknoloji
  elem_iron:  { name: 'Demir Blok Özü', type: 'element', category: 'element', tier: 3, color: 0xc7c7d1, rarity: 3 },
  elem_brick: { name: 'Tuğla Özü', type: 'element', category: 'element', tier: 3, color: 0xb04a2f, rarity: 3 },
  elem_coal:  { name: 'Kömür Özü', type: 'element', category: 'element', tier: 3, color: 0x2b2b2b, rarity: 3 },
  // Katman 4: PixelBomb fantezi/enerji
  elem_gold:  { name: 'Altın Blok Özü', type: 'element', category: 'element', tier: 4, color: 0xffd93a, rarity: 5 },
  elem_crystal:{ name: 'Kristal Özü', type: 'element', category: 'element', tier: 4, color: 0xd88bff, rarity: 5 },
  elem_gunpowder:{ name: 'Barut Bloğu Özü', type: 'element', category: 'element', tier: 4, color: 0x3a2a2a, rarity: 5 },
  elem_neon:  { name: 'Sarı Neon Blok Özü', type: 'element', category: 'element', tier: 4, color: 0xfff23a, rarity: 5 },

  // --- Metalurji ağacı (seed pack'ten çıkan hammaddeler + torna makinesi ürünleri) ---
  seed_stone_common:  { name: 'Taş Tohumu', type: 'seed', category: 'seed', growSeconds: 10, rarity: 1, fruit: 'ore_stone' },
  seed_crystal_common:{ name: 'Kristal Blok Tohumu', type: 'seed', category: 'seed', growSeconds: 20, rarity: 3, fruit: 'ore_crystal' },
  seed_copper: { name: 'Bakır Tohumu', type: 'seed', category: 'seed', growSeconds: 30, rarity: 4, fruit: 'ore_copper' },
  seed_iron:   { name: 'Demir Tohumu', type: 'seed', category: 'seed', growSeconds: 30, rarity: 4, fruit: 'ore_iron' },
  seed_aluminum:{ name: 'Alüminyum Tohumu', type: 'seed', category: 'seed', growSeconds: 40, rarity: 6, fruit: 'ore_aluminum' },
  seed_gold:   { name: 'Altın Tohumu', type: 'seed', category: 'seed', growSeconds: 50, rarity: 8, fruit: 'ore_gold' },
  seed_coal:   { name: 'Kömür Tohumu', type: 'seed', category: 'seed', growSeconds: 25, rarity: 3, fruit: 'ore_coal' },
  ore_stone:  { name: 'Taş Cevheri', type: 'material', category: 'material', color: 0x9a9aa2, rarity: 1 },
  ore_crystal:{ name: 'Kristal Cevheri', type: 'material', category: 'material', color: 0xd88bff, rarity: 3 },
  ore_copper: { name: 'Bakır Cevheri', type: 'material', category: 'material', color: 0xd6793a, rarity: 4 },
  ore_iron:   { name: 'Demir Cevheri', type: 'material', category: 'material', color: 0xb7b7c0, rarity: 4 },
  ore_aluminum:{ name: 'Alüminyum Cevheri', type: 'material', category: 'material', color: 0xd8d8e0, rarity: 6 },
  ore_gold:   { name: 'Altın Cevheri', type: 'material', category: 'material', color: 0xffd93a, rarity: 8 },
  ore_coal:   { name: 'Kömür Cevheri', type: 'material', category: 'material', color: 0x2b2b2b, rarity: 3 },
  // alaşımlar
  alloy_steel:   { name: 'Çelik', type: 'material', category: 'material', color: 0x8a8a99, rarity: 5 },
  alloy_alumbronze:{ name: 'Alüminyum Bronzu', type: 'material', category: 'material', color: 0xc98a4a, rarity: 5 },
  alloy_duralumin:{ name: 'Duralüminyum', type: 'material', category: 'material', color: 0xb8c4d0, rarity: 6 },
  alloy_processor:{ name: 'Elektronik İşlemci', type: 'material', category: 'material', color: 0xffd93a, rarity: 7 },
  // torna makinesi (lathe) ürünleri — nihai eşyalar
  item_buzzsaw: { name: 'Döner Testere Blok', type: 'block', category: 'block', hp: 8, color: 0x9a9aa2, rarity: 6 },
  item_gun:     { name: 'Silah', type: 'tool', category: 'weapon', color: 0x7a7a85, rarity: 7 },
  item_robot_armor:{ name: 'Robot Zırh', type: 'wearable_armor', category: 'equipment', wearable: true, equipSlot: 'body', color: 0xb8c4d0, rarity: 8 },
  item_metal_glove:{ name: 'Metal Eldiven', type: 'wearable_armor', category: 'equipment', wearable: true, equipSlot: 'hand', color: 0x8a8a99, rarity: 6 },
  lathe: { name: 'Torna Bloğu', type: 'block', category: 'block', hp: 6, color: 0x6a6a75, unbreakByFist: false, rarity: 5, tradeable: false },
  asphalt: { name: 'Asfalt', type: 'block', category: 'block', hp: 4, gemDrop: [1, 2], rarity: 1 },
  matrix_chair: { name: 'Matrix Sandalyesi', type: 'block', category: 'block', hp: 5, special: 'matrix_chair', rarity: 5, tradeable: false },
  shop_stand: { name: 'Satış Standı', type: 'block', category: 'block', hp: 5, special: 'shop', color: 0x7a5a3a, rarity: 4, tradeable: false },

  // --- Matrix görev kaynakları ---
  usb_common:    { name: 'USB Drive (Sıradan)', type: 'matrix_resource', category: 'matrix_resource', rarity: 2, color: 0x8a8a99 },
  usb_uncommon:  { name: 'USB Drive (Nadide)', type: 'matrix_resource', category: 'matrix_resource', rarity: 3, color: 0x4ac1ff },
  usb_rare:      { name: 'USB Drive (Nadir)', type: 'matrix_resource', category: 'matrix_resource', rarity: 5, color: 0xd88bff },
  usb_epic:      { name: 'USB Drive (Epik)', type: 'matrix_resource', category: 'matrix_resource', rarity: 7, color: 0xff9a3a },
  usb_legendary: { name: 'USB Drive (Efsanevi)', type: 'matrix_resource', category: 'matrix_resource', rarity: 9, color: 0xffd93a },
  hard_drive:    { name: 'Hard Drive', type: 'quest_item', category: 'quest_item', rarity: 3, tradeable: false, droppable: false, sellable: false, color: 0x6fe3ff },
  matrix_core:   { name: 'Glitch Core', type: 'matrix_resource', category: 'matrix_resource', rarity: 6, color: 0x39ff6a },

  // --- PAKETLER ---
  pack_ssp: { name: 'Small Seed Pack (SSP)', type: 'consumable', category: 'pack', color: 0xffd93a, rarity: 2, desc: 'İçinden 10 temel tohum çıkar (Toprak, Taş, Su, Lav, Kum).' },
  pack_lsp: { name: 'Large Seed Pack (LSP)', type: 'consumable', category: 'pack', color: 0xff9a3a, rarity: 4, desc: 'İçinden 25 nadir ve birleşim tohumu çıkar.' },
  pack_sip: { name: 'Small Item Pack (SIP)', type: 'consumable', category: 'pack', color: 0x4ac1ff, rarity: 2, desc: 'İçinden giysi ve basit tarım/inşa aletleri çıkar.' },
  pack_wearables: { name: 'Giyim Paketi', type: 'consumable', category: 'pack', color: 0xd88bff, rarity: 4, desc: 'Rastgele şık giysiler ve aksesuarlar verir.' },
};

const ITEMS = {};
for (const [id, def] of Object.entries(RAW_ITEMS)) ITEMS[id] = withDefaults(id, def);

const CRAFT_RECIPES = {
  'elem_dirt+elem_water': 'elem_wood',
  'elem_lava+elem_stone': 'elem_volcanic',
  'elem_lava+elem_sand': 'elem_glass',
  'elem_stone+elem_volcanic': 'elem_iron',
  'elem_dirt+elem_lava': 'elem_brick',
  'elem_dirt+elem_wood': 'elem_coal',
  'elem_iron+elem_lava': 'elem_gold',
  'elem_glass+elem_volcanic': 'elem_crystal',
  'elem_coal+elem_lava': 'elem_gunpowder',
  'elem_glass+elem_gold': 'elem_neon',
  'ore_coal+ore_iron': 'alloy_steel',
  'ore_aluminum+ore_copper': 'alloy_alumbronze',
  'ore_aluminum+ore_copper+ore_iron': 'alloy_duralumin',
  'ore_copper+ore_gold': 'alloy_processor',
  'alloy_steel+ore_copper+ore_iron': 'item_buzzsaw',
  'alloy_duralumin+alloy_steel': 'item_gun',
  'alloy_duralumin+alloy_steel+ore_gold': 'item_robot_armor',
  'alloy_alumbronze+alloy_steel': 'item_metal_glove',
};
function recipeKey(ids) { return [...ids].sort().join('+'); }
function craftResult(ids) { return CRAFT_RECIPES[recipeKey(ids)] || null; }
const LATHE_ONLY_RESULTS = new Set(['item_buzzsaw', 'item_gun', 'item_robot_armor', 'item_metal_glove']);

const STORE_ITEMS = [
  // --- PAKETLER ---
  { id: 'pack_ssp', price: 20, qty: 1, tab: 'packs', label: 'Small Seed Pack (SSP)' },
  { id: 'pack_lsp', price: 75, qty: 1, tab: 'packs', label: 'Large Seed Pack (LSP)' },
  { id: 'pack_sip', price: 30, qty: 1, tab: 'packs', label: 'Small Item Pack (SIP)' },
  { id: 'pack_wearables', price: 120, qty: 1, tab: 'packs', label: 'Giyim Paketi' },

  // --- İŞLEVSEL & KİLİTLER ---
  { id: 'worldlock', price: 150, qty: 1, tab: 'functional', label: 'World Lock' },
  { id: 'matrix_chair', price: 500, qty: 1, tab: 'functional', label: 'Matrix Sandalyesi' },
  { id: 'lathe', price: 300, qty: 1, tab: 'functional', label: 'Torna Makinesi Bloğu' },
  { id: 'shop_stand', price: 400, qty: 1, tab: 'functional', label: 'Satış Standı' },
  { id: 'metal_door', price: 50, qty: 2, tab: 'functional', label: 'Metal Kapı x2' },
  { id: 'sliding_door', price: 90, qty: 2, tab: 'functional', label: 'Sensörlü Sürgülü Kapı x2' },
  { id: 'ladder', price: 15, qty: 10, tab: 'functional', label: 'Merdiven x10' },

  // --- MİTOLOJİK & ÖZEL BİRLİKLER ---
  { id: 'weapon_trident', price: 800, qty: 1, tab: 'mythic', label: 'Poseidon Trident' },
  { id: 'weapon_lightning', price: 1200, qty: 1, tab: 'mythic', label: 'Zeus Yıldırımı' },

  // --- KANATLAR & KANAT KOSTÜMLERİ ---
  { id: 'wings_basic', price: 100, qty: 1, tab: 'wings', label: 'Temel Kanat' },
  { id: 'wings_fire', price: 220, qty: 1, tab: 'wings', label: 'Alev Kanadı' },
  { id: 'wings_crystal', price: 220, qty: 1, tab: 'wings', label: 'Kristal Kanat' },
  { id: 'wings_shadow', price: 260, qty: 1, tab: 'wings', label: 'Gölge Kanadı' },
];

// Seed Pack açılınca çıkan 100 tohumun dağılımı (istenen oranlara göre)
const SEEDPACK_TABLE = [
  { id: 'seed_copper', count: 10 },
  { id: 'seed_iron', count: 10 },
  { id: 'seed_aluminum', count: 5 },
  { id: 'seed_gold', count: 5 },
  { id: 'seed_coal', count: 10 },
  { id: 'seed_crystal_common', count: 20 },
  { id: 'seed_stone_common', count: 40 },
]; // toplam 100

function randInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }

module.exports = { ITEMS, STORE_ITEMS, randInt, CRAFT_RECIPES, craftResult, SEEDPACK_TABLE, LATHE_ONLY_RESULTS };
