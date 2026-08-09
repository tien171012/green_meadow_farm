/* =============================================================================
   GREEN MEADOW FARM â€” server.js
   Backend Node.js + Express + MongoDB (Mongoose)
   -----------------------------------------------------------------------------
   ÄĂ¢y lĂ  nÆ¡i DUY NHáº¤T quyáº¿t Ä‘á»‹nh vĂ ng, trá»©ng, cáº¥p Ä‘á»™ nĂ¢ng cáº¥p cá»§a ngÆ°á»i chÆ¡i,
   vĂ  cÅ©ng lĂ  nÆ¡i lÆ°u báº£ng xáº¿p háº¡ng THáº¬T dĂ¹ng chung cho má»i ngÆ°á»i chÆ¡i
   (thay cho Firebase). File HTML chá»‰ hiá»ƒn thá»‹ â€” má»i hĂ nh Ä‘á»™ng (mua thĂº,
   nĂ¢ng cáº¥p, bĂ¡n trá»©ng) pháº£i Ä‘i qua API dÆ°á»›i Ä‘Ă¢y, nĂªn sá»­a dá»¯ liá»‡u báº±ng F12
   trĂªn mĂ¡y ngÆ°á»i chÆ¡i sáº½ KHĂ”NG cĂ³ tĂ¡c dá»¥ng.

   CĂ³ thá»ƒ DĂ™NG CHUNG cá»¥m MongoDB Atlas báº¡n Ä‘Ă£ táº¡o cho Aqua Paradise â€”
   chá»‰ cáº§n Ä‘á»•i TĂN DATABASE trong MONGODB_URI (vĂ­ dá»¥ .../green_meadow thay
   vĂ¬ .../aqua_paradise), khĂ´ng cáº§n táº¡o cá»¥m má»›i.

   CĂ¡ch cháº¡y: giá»‘ng há»‡t Aqua Paradise â€” deploy lĂªn Render/Railway (Ä‘iá»n cĂ¡c
   biáº¿n mĂ´i trÆ°á»ng trong .env.example), rá»“i copy URL vá»«a deploy vĂ o biáº¿n
   API_BASE trong file green_meadow_farm.html.
============================================================================= */

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const {
  MONGODB_URI,
  BOT_TOKEN,
  JWT_SECRET,
  ALLOWED_ORIGIN,
  PORT = 3000,
} = process.env;

if (!MONGODB_URI || !BOT_TOKEN || !JWT_SECRET) {
  console.error('â ï¸ Thiáº¿u biáº¿n mĂ´i trÆ°á»ng báº¯t buá»™c (MONGODB_URI/BOT_TOKEN/JWT_SECRET). Server sáº½ tráº£ lá»—i 500 cho má»i request cho tá»›i khi Ä‘Æ°á»£c cáº¥u hĂ¬nh Ä‘á»§ trĂªn Vercel.');
}

/* =========================== Dá»® LIá»†U CON Váº¬T (NGUá»’N Sá»° THáº¬T DUY NHáº¤T) =========================== */
const EGG_TIME_SEC = 30;      // giĂ¢y / quáº£, Ă¡p dá»¥ng cho má»i con váº­t
const MAX_OWNED = 3;          // má»—i loáº¡i thĂº tá»‘i Ä‘a 3 con
const MAX_ANIMAL_LEVEL = 20;  // cáº¥p nĂ¢ng cáº¥p tá»‘i Ä‘a cho má»—i con váº­t

const ANIMALS = [
  // ---- Lv1 ----
  { id: 'ga', lvl: 1, price: 23000, egg: 1000 },
  { id: 'vit', lvl: 1, price: 24000, egg: 1050 },
  { id: 'tho', lvl: 1, price: 25000, egg: 1100 },
  { id: 'de', lvl: 1, price: 26000, egg: 1150 },
  { id: 'cuu', lvl: 1, price: 27000, egg: 1200 },
  // ---- Lv6 ----
  { id: 'lon', lvl: 6, price: 45000, egg: 1400 },
  { id: 'bo_sua', lvl: 6, price: 50000, egg: 1550 },
  { id: 'ngua', lvl: 6, price: 55000, egg: 1700 },
  // ---- Lv12 ----
  { id: 'ga_tay', lvl: 12, price: 323000, egg: 1800 },
  { id: 'ngong', lvl: 12, price: 350000, egg: 1950 },
  { id: 'trau', lvl: 12, price: 377000, egg: 2100 },
  // ---- Lv20 ----
  { id: 'lac_da', lvl: 20, price: 402000, egg: 2200 },
  { id: 'huou', lvl: 20, price: 421000, egg: 2300 },
  { id: 'voi', lvl: 20, price: 439000, egg: 2400 },
  { id: 'ngua_van', lvl: 20, price: 457000, egg: 2500 },
  // ---- Lv30 ----
  { id: 'bo_tot', lvl: 30, price: 470000, egg: 2700 },
  { id: 'bao_dom', lvl: 30, price: 496000, egg: 2850 },
  { id: 'cho_soi', lvl: 30, price: 522000, egg: 3000 },
  // ---- Lv40 ----
  { id: 'gau_truc', lvl: 40, price: 485000, egg: 3000 },
  { id: 'gau_nau', lvl: 40, price: 509000, egg: 3150 },
  { id: 'khi_dot', lvl: 40, price: 530000, egg: 3280 },
  // ---- Lv50 ----
  { id: 'su_tu', lvl: 50, price: 500000, egg: 3300 },
  { id: 'ca_sau', lvl: 50, price: 523000, egg: 3450 },
  { id: 'lac_da_kb', lvl: 50, price: 542000, egg: 3580 },
  // ---- Lv70 ----
  { id: 'ho', lvl: 70, price: 5000000, egg: 3600 },
  { id: 'nhim', lvl: 70, price: 5139000, egg: 3700 },
  { id: 'luoi', lvl: 70, price: 5250000, egg: 3780 },
  // ---- Lv80 ----
  { id: 'te_giac', lvl: 80, price: 10000000, egg: 3800 },
  { id: 'ha_ma', lvl: 80, price: 10263000, egg: 3900 },
  { id: 'duoi_uoi', lvl: 80, price: 10421000, egg: 3960 },
  // ---- Lv100 ----
  { id: 'huou_cao_co', lvl: 100, price: 15000000, egg: 4000 },
  { id: 'ky_lan', lvl: 100, price: 15750000, egg: 4200 },
  { id: 'rong_dat', lvl: 100, price: 16875000, egg: 4500 },
];
const ANIMAL_MAP = Object.fromEntries(ANIMALS.map(a => [a.id, a]));

function xpNeeded(level) { return level * 500; }

/* =========================== Káº¾T Ná»I DATABASE (kiá»ƒu cache cho serverless) ===========================
   TrĂªn Vercel, má»—i request cĂ³ thá»ƒ cháº¡y trĂªn má»™t "phiĂªn báº£n hĂ m" khĂ¡c nhau, nĂªn khĂ´ng thá»ƒ
   káº¿t ná»‘i 1 láº§n rá»“i giá»¯ mĂ£i nhÆ° server cháº¡y liĂªn tá»¥c. Äoáº¡n dÆ°á»›i Ä‘Ă¢y lÆ°u láº¡i káº¿t ná»‘i Ä‘Ă£ cĂ³
   (náº¿u cĂ²n) Ä‘á»ƒ tĂ¡i sá»­ dá»¥ng, chá»‰ táº¡o káº¿t ná»‘i má»›i khi thá»±c sá»± cáº§n. */
mongoose.set('strictQuery', true);
let cachedConnection = null;
async function connectDB() {
  if (cachedConnection && mongoose.connection.readyState === 1) return cachedConnection;
  cachedConnection = await mongoose.connect(MONGODB_URI);
  return cachedConnection;
}

/* =========================== SCHEMA =========================== */
const PlayerSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true, index: true },
  username: { type: String, default: '' },
  level: { type: Number, default: 1 },
  xp: { type: Number, default: 0 },
  gold: { type: Number, default: 50000 }, // vĂ ng khá»Ÿi Ä‘áº§u khi táº¡o tĂ i khoáº£n
  owned: { type: Map, of: Number, default: {} },        // animalId -> sá»‘ lÆ°á»£ng (tá»‘i Ä‘a MAX_OWNED)
  eggs: { type: Map, of: Number, default: {} },          // animalId -> sá»‘ trá»©ng Ä‘ang cĂ³
  animalLevel: { type: Map, of: Number, default: {} },    // animalId -> cáº¥p nĂ¢ng cáº¥p (1-20)
  lastCollected: { type: Map, of: Number, default: {} },  // animalId -> timestamp (ms) láº§n tĂ­nh trá»©ng gáº§n nháº¥t
}, { timestamps: true });

const Player = mongoose.model('Player', PlayerSchema);

/* =========================== TIá»†N ĂCH CHá»NG Sáº¬P =========================== */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
process.on('unhandledRejection', (reason) => console.error('â ï¸ unhandledRejection:', reason));
process.on('uncaughtException', (err) => console.error('â ï¸ uncaughtException:', err));

/* =========================== XĂC THá»°C TELEGRAM =========================== */
function verifyTelegramInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const pairs = [];
  for (const [key, value] of params.entries()) pairs.push(`${key}=${value}`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computedHash !== hash) return null;

  const userStr = params.get('user');
  if (!userStr) return null;
  try { return JSON.parse(userStr); } catch { return null; }
}

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'ChÆ°a Ä‘Äƒng nháº­p.' });

    const payload = jwt.verify(token, JWT_SECRET);
    const player = await Player.findOne({ telegramId: payload.telegramId });
    if (!player) return res.status(401).json({ error: 'KhĂ´ng tĂ¬m tháº¥y ngÆ°á»i chÆ¡i.' });

    req.player = player;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'PhiĂªn Ä‘Äƒng nháº­p khĂ´ng há»£p lá»‡, vui lĂ²ng má»Ÿ láº¡i game.' });
  }
}

/* =========================== LOGIC GAME (SERVER-AUTHORITATIVE) =========================== */

function settleEggs(player) {
  const now = Date.now();
  let changed = false;
  for (const animal of ANIMALS) {
    const owned = player.owned.get(animal.id) || 0;
    if (owned <= 0) continue;

    let last = player.lastCollected.get(animal.id);
    if (last === undefined) { player.lastCollected.set(animal.id, now); continue; }

    const elapsedSec = (now - last) / 1000;
    const cycles = Math.floor(elapsedSec / EGG_TIME_SEC);
    if (cycles > 0) {
      const gained = cycles * owned;
      const current = player.eggs.get(animal.id) || 0;
      player.eggs.set(animal.id, current + gained);
      player.lastCollected.set(animal.id, last + cycles * EGG_TIME_SEC * 1000);
      changed = true;
    }
  }
  return changed;
}

function animalLevelOf(player, id) { return player.animalLevel.get(id) || 1; }

function effectiveEggValue(player, animal) {
  const lvl = animalLevelOf(player, animal.id);
  return Math.round(animal.egg * (1 + 0.1 * (lvl - 1)));
}

function upgradeCostFor(player, animal) {
  const lvl = animalLevelOf(player, animal.id);
  if (lvl >= MAX_ANIMAL_LEVEL) return null;
  return Math.round(animal.price * 0.4 * lvl);
}

function addXpAndGold(player, goldGain, xpGain) {
  player.gold += goldGain;
  player.xp += xpGain;
  while (player.xp >= xpNeeded(player.level)) {
    player.xp -= xpNeeded(player.level);
    player.level += 1;
  }
}

function serializeState(player) {
  const now = Date.now();
  const owned = Object.fromEntries(player.owned);
  const eggs = Object.fromEntries(player.eggs);
  const animalLevel = Object.fromEntries(player.animalLevel);
  const prices = Object.fromEntries(ANIMALS.map(a => [a.id, a.price]));
  const eggValues = Object.fromEntries(ANIMALS.map(a => [a.id, effectiveEggValue(player, a)]));
  const upgradeCosts = Object.fromEntries(ANIMALS.map(a => [a.id, upgradeCostFor(player, a)]));

  const nextEggSec = {};
  for (const animal of ANIMALS) {
    const last = player.lastCollected.get(animal.id);
    if (last === undefined) { nextEggSec[animal.id] = EGG_TIME_SEC; continue; }
    const elapsedSec = (now - last) / 1000;
    const remain = EGG_TIME_SEC - (elapsedSec % EGG_TIME_SEC);
    nextEggSec[animal.id] = Math.max(0, Math.round(remain));
  }

  return {
    level: player.level, xp: player.xp, xpNeeded: xpNeeded(player.level),
    gold: player.gold, owned, eggs, animalLevel, prices, eggValues, upgradeCosts,
    eggTime: EGG_TIME_SEC, nextEggSec, maxOwned: MAX_OWNED, maxAnimalLevel: MAX_ANIMAL_LEVEL,
  };
}

/* =========================== APP SETUP =========================== */
const app = express();
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(cors({ origin: ALLOWED_ORIGIN || '*' }));

// Náº¿u thiáº¿u biáº¿n mĂ´i trÆ°á»ng, tráº£ lá»—i rĂµ rĂ ng thay vĂ¬ lĂ m sáº­p cáº£ hĂ m serverless.
app.use((req, res, next) => {
  if (!MONGODB_URI || !BOT_TOKEN || !JWT_SECRET) {
    return res.status(500).json({ error: 'Server chÆ°a Ä‘Æ°á»£c cáº¥u hĂ¬nh Ä‘á»§ biáº¿n mĂ´i trÆ°á»ng (MONGODB_URI/BOT_TOKEN/JWT_SECRET) trĂªn Vercel.' });
  }
  next();
});

app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 60 }));

// Äáº£m báº£o Ä‘Ă£ káº¿t ná»‘i MongoDB trÆ°á»›c khi xá»­ lĂ½ báº¥t ká»³ request nĂ o (báº¯t buá»™c trĂªn Vercel).
app.use(asyncHandler(async (req, res, next) => {
  await connectDB();
  next();
}));

/* =========================== ROUTES =========================== */

app.post('/api/auth', asyncHandler(async (req, res) => {
  const { initData } = req.body || {};
  if (!initData) return res.status(400).json({ error: 'Thiáº¿u initData.' });

  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser || !tgUser.id) return res.status(401).json({ error: 'XĂ¡c thá»±c Telegram tháº¥t báº¡i.' });

  const telegramId = String(tgUser.id);
  let player = await Player.findOne({ telegramId });
  if (!player) {
    player = await Player.create({ telegramId, username: tgUser.username || tgUser.first_name || '' });
  }
  settleEggs(player);
  await player.save();

  const token = jwt.sign({ telegramId }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, state: serializeState(player) });
}));

app.get('/api/state', authMiddleware, asyncHandler(async (req, res) => {
  const player = req.player;
  settleEggs(player);
  await player.save();
  res.json({ state: serializeState(player) });
}));

app.post('/api/buy', authMiddleware, asyncHandler(async (req, res) => {
  const { animalId } = req.body || {};
  const animal = ANIMAL_MAP[animalId];
  if (!animal) return res.status(400).json({ error: 'Con váº­t khĂ´ng tá»“n táº¡i.' });

  const player = req.player;
  settleEggs(player);

  if (player.level < animal.lvl) return res.status(400).json({ error: `Cáº§n Ä‘áº¡t cáº¥p ${animal.lvl} Ä‘á»ƒ mua con váº­t nĂ y.` });
  const owned = player.owned.get(animalId) || 0;
  if (owned >= MAX_OWNED) return res.status(400).json({ error: `ÄĂ£ nuĂ´i tá»‘i Ä‘a ${MAX_OWNED} con rá»“i.` });
  if (player.gold < animal.price) return res.status(400).json({ error: 'KhĂ´ng Ä‘á»§ vĂ ng.' });

  player.gold -= animal.price;
  player.owned.set(animalId, owned + 1);
  if (player.lastCollected.get(animalId) === undefined) player.lastCollected.set(animalId, Date.now());

  await player.save();
  res.json({ state: serializeState(player) });
}));

app.post('/api/upgrade', authMiddleware, asyncHandler(async (req, res) => {
  const { animalId } = req.body || {};
  const animal = ANIMAL_MAP[animalId];
  if (!animal) return res.status(400).json({ error: 'Con váº­t khĂ´ng tá»“n táº¡i.' });

  const player = req.player;
  if ((player.owned.get(animalId) || 0) <= 0) return res.status(400).json({ error: 'Báº¡n chÆ°a nuĂ´i con nĂ y.' });

  const cost = upgradeCostFor(player, animal);
  if (cost === null) return res.status(400).json({ error: 'Con nĂ y Ä‘Ă£ Ä‘áº¡t cáº¥p tá»‘i Ä‘a.' });
  if (player.gold < cost) return res.status(400).json({ error: 'KhĂ´ng Ä‘á»§ vĂ ng Ä‘á»ƒ nĂ¢ng cáº¥p.' });

  player.gold -= cost;
  player.animalLevel.set(animalId, animalLevelOf(player, animalId) + 1);

  await player.save();
  res.json({ state: serializeState(player) });
}));

app.post('/api/sell', authMiddleware, asyncHandler(async (req, res) => {
  const { animalId, qty } = req.body || {};
  const animal = ANIMAL_MAP[animalId];
  if (!animal) return res.status(400).json({ error: 'Con váº­t khĂ´ng tá»“n táº¡i.' });

  const player = req.player;
  settleEggs(player);

  const have = player.eggs.get(animalId) || 0;
  const n = Math.min(Number(qty) || have, have);
  if (n <= 0) return res.status(400).json({ error: 'KhĂ´ng cĂ³ trá»©ng Ä‘á»ƒ bĂ¡n.' });

  const eggVal = effectiveEggValue(player, animal);
  player.eggs.set(animalId, have - n);
  addXpAndGold(player, eggVal * n, Math.round(eggVal / 100) * n);

  await player.save();
  res.json({ state: serializeState(player) });
}));

app.post('/api/sell-all', authMiddleware, asyncHandler(async (req, res) => {
  const player = req.player;
  settleEggs(player);

  let goldGain = 0, xpGain = 0, any = false;
  for (const animal of ANIMALS) {
    const n = player.eggs.get(animal.id) || 0;
    if (n > 0) {
      any = true;
      const eggVal = effectiveEggValue(player, animal);
      goldGain += eggVal * n;
      xpGain += Math.round(eggVal / 100) * n;
      player.eggs.set(animal.id, 0);
    }
  }
  if (!any) return res.status(400).json({ error: 'KhĂ´ng cĂ³ trá»©ng Ä‘á»ƒ bĂ¡n.' });

  addXpAndGold(player, goldGain, xpGain);
  await player.save();
  res.json({ state: serializeState(player) });
}));

// Báº£ng xáº¿p háº¡ng THáº¬T dĂ¹ng chung cho má»i ngÆ°á»i chÆ¡i â€” sáº¯p theo vĂ ng, top 10.
app.get('/api/leaderboard', asyncHandler(async (req, res) => {
  const top = await Player.find({}).sort({ gold: -1 }).limit(10)
    .select('username gold level -_id').lean();
  res.json({ list: top.map(p => ({ name: p.username || 'NgÆ°á»i chÆ¡i áº©n danh', gold: p.gold, level: p.level })) });
}));

/* =========================== Xá»¬ LĂ Lá»–I CHUNG (chá»‘ng sáº­p) =========================== */
app.use((req, res) => res.status(404).json({ error: 'KhĂ´ng tĂ¬m tháº¥y Ä‘Æ°á»ng dáº«n API.' }));
app.use((err, req, res, next) => {
  console.error('đŸ”¥ Lá»—i server:', err);
  res.status(500).json({ error: 'ÄĂ£ xáº£y ra lá»—i phĂ­a mĂ¡y chá»§, vui lĂ²ng thá»­ láº¡i.' });
});

// TrĂªn Vercel KHĂ”NG dĂ¹ng app.listen() â€” thay vĂ o Ä‘Ă³ xuáº¥t app ra Ä‘á»ƒ Vercel tá»± gá»i má»—i khi cĂ³ request.
module.exports = app;
