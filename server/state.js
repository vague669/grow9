// Açık dünyaların bellek-içi canlı önbelleği.
// tiles/plants/drops sıkça değişir; her değişiklikte DB'ye yazmak yerine
// burada tutulur, periyodik olarak (ve dünya boşalınca) DB'ye "flush" edilir.
const liveWorlds = new Map(); // name -> { id, ownerId, tiles, plants, drops, locked, lockType, access, dirty, players: Map(socketId -> {uid,username,x,y,dir,anim,worn}) }
const tradeSessions = new Map(); // sessionId -> { socketA, socketB, uidA, uidB, usernameA, usernameB, offerA:[], offerB:[], readyA, readyB, confirmedA, confirmedB, reviewPhase }

// Sunucu genelinde online kullanıcı kaydı — /msg, /who, /kick, /ban, /mute gibi komutlar için
// kullanıcı adından soket/uid/dünya bilgisine hızlı erişim sağlar. auth:join'de eklenir, disconnect'te silinir.
const onlineUsers = new Map(); // usernameLower -> { socketId, uid, username, worldName, isAdmin }
// Aktif Matrix görev oturumları: socketId -> { type, startedAt, durationMs, seed, ... görev-özel state }
// Mission World'ler DB'de tutulmaz, tamamen bellek-içi ve kişiye özeldir (vizyon md.26).
const missionSessions = new Map();
// Mute listesi: usernameLower -> mute bitiş zaman damgası (ms). Süre dolunca otomatik geçersiz sayılır.
// (Global ban artık bellek-içi değil, users.banned_until DB kolonunda kalıcı tutuluyor — sunucu yeniden başlasa da kaybolmaz.)
const mutedUsers = new Map();

let ioRef = null;
function setIO(io) { ioRef = io; }
function getIO() { return ioRef; }

module.exports = { liveWorlds, tradeSessions, onlineUsers, mutedUsers, missionSessions, setIO, getIO };
