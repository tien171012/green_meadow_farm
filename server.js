/* =============================================================================
   GREEN MEADOW FARM — server.js
   Backend Node.js + Express + MongoDB (Mongoose)
   -----------------------------------------------------------------------------
   Đây là nơi DUY NHẤT quyết định vàng, trứng, cấp độ nâng cấp của người chơi,
   và cũng là nơi lưu bảng xếp hạng THẬT dùng chung cho mọi người chơi
   (thay cho Firebase). File HTML chỉ hiển thị — mọi hành động (mua thú,
   nâng cấp, bán trứng) phải đi qua API dưới đây, nên sửa dữ liệu bằng F12
   trên máy người chơi sẽ KHÔNG có tác dụng.

   Có thể DÙNG CHUNG cụm MongoDB Atlas bạn đã tạo cho Aqua Paradise —
   chỉ cần đổi TÊN DATABASE trong MONGODB_URI (ví dụ .../green_meadow thay
   vì .../aqua_paradise), không cần tạo cụm mới.

   Cách chạy: giống hệt Aqua Paradise — deploy lên Render/Railway (điền các
   biến môi trường trong .env.example), rồi copy URL vừa deploy vào biến
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
  console.error('❌ Thiếu biến môi trường bắt buộc. Kiểm tra lại file .env (xem .env.example).');
  process.exit(1);
}

/* =========================== DỮ LIỆU CON VẬT (NGUỒN SỰ THẬT DUY NHẤT) =========================== */
const EGG_TIME_SEC = 30;      // giây / quả, áp dụng cho mọi con vật
const MAX_OWNED = 3;          // mỗi loại thú tối đa 3 con
const MAX_ANIMAL_LEVEL = 20;  // cấp nâng cấp tối đa cho mỗi con vật

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

/* =========================== KẾT NỐI DATABASE =========================== */
mongoose.set('strictQuery', true);
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Đã kết nối MongoDB'))
  .catch(err => {
    console.error('❌ Không kết nối được MongoDB:', err.message);
    process.exit(1);
  });

/* =========================== SCHEMA =========================== */
const PlayerSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true, index: true },
  username: { type: String, default: '' },
  level: { type: Number, default: 1 },
  xp: { type: Number, default: 0 },
  gold: { type: Number, default: 50000 }, // vàng khởi đầu khi tạo tài khoản
  owned: { type: Map, of: Number, default: {} },        // animalId -> số lượng (tối đa MAX_OWNED)
  eggs: { type: Map, of: Number, default: {} },          // animalId -> số trứng đang có
  animalLevel: { type: Map, of: Number, default: {} },    // animalId -> cấp nâng cấp (1-20)
  lastCollected: { type: Map, of: Number, default: {} },  // animalId -> timestamp (ms) lần tính trứng gần nhất
}, { timestamps: true });

const Player = mongoose.model('Player', PlayerSchema);

/* =========================== TIỆN ÍCH CHỐNG SẬP =========================== */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
process.on('unhandledRejection', (reason) => console.error('⚠️ unhandledRejection:', reason));
process.on('uncaughtException', (err) => console.error('⚠️ uncaughtException:', err));

/* =========================== XÁC THỰC TELEGRAM =========================== */
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
    if (!token) return res.status(401).json({ error: 'Chưa đăng nhập.' });

    const payload = jwt.verify(token, JWT_SECRET);
    const player = await Player.findOne({ telegramId: payload.telegramId });
    if (!player) return res.status(401).json({ error: 'Không tìm thấy người chơi.' });

    req.player = player;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Phiên đăng nhập không hợp lệ, vui lòng mở lại game.' });
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
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 60 }));

/* =========================== ROUTES =========================== */

app.post('/api/auth', asyncHandler(async (req, res) => {
  const { initData } = req.body || {};
  if (!initData) return res.status(400).json({ error: 'Thiếu initData.' });

  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser || !tgUser.id) return res.status(401).json({ error: 'Xác thực Telegram thất bại.' });

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
  if (!animal) return res.status(400).json({ error: 'Con vật không tồn tại.' });

  const player = req.player;
  settleEggs(player);

  if (player.level < animal.lvl) return res.status(400).json({ error: `Cần đạt cấp ${animal.lvl} để mua con vật này.` });
  const owned = player.owned.get(animalId) || 0;
  if (owned >= MAX_OWNED) return res.status(400).json({ error: `Đã nuôi tối đa ${MAX_OWNED} con rồi.` });
  if (player.gold < animal.price) return res.status(400).json({ error: 'Không đủ vàng.' });

  player.gold -= animal.price;
  player.owned.set(animalId, owned + 1);
  if (player.lastCollected.get(animalId) === undefined) player.lastCollected.set(animalId, Date.now());

  await player.save();
  res.json({ state: serializeState(player) });
}));

app.post('/api/upgrade', authMiddleware, asyncHandler(async (req, res) => {
  const { animalId } = req.body || {};
  const animal = ANIMAL_MAP[animalId];
  if (!animal) return res.status(400).json({ error: 'Con vật không tồn tại.' });

  const player = req.player;
  if ((player.owned.get(animalId) || 0) <= 0) return res.status(400).json({ error: 'Bạn chưa nuôi con này.' });

  const cost = upgradeCostFor(player, animal);
  if (cost === null) return res.status(400).json({ error: 'Con này đã đạt cấp tối đa.' });
  if (player.gold < cost) return res.status(400).json({ error: 'Không đủ vàng để nâng cấp.' });

  player.gold -= cost;
  player.animalLevel.set(animalId, animalLevelOf(player, animalId) + 1);

  await player.save();
  res.json({ state: serializeState(player) });
}));

app.post('/api/sell', authMiddleware, asyncHandler(async (req, res) => {
  const { animalId, qty } = req.body || {};
  const animal = ANIMAL_MAP[animalId];
  if (!animal) return res.status(400).json({ error: 'Con vật không tồn tại.' });

  const player = req.player;
  settleEggs(player);

  const have = player.eggs.get(animalId) || 0;
  const n = Math.min(Number(qty) || have, have);
  if (n <= 0) return res.status(400).json({ error: 'Không có trứng để bán.' });

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
  if (!any) return res.status(400).json({ error: 'Không có trứng để bán.' });

  addXpAndGold(player, goldGain, xpGain);
  await player.save();
  res.json({ state: serializeState(player) });
}));

// Bảng xếp hạng THẬT dùng chung cho mọi người chơi — sắp theo vàng, top 10.
app.get('/api/leaderboard', asyncHandler(async (req, res) => {
  const top = await Player.find({}).sort({ gold: -1 }).limit(10)
    .select('username gold level -_id').lean();
  res.json({ list: top.map(p => ({ name: p.username || 'Người chơi ẩn danh', gold: p.gold, level: p.level })) });
}));

/* =========================== XỬ LÝ LỖI CHUNG (chống sập) =========================== */
app.use((req, res) => res.status(404).json({ error: 'Không tìm thấy đường dẫn API.' }));
app.use((err, req, res, next) => {
  console.error('🔥 Lỗi server:', err);
  res.status(500).json({ error: 'Đã xảy ra lỗi phía máy chủ, vui lòng thử lại.' });
});

app.listen(PORT, () => console.log(`🚀 Server đang chạy tại cổng ${PORT}`));
