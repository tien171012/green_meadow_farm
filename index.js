/* =============================================================================
   GREEN MEADOW FARM — server.js
   Backend Node.js + Express + MongoDB (Mongoose)
   -----------------------------------------------------------------------------
   Đây là nơi DUY NHẤT quyết định vàng, trứng, cấp độ nâng cấp của người chơi,
   và cũng là nơi lưu bảng xếp hạng THẬT dùng chung cho mọi người chơi
   (thay cho Firebase). File HTML chỉ hiển thị — mọi hành động (mua thú,
   nâng cấp, bán trứng, mua thức ăn) phải đi qua API dưới đây, nên sửa dữ liệu
   bằng F12 trên máy người chơi sẽ KHÔNG có tác dụng.

   Có thể DÙNG CHUNG cụm MongoDB Atlas bạn đã tạo cho Aqua Paradise —
   chỉ cần đổi TÊN DATABASE trong MONGODB_URI (ví dụ .../green_meadow thay
   vì .../aqua_paradise), không cần tạo cụm mới.

   Cách chạy: giống hệt Aqua Paradise — deploy lên Render/Railway (điền các
   biến môi trường trong .env.example), rồi copy URL vừa deploy vào biến
   API_BASE trong file green_meadow_farm.html.

   -----------------------------------------------------------------------------
   MỚI: TÍNH NĂNG MUA THỨC ĂN — CHUYỂN KHOẢN ZALOPAY THỦ CÔNG, ADMIN DUYỆT
   -----------------------------------------------------------------------------
   KHÔNG cần đăng ký merchant ZaloPay, KHÔNG cần CCCD, KHÔNG cần đợi duyệt gì
   từ ZaloPay. Luồng hoạt động:

     1. Người chơi bấm mua thức ăn trong game → app hiện số điện thoại
        ZaloPay của bạn (sửa ở hằng số ZALOPAY_INFO bên dưới) để họ chuyển
        khoản đúng số tiền.
     2. Người chơi chuyển khoản xong, bấm nút "Tôi đã chuyển" trong game →
        gọi API /api/request-food → hệ thống tạo 1 yêu cầu ở trạng thái
        "đang chờ duyệt" và TỰ ĐỘNG NHẮN TELEGRAM báo cho bạn (admin), kèm
        mã yêu cầu và 2 lệnh để bạn gõ thẳng vào khung chat với bot.
     3. Bạn kiểm tra đã nhận đủ tiền chưa (mở app ZaloPay xem lịch sử giao
        dịch), rồi gõ vào đúng đoạn chat với BOT của bạn trên Telegram:
              /approve <mã yêu cầu>     -> duyệt, tự cộng thức ăn cho người chơi
              /reject <mã yêu cầu>      -> từ chối yêu cầu đó
        Hệ thống sẽ tự nhắn lại cho người chơi biết kết quả.

   CẦN LÀM TRƯỚC KHI DÙNG (làm 1 lần):

   a) Thêm biến môi trường mới trên Vercel: ADMIN_TELEGRAM_ID
      — là ID Telegram của CHÍNH BẠN (không phải username, mà là 1 dãy số).
      Cách lấy: mở Telegram, tìm bot tên "@userinfobot", bấm Start, nó sẽ
      trả về "Id: 123456789" — copy đúng dãy số đó.

   b) Sửa số điện thoại/tên nhận tiền ZaloPay ở hằng số ZALOPAY_INFO bên dưới
      cho đúng thông tin thật của bạn.

   c) Đăng ký webhook (chỉ 1 lần duy nhất) — mở link sau bằng trình duyệt,
      thay đúng BOT_TOKEN và domain Vercel của bạn:
      https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<domain-vercel-cua-ban>/api/telegram-webhook
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
  ADMIN_TELEGRAM_ID, // ID Telegram của bạn (admin) — dùng @userinfobot để lấy
  PORT = 3000,
} = process.env;

if (!MONGODB_URI || !BOT_TOKEN || !JWT_SECRET) {
  console.error('⚠️ Thiếu biến môi trường bắt buộc (MONGODB_URI/BOT_TOKEN/JWT_SECRET). Server sẽ trả lỗi 500 cho mọi request cho tới khi được cấu hình đủ trên Vercel.');
}
if (!ADMIN_TELEGRAM_ID) {
  console.error('⚠️ Thiếu ADMIN_TELEGRAM_ID — tính năng mua thức ăn sẽ không gửi được thông báo duyệt cho admin.');
}

/* =========================== THÔNG TIN NHẬN TIỀN ZALOPAY — SỬA LẠI CHO ĐÚNG =========================== */
const ZALOPAY_INFO = {
  phone: '0343430581',
  accountName: 'LE TRONG TIEN',
};

/* =========================== DỮ LIỆU CON VẬT (NGUỒN SỰ THẬT DUY NHẤT) =========================== */
const EGG_TIME_SEC = 30;      // giây / quả (bình thường), áp dụng cho mọi con vật
const MAX_OWNED = 3;          // mỗi loại thú tối đa 3 con
const MAX_ANIMAL_LEVEL = 20;  // cấp nâng cấp tối đa cho mỗi con vật

/* =========================== THỨC ĂN (MUA BẰNG CHUYỂN KHOẢN ZALOPAY) =========================== */
const BOOSTED_EGG_TIME_SEC = 15;     // thời gian ra trứng khi có thức ăn "speed"
const GOLD_BOOST_MULTIPLIER = 1.3;   // +30% giá trị trứng khi có thức ăn "gold"
const BOOST_DURATION_MS = 24 * 60 * 60 * 1000; // hiệu lực 24 giờ

/* =========================== NHẬN THƯỞNG QUA LINK (YeuMoney) =========================== */
const REWARD_LINK_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 tiếng / lần
const REWARD_LINK_GOLD = 100000; // vàng thưởng mỗi lần — sửa số này nếu muốn đổi

/* =========================== ĐUA TOP HÀNG TUẦN — CÓ GIẢI THƯỞNG THẬT =========================== */
// Xếp hạng theo vàng KIẾM ĐƯỢC trong tuần (không phải tổng vàng đang có) — tự động
// reset về 0 khi sang tuần mới, không cần bạn bấm nút gì. Vàng thật của người chơi
// (để mua/nâng cấp thú) KHÔNG bị ảnh hưởng, chỉ số liệu xếp hạng này reset thôi.
// Giải thưởng do BẠN tự chuyển tay qua ZaloPay/ngân hàng cho người thắng mỗi tuần —
// hệ thống không tự động chuyển tiền.
const WEEKLY_PRIZES = [10000, 7000, 5000, 2000, 2000, 2000, 2000, 2000, 2000, 2000]; // Top1..Top10 (VNĐ)
const WEEKLY_PRIZE_MIN_GOLD = 5000000; // vàng-tuần tối thiểu mới được tính vào bảng xếp hạng/nhận giải

/* =========================== CON VẬT ĐÓI — TẠM NGỪNG ĐẺ, CHẾT NẾU ĐÓI QUÁ LÂU =========================== */
// Nếu con vật KHÔNG được cho ăn (hết hạn "thức ăn chống đói") thì nó ĐÓI — không đẻ thêm
// trứng nữa cho tới khi được cho ăn lại. Nếu đói LIÊN TỤC quá HUNGRY_DEATH_MS (2 tiếng)
// mà không được cho ăn kịp thì CHẾT — mất TOÀN BỘ số con đang nuôi của loài đó (kể cả
// cấp đã nâng), coi như phải mua lại từ đầu.
// "Thức ăn chống đói" mua bằng TIỀN THẬT qua ZaloPay giống thức ăn tăng tốc/tăng vàng,
// hiệu lực 24 giờ, giá 1 mức duy nhất cho mọi con vật.
const HUNGRY_DEATH_MS = 2 * 60 * 60 * 1000; // đói liên tục 2 tiếng không cho ăn kịp là chết

// Mốc "đầu tuần" dùng chung — lấy 00:00 thứ Hai gần nhất (giờ UTC) làm mốc so sánh.
function getCurrentWeekStart() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=CN, 1=T2, ... 6=T7
  const diffToMonday = (day === 0 ? 6 : day - 1); // số ngày lùi về thứ Hai
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diffToMonday, 0, 0, 0));
  return monday.getTime();
}

// Vàng tuần hiệu lực của 1 người chơi — nếu tuần đã đổi mà chưa "chạm" vào thì coi như 0 (chưa cần ghi vào DB).
function effectiveWeeklyGold(player, currentWeekStart) {
  return player.weeklyGoldWeekStart === currentWeekStart ? (player.weeklyGold || 0) : 0;
}

// Gọi hàm này mỗi khi cộng vàng cho người chơi (bán trứng, nhận thưởng...) để cập nhật đúng vàng-tuần.
function bumpWeeklyGold(player, amount) {
  if (!amount) return;
  const ws = getCurrentWeekStart();
  if (player.weeklyGoldWeekStart !== ws) {
    player.weeklyGoldWeekStart = ws;
    player.weeklyGold = 0;
  }
  player.weeklyGold += amount;
}

const FOOD_TYPES = {
  speed: { price: 1000, name: 'Thức ăn tăng tốc', desc: 'Giảm thời gian ra trứng còn 15 giây/quả trong 24 giờ' },
  gold: { price: 1000, name: 'Thức ăn tăng vàng', desc: 'Tăng 30% giá trị trứng khi bán trong 24 giờ' },
  feed: { price: 1000, name: 'Thức ăn (chống đói)', desc: 'Cho con vật ăn để tiếp tục đẻ trứng trong 24 giờ — nếu đói sẽ tạm ngừng đẻ' },
};

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

/* =========================== KẾT NỐI DATABASE (kiểu cache cho serverless) ===========================
   Trên Vercel, mỗi request có thể chạy trên một "phiên bản hàm" khác nhau, nên không thể
   kết nối 1 lần rồi giữ mãi như server chạy liên tục. Đoạn dưới đây lưu lại kết nối đã có
   (nếu còn) để tái sử dụng, chỉ tạo kết nối mới khi thực sự cần. */
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
  gold: { type: Number, default: 50000 }, // vàng khởi đầu khi tạo tài khoản
  owned: { type: Map, of: Number, default: {} },          // animalId -> số lượng (tối đa MAX_OWNED)
  eggs: { type: Map, of: Number, default: {} },            // animalId -> số trứng đang có
  animalLevel: { type: Map, of: Number, default: {} },     // animalId -> cấp nâng cấp (1-20)
  lastCollected: { type: Map, of: Number, default: {} },   // animalId -> timestamp (ms) lần tính trứng gần nhất
  speedBoost: { type: Map, of: Number, default: {} },      // animalId -> timestamp (ms) hết hạn thức ăn "speed"
  goldBoost: { type: Map, of: Number, default: {} },       // animalId -> timestamp (ms) hết hạn thức ăn "gold"
  lastRewardClaim: { type: Number, default: 0 },            // timestamp (ms) lần cuối nhận thưởng qua link YeuMoney
  weeklyGold: { type: Number, default: 0 },                  // vàng kiếm được trong tuần hiện tại (để xếp hạng có giải)
  weeklyGoldWeekStart: { type: Number, default: 0 },         // timestamp (ms) đầu tuần tương ứng với weeklyGold ở trên
  fedUntil: { type: Map, of: Number, default: {} },           // animalId -> timestamp (ms) hết hạn cho ăn — hết hạn là ĐÓI, tạm ngừng đẻ trứng
}, { timestamps: true });

const Player = mongoose.model('Player', PlayerSchema);

// Mỗi yêu cầu mua thức ăn (chờ admin duyệt sau khi người chơi báo đã chuyển khoản).
const PaymentRequestSchema = new mongoose.Schema({
  telegramId: { type: String, required: true },
  username: { type: String, default: '' },
  animalId: { type: String, required: true },
  foodType: { type: String, required: true },  // 'speed' | 'gold'
  price: { type: Number, required: true },      // số tiền VNĐ cần chuyển
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
}, { timestamps: true });

const PaymentRequest = mongoose.model('PaymentRequest', PaymentRequestSchema);

/* =========================== TIỆN ÍCH CHỐNG SẬP =========================== */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
process.on('unhandledRejection', (reason) => console.error('⚠️ unhandledRejection:', reason));
process.on('uncaughtException', (err) => console.error('⚠️ uncaughtException:', err));

/* =========================== GỌI TELEGRAM BOT API =========================== */
async function telegramApi(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function sendTelegramMessage(chatId, text) {
  return telegramApi('sendMessage', { chat_id: chatId, text });
}

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

function hasActiveBoost(boostMap, animalId) {
  const exp = boostMap.get(animalId);
  return exp !== undefined && exp > Date.now();
}

// Thời gian ra trứng thực tế của 1 con vật, có tính thức ăn "speed" đang còn hạn hay không.
function eggTimeSecOf(player, animalId) {
  return hasActiveBoost(player.speedBoost, animalId) ? BOOSTED_EGG_TIME_SEC : EGG_TIME_SEC;
}

function settleEggs(player) {
  const now = Date.now();
  let changed = false;
  const deaths = []; // animalId nào vừa chết đói (mất toàn bộ) trong lần settle này

  for (const animal of ANIMALS) {
    const owned = player.owned.get(animal.id) || 0;
    if (owned <= 0) continue;

    let last = player.lastCollected.get(animal.id);
    if (last === undefined) { player.lastCollected.set(animal.id, now); continue; }

    const fedUntilTs = player.fedUntil.get(animal.id);
    const isFed = fedUntilTs !== undefined && fedUntilTs > now;

    if (!isFed) {
      const hungrySinceMs = fedUntilTs !== undefined ? (now - fedUntilTs) : 0;
      if (hungrySinceMs >= HUNGRY_DEATH_MS) {
        // Đói liên tục quá lâu — chết, mất TOÀN BỘ con đang nuôi của loài này (coi như mua lại từ đầu).
        deaths.push(animal.id);
        player.owned.delete(animal.id);
        player.eggs.delete(animal.id);
        player.animalLevel.delete(animal.id);
        player.lastCollected.delete(animal.id);
        player.fedUntil.delete(animal.id);
        player.speedBoost.delete(animal.id);
        player.goldBoost.delete(animal.id);
        changed = true;
        continue;
      }
      // Đói nhưng chưa tới ngưỡng chết — tạm ngừng đẻ trứng, không cộng dồn thời gian chờ.
      player.lastCollected.set(animal.id, now);
      continue;
    }

    const eggTimeSec = eggTimeSecOf(player, animal.id);
    const elapsedSec = (now - last) / 1000;
    const cycles = Math.floor(elapsedSec / eggTimeSec);
    if (cycles > 0) {
      const gained = cycles * owned;
      const current = player.eggs.get(animal.id) || 0;
      player.eggs.set(animal.id, current + gained);
      player.lastCollected.set(animal.id, last + cycles * eggTimeSec * 1000);
      changed = true;
    }
  }
  return { changed, deaths };
}

function animalLevelOf(player, id) { return player.animalLevel.get(id) || 1; }

function effectiveEggValue(player, animal) {
  const lvl = animalLevelOf(player, animal.id);
  let value = Math.round(animal.egg * (1 + 0.1 * (lvl - 1)));
  if (hasActiveBoost(player.goldBoost, animal.id)) value = Math.round(value * GOLD_BOOST_MULTIPLIER);
  return value;
}

function upgradeCostFor(player, animal) {
  const lvl = animalLevelOf(player, animal.id);
  if (lvl >= MAX_ANIMAL_LEVEL) return null;
  return Math.round(animal.price * 0.4 * lvl);
}

function addXpAndGold(player, goldGain, xpGain) {
  player.gold += goldGain;
  bumpWeeklyGold(player, goldGain);
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
  const speedBoost = Object.fromEntries(player.speedBoost);   // animalId -> hết hạn (ms)
  const goldBoost = Object.fromEntries(player.goldBoost);     // animalId -> hết hạn (ms)
  const fedUntil = Object.fromEntries(player.fedUntil); // animalId -> hết hạn (ms) cho ăn, hết hạn là đói

  const nextEggSec = {};
  const eggTimeByAnimal = {};
  for (const animal of ANIMALS) {
    const eggTimeSec = eggTimeSecOf(player, animal.id);
    eggTimeByAnimal[animal.id] = eggTimeSec;
    const last = player.lastCollected.get(animal.id);
    if (last === undefined) { nextEggSec[animal.id] = eggTimeSec; continue; }
    const elapsedSec = (now - last) / 1000;
    const remain = eggTimeSec - (elapsedSec % eggTimeSec);
    nextEggSec[animal.id] = Math.max(0, Math.round(remain));
  }

  return {
    level: player.level, xp: player.xp, xpNeeded: xpNeeded(player.level),
    gold: player.gold, owned, eggs, animalLevel, prices, eggValues, upgradeCosts,
    eggTime: EGG_TIME_SEC, nextEggSec, maxOwned: MAX_OWNED, maxAnimalLevel: MAX_ANIMAL_LEVEL,
    speedBoost, goldBoost, eggTimeByAnimal, fedUntil, hungryDeathMs: HUNGRY_DEATH_MS,
    foodPrices: { speed: FOOD_TYPES.speed.price, gold: FOOD_TYPES.gold.price, feed: FOOD_TYPES.feed.price },
    rewardLink: {
      cooldownMs: REWARD_LINK_COOLDOWN_MS,
      gold: REWARD_LINK_GOLD,
      nextAvailableAt: (player.lastRewardClaim || 0) + REWARD_LINK_COOLDOWN_MS,
    },
  };
}

/* =========================== APP SETUP =========================== */
const app = express();
// Vercel chạy sau 1 lớp proxy — cần khai báo để express-rate-limit đọc đúng IP
// người dùng qua header X-Forwarded-For, nếu không sẽ báo lỗi ValidationError.
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(cors({ origin: ALLOWED_ORIGIN || '*' }));

// Nếu thiếu biến môi trường, trả lỗi rõ ràng thay vì làm sập cả hàm serverless.
app.use((req, res, next) => {
  if (!MONGODB_URI || !BOT_TOKEN || !JWT_SECRET) {
    return res.status(500).json({ error: 'Server chưa được cấu hình đủ biến môi trường (MONGODB_URI/BOT_TOKEN/JWT_SECRET) trên Vercel.' });
  }
  next();
});

app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 60 }));

// Đảm bảo đã kết nối MongoDB trước khi xử lý bất kỳ request nào (bắt buộc trên Vercel).
app.use(asyncHandler(async (req, res, next) => {
  await connectDB();
  next();
}));

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
  const { deaths } = settleEggs(player);
  await player.save();

  const token = jwt.sign({ telegramId }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, state: serializeState(player), deaths });
}));

app.get('/api/state', authMiddleware, asyncHandler(async (req, res) => {
  const player = req.player;
  const { deaths } = settleEggs(player);
  await player.save();
  res.json({ state: serializeState(player), deaths });
}));

app.post('/api/buy', authMiddleware, asyncHandler(async (req, res) => {
  const { animalId } = req.body || {};
  const animal = ANIMAL_MAP[animalId];
  if (!animal) return res.status(400).json({ error: 'Con vật không tồn tại.' });

  const player = req.player;
  const { deaths } = settleEggs(player);

  if (player.level < animal.lvl) return res.status(400).json({ error: `Cần đạt cấp ${animal.lvl} để mua con vật này.` });
  const owned = player.owned.get(animalId) || 0;
  if (owned >= MAX_OWNED) return res.status(400).json({ error: `Đã nuôi tối đa ${MAX_OWNED} con rồi.` });
  if (player.gold < animal.price) return res.status(400).json({ error: 'Không đủ vàng.' });

  player.gold -= animal.price;
  player.owned.set(animalId, owned + 1);
  if (player.lastCollected.get(animalId) === undefined) player.lastCollected.set(animalId, Date.now());
  // Con vật mới mua được "cho ăn sẵn" 24 giờ đầu, khỏi bị đói ngay khi vừa mua.
  if (!hasActiveBoost(player.fedUntil, animalId)) player.fedUntil.set(animalId, Date.now() + BOOST_DURATION_MS);

  await player.save();
  res.json({ state: serializeState(player), deaths });
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
  const { deaths } = settleEggs(player);

  const have = player.eggs.get(animalId) || 0;
  const n = Math.min(Number(qty) || have, have);
  if (n <= 0) return res.status(400).json({ error: 'Không có trứng để bán.' });

  const eggVal = effectiveEggValue(player, animal);
  player.eggs.set(animalId, have - n);
  addXpAndGold(player, eggVal * n, Math.round(eggVal / 100) * n);

  await player.save();
  res.json({ state: serializeState(player), deaths });
}));

app.post('/api/sell-all', authMiddleware, asyncHandler(async (req, res) => {
  const player = req.player;
  const { deaths } = settleEggs(player);

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
  if (!any && !deaths.length) return res.status(400).json({ error: 'Không có trứng để bán.' });

  if (goldGain > 0) addXpAndGold(player, goldGain, xpGain);
  await player.save();
  res.json({ state: serializeState(player), deaths });
}));

// Bảng xếp hạng THẬT dùng chung cho mọi người chơi — sắp theo vàng, top 10.
// Bảng xếp hạng ĐUA TOP HÀNG TUẦN — xếp theo vàng kiếm được trong tuần, tự reset khi sang tuần mới.
// Kèm giải thưởng từng hạng để hiển thị cho người chơi biết trước khi cày.
app.get('/api/leaderboard', asyncHandler(async (req, res) => {
  const ws = getCurrentWeekStart();
  // Lấy trước 1 lượng dư (200 người) theo vàng-tuần đã lưu để tính lại vàng hiệu lực rồi mới chốt top 10 —
  // tránh trường hợp người có weeklyGold cũ (tuần trước) nhưng số vẫn cao hơn người mới nếu chỉ sort thô.
  const candidates = await Player.find({}).sort({ weeklyGold: -1 }).limit(200)
    .select('username weeklyGold weeklyGoldWeekStart level -_id').lean();

  const ranked = candidates
    .map(p => ({
      name: p.username || 'Người chơi ẩn danh',
      level: p.level,
      weeklyGold: p.weeklyGoldWeekStart === ws ? (p.weeklyGold || 0) : 0,
    }))
    .filter(p => p.weeklyGold >= WEEKLY_PRIZE_MIN_GOLD) // chỉ tính người đạt tối thiểu mới lên bảng/nhận giải
    .sort((a, b) => b.weeklyGold - a.weeklyGold)
    .slice(0, 10)
    .map((p, i) => ({ ...p, prize: WEEKLY_PRIZES[i] || 0, rank: i + 1 }));

  res.json({
    list: ranked,
    weekStart: ws,
    weekEndsAt: ws + 7 * 24 * 60 * 60 * 1000,
    prizes: WEEKLY_PRIZES,
    minGoldToQualify: WEEKLY_PRIZE_MIN_GOLD,
  });
}));

/* =========================== MUA THỨC ĂN — CHUYỂN KHOẢN ZALOPAY THỦ CÔNG =========================== */

// Mua "thức ăn thường" bằng VÀNG trong game (không phải tiền thật) — bảo vệ 1 con vật khỏi chết trong 4 tiếng.
// Client gọi cái này trước để lấy số điện thoại/tên nhận tiền + giá từng loại thức ăn, hiển thị cho người chơi biết chuyển khoản đi đâu.
app.get('/api/payment-info', (req, res) => {
  res.json({ zalopay: ZALOPAY_INFO, foodPrices: { speed: FOOD_TYPES.speed.price, gold: FOOD_TYPES.gold.price, feed: FOOD_TYPES.feed.price } });
});

// Người chơi bấm "Tôi đã xem xong" sau khi mở link YeuMoney -> cộng vàng, có giới hạn thời gian chờ giữa các lần.
app.post('/api/claim-reward-link', authMiddleware, asyncHandler(async (req, res) => {
  const player = req.player;
  const now = Date.now();
  const nextAvailableAt = (player.lastRewardClaim || 0) + REWARD_LINK_COOLDOWN_MS;

  if (now < nextAvailableAt) {
    const remainMin = Math.ceil((nextAvailableAt - now) / 60000);
    return res.status(400).json({ error: `Bạn cần đợi thêm khoảng ${remainMin} phút nữa mới nhận được tiếp.` });
  }

  player.lastRewardClaim = now;
  player.gold += REWARD_LINK_GOLD;
  bumpWeeklyGold(player, REWARD_LINK_GOLD);
  await player.save();

  res.json({ state: serializeState(player) });
}));

// Người chơi bấm "Tôi đã chuyển khoản" sau khi chuyển tiền xong -> tạo yêu cầu chờ admin duyệt + tự nhắn Telegram báo admin.
app.post('/api/request-food', authMiddleware, asyncHandler(async (req, res) => {
  const { animalId, foodType } = req.body || {};
  const animal = ANIMAL_MAP[animalId];
  if (!animal) return res.status(400).json({ error: 'Con vật không tồn tại.' });

  const food = FOOD_TYPES[foodType];
  if (!food) return res.status(400).json({ error: 'Loại thức ăn không hợp lệ.' });

  const player = req.player;

  const request = await PaymentRequest.create({
    telegramId: player.telegramId,
    username: player.username,
    animalId,
    foodType,
    price: food.price,
  });

  if (ADMIN_TELEGRAM_ID) {
    await sendTelegramMessage(ADMIN_TELEGRAM_ID,
      `🔔 Yêu cầu mua thức ăn mới\n` +
      `Người chơi: ${player.username || 'ẩn danh'} (id: ${player.telegramId})\n` +
      `Thức ăn: ${food.name}\n` +
      `Con vật: ${animalId}\n` +
      `Số tiền cần nhận: ${food.price.toLocaleString('vi-VN')}đ\n\n` +
      `Sau khi kiểm tra đã nhận đủ tiền trên ZaloPay, gõ:\n` +
      `/approve ${request._id}\n` +
      `(hoặc /reject ${request._id} nếu từ chối)`
    );
  }

  res.json({ requestId: request._id, message: 'Đã gửi yêu cầu, vui lòng chờ admin duyệt sau khi chuyển khoản.' });
}));

// Người chơi có thể xem lại các yêu cầu gần đây của mình (đang chờ / đã duyệt / bị từ chối).
app.get('/api/my-requests', authMiddleware, asyncHandler(async (req, res) => {
  const list = await PaymentRequest.find({ telegramId: req.player.telegramId })
    .sort({ createdAt: -1 }).limit(20).lean();
  res.json({ list });
}));

/* =========================== TELEGRAM WEBHOOK (admin duyệt qua chat) =========================== */
app.post('/api/telegram-webhook', asyncHandler(async (req, res) => {
  const update = req.body || {};
  const message = update.message;

  if (message && message.text && message.from) {
    const isAdmin = ADMIN_TELEGRAM_ID && String(message.from.id) === String(ADMIN_TELEGRAM_ID);

    if (isAdmin) {
      const text = message.text.trim();
      const approveMatch = text.match(/^\/approve\s+(\S+)/i);
      const rejectMatch = text.match(/^\/reject\s+(\S+)/i);

      if (text === '/weeklytop') {
        const ws = getCurrentWeekStart();
        const candidates = await Player.find({}).sort({ weeklyGold: -1 }).limit(200)
          .select('username telegramId weeklyGold weeklyGoldWeekStart -_id').lean();
        const ranked = candidates
          .map(p => ({
            name: p.username || 'ẩn danh', telegramId: p.telegramId,
            weeklyGold: p.weeklyGoldWeekStart === ws ? (p.weeklyGold || 0) : 0,
          }))
          .sort((a, b) => b.weeklyGold - a.weeklyGold)
          .slice(0, 10)
          .filter(p => p.weeklyGold >= WEEKLY_PRIZE_MIN_GOLD);

        if (!ranked.length) {
          await sendTelegramMessage(ADMIN_TELEGRAM_ID, '📊 Tuần này chưa có ai kiếm được vàng để xếp hạng.');
        } else {
          const lines = ranked.map((p, i) =>
            `${i + 1}. ${p.name} (id: ${p.telegramId}) — ${p.weeklyGold.toLocaleString('vi-VN')} vàng — thưởng ${(WEEKLY_PRIZES[i] || 0).toLocaleString('vi-VN')}đ`
          );
          await sendTelegramMessage(ADMIN_TELEGRAM_ID, `🏆 Đua top tuần này:\n\n${lines.join('\n')}\n\nLiên hệ đúng id Telegram ở trên để chuyển thưởng qua ZaloPay/ngân hàng nhé.`);
        }
      }

      if (approveMatch || rejectMatch) {
        const requestId = (approveMatch || rejectMatch)[1];
        const approve = Boolean(approveMatch);

        let request = null;
        try { request = await PaymentRequest.findById(requestId); } catch { request = null; }

        if (!request) {
          await sendTelegramMessage(ADMIN_TELEGRAM_ID, `❌ Không tìm thấy yêu cầu có mã: ${requestId}`);
        } else if (request.status !== 'pending') {
          await sendTelegramMessage(ADMIN_TELEGRAM_ID, `⚠️ Yêu cầu ${requestId} đã được xử lý trước đó (${request.status}).`);
        } else if (approve) {
          request.status = 'approved';
          await request.save();

          const player = await Player.findOne({ telegramId: request.telegramId });
          if (player) {
            const expiry = Date.now() + BOOST_DURATION_MS;
            if (request.foodType === 'speed') player.speedBoost.set(request.animalId, expiry);
            if (request.foodType === 'gold') player.goldBoost.set(request.animalId, expiry);
            if (request.foodType === 'feed') player.fedUntil.set(request.animalId, expiry);
            await player.save();
          }

          await sendTelegramMessage(ADMIN_TELEGRAM_ID, `✅ Đã duyệt yêu cầu ${requestId}.`);
          await sendTelegramMessage(request.telegramId,
            `🎉 Yêu cầu mua ${FOOD_TYPES[request.foodType].name} cho con "${request.animalId}" đã được duyệt! Hiệu lực 24 giờ.`);
        } else {
          request.status = 'rejected';
          await request.save();
          await sendTelegramMessage(ADMIN_TELEGRAM_ID, `❌ Đã từ chối yêu cầu ${requestId}.`);
          await sendTelegramMessage(request.telegramId,
            `Yêu cầu mua ${FOOD_TYPES[request.foodType].name} của bạn đã bị từ chối. Vui lòng kiểm tra lại giao dịch chuyển khoản hoặc liên hệ admin.`);
        }
      }
    }
  }

  res.json({ ok: true });
}));

/* =========================== XỬ LÝ LỖI CHUNG (chống sập) =========================== */
app.use((req, res) => res.status(404).json({ error: 'Không tìm thấy đường dẫn API.' }));
app.use((err, req, res, next) => {
  console.error('🔥 Lỗi server:', err);
  res.status(500).json({ error: 'Đã xảy ra lỗi phía máy chủ, vui lòng thử lại.' });
});

// Trên Vercel KHÔNG dùng app.listen() — thay vào đó xuất app ra để Vercel tự gọi mỗi khi có request.
module.exports = app;
