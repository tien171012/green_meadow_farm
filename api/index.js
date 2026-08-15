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

/* =========================== ĐIỂM DANH HÀNG NGÀY =========================== */
// Điểm danh 7 ngày liên tiếp, thưởng tăng dần, ngày 7 thưởng lớn. Bỏ lỡ 1 ngày (quá 48h
// không điểm danh) thì reset về ngày 1. Tất cả trả bằng VÀNG trong game, không tốn tiền thật.
const CHECKIN_COOLDOWN_MS = 24 * 60 * 60 * 1000;      // mỗi ngày điểm danh được 1 lần
const CHECKIN_STREAK_RESET_MS = 48 * 60 * 60 * 1000;  // quá 48h không điểm danh -> mất chuỗi
const CHECKIN_REWARDS = [5000, 8000, 12000, 16000, 20000, 25000, 100000]; // ngày 1..7

/* =========================== ĐUA TOP HÀNG TUẦN — CÓ GIẢI THƯỞNG THẬT =========================== */
// Xếp hạng theo vàng KIẾM ĐƯỢC trong tuần (không phải tổng vàng đang có) — tự động
// reset về 0 khi sang tuần mới, không cần bạn bấm nút gì. Vàng thật của người chơi
// (để mua/nâng cấp thú) KHÔNG bị ảnh hưởng, chỉ số liệu xếp hạng này reset thôi.
// Giải thưởng do BẠN tự chuyển tay qua ZaloPay/ngân hàng cho người thắng mỗi tuần —
// hệ thống không tự động chuyển tiền.
// Tỷ lệ chia giải giữa các hạng (không phải số tiền cố định nữa) — Top1 nhiều nhất, Top4-10 bằng nhau.
const WEEKLY_PRIZE_RATIOS = [12000, 10000, 8000]; // chỉ Top1, Top2, Top3 — không còn Top4-10
const WEEKLY_PRIZE_RATIO_SUM = WEEKLY_PRIZE_RATIOS.reduce((a, b) => a + b, 0);
const WEEKLY_PRIZE_POOL_PERCENT = 0.5; // 50% doanh thu ZaloPay THẬT trong tuần mới đem chia giải — không bao giờ lỗ

// Tính tổng doanh thu ZaloPay đã DUYỆT (approved) trong tuần hiện tại, rồi suy ra quỹ giải thưởng thật.
async function getWeeklyPrizePool(weekStart) {
  const weekEnd = weekStart + 7 * 24 * 60 * 60 * 1000;
  const approved = await PaymentRequest.find({
    status: 'approved',
    createdAt: { $gte: new Date(weekStart), $lt: new Date(weekEnd) },
  }).select('price -_id').lean();
  const revenue = approved.reduce((sum, r) => sum + (r.price || 0), 0);
  return Math.floor(revenue * WEEKLY_PRIZE_POOL_PERCENT);
}

// Chia quỹ giải thưởng thật theo đúng tỷ lệ cũ, làm tròn xuống — không bao giờ chia vượt quá quỹ có.
function distributePrizePool(pool) {
  if (pool <= 0) return WEEKLY_PRIZE_RATIOS.map(() => 0);
  return WEEKLY_PRIZE_RATIOS.map(ratio => Math.floor((pool * ratio) / WEEKLY_PRIZE_RATIO_SUM));
}
const WEEKLY_PRIZE_MIN_GOLD = 1000000; // vàng-tuần tối thiểu mới được tính vào bảng xếp hạng/nhận giải

/* =========================== MỜI BẠN BÈ — HOA HỒNG 10% =========================== */
// Người mời được cộng 10% số vàng mỗi khi người được mời kiếm được vàng (bán trứng, nhận
// thưởng link...) — trả bằng VÀNG TRONG GAME, không phải tiền thật, để tránh rủi ro pháp lý.
const REFERRAL_COMMISSION_RATE = 0.10;
const REFERRAL_NEW_PLAYER_BONUS = 50000; // thưởng thêm 1 lần cho người MỚI khi vào game qua link mời

/* =========================== THÀNH TỰU ĐẠT CẤP =========================== */
// Tự động cộng vàng khi lần đầu đạt các mốc cấp này — không cần bấm nhận, cứ lên đủ cấp là có luôn.
const LEVEL_MILESTONES = {
  10: 100000,
  20: 250000,
  30: 500000,
  40: 750000,
  50: 1000000,
  60: 1750000,
  70: 2500000,
  80: 3250000,
  90: 4000000,
  100: 5000000,
};


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
  feed: { price: 1000, name: 'Thức ăn VIP (chống đói)', desc: 'Cho ăn ngay, hiệu lực 24 giờ — mua nhanh qua ZaloPay, không cần đợi tích vàng' },
};

// Gói combo — áp dụng cho TẤT CẢ con vật đang nuôi cùng lúc (không cần chọn từng con). Mua qua ZaloPay.
const COMBO_PACKAGES = {
  combo1: { price: 3000, days: 2, goldBonusPercent: 30, name: 'Combo 2 ngày + 30% vàng', desc: 'Tất cả con vật không đói trong 2 ngày, cộng thêm +30% giá trị trứng khi bán' },
  combo2: { price: 2000, days: 3, goldBonusPercent: 0, name: 'Combo 3 ngày không đói', desc: 'Tất cả con vật không đói trong 3 ngày' },
  combo3: { price: 5000, days: 7, goldBonusPercent: 0, name: 'Gói VIP 1 tuần', desc: 'Tất cả con vật không đói trong cả tuần, khỏi lo quên cho ăn' },
};

// Thức ăn chống đói mua bằng VÀNG trong game (không qua ZaloPay) — bấm là có ngay, không cần admin duyệt.
const FEED_GOLD_PRICE = 100000;

const ANIMALS = [
  // ---- Lv1 ----
  { id: 'ga', lvl: 1, price: 2300, egg: 1000 },
  { id: 'vit', lvl: 1, price: 2400, egg: 1050 },
  { id: 'tho', lvl: 1, price: 2500, egg: 1100 },
  { id: 'de', lvl: 1, price: 2600, egg: 1150 },
  { id: 'cuu', lvl: 1, price: 2700, egg: 1200 },
  // ---- Lv6 ----
  { id: 'lon', lvl: 6, price: 4500, egg: 1400 },
  { id: 'bo_sua', lvl: 6, price: 5000, egg: 1550 },
  { id: 'ngua', lvl: 6, price: 5500, egg: 1700 },
  // ---- Lv12 ----
  { id: 'ga_tay', lvl: 12, price: 32300, egg: 1800 },
  { id: 'ngong', lvl: 12, price: 35000, egg: 1950 },
  { id: 'trau', lvl: 12, price: 37700, egg: 2100 },
  // ---- Lv20 ----
  { id: 'lac_da', lvl: 20, price: 40200, egg: 2200 },
  { id: 'huou', lvl: 20, price: 42100, egg: 2300 },
  { id: 'voi', lvl: 20, price: 43900, egg: 2400 },
  { id: 'ngua_van', lvl: 20, price: 45700, egg: 2500 },
  // ---- Lv30 ----
  { id: 'bo_tot', lvl: 30, price: 47000, egg: 2700 },
  { id: 'bao_dom', lvl: 30, price: 49600, egg: 2850 },
  { id: 'cho_soi', lvl: 30, price: 52200, egg: 3000 },
  // ---- Lv40 ----
  { id: 'gau_truc', lvl: 40, price: 48500, egg: 3000 },
  { id: 'gau_nau', lvl: 40, price: 50900, egg: 3150 },
  { id: 'khi_dot', lvl: 40, price: 53000, egg: 3280 },
  // ---- Lv50 ----
  { id: 'su_tu', lvl: 50, price: 50000, egg: 3300 },
  { id: 'ca_sau', lvl: 50, price: 52300, egg: 3450 },
  { id: 'lac_da_kb', lvl: 50, price: 54200, egg: 3580 },
  // ---- Lv70 ----
  { id: 'ho', lvl: 70, price: 500000, egg: 3600 },
  { id: 'nhim', lvl: 70, price: 513900, egg: 3700 },
  { id: 'luoi', lvl: 70, price: 525000, egg: 3780 },
  // ---- Lv80 ----
  { id: 'te_giac', lvl: 80, price: 1000000, egg: 3800 },
  { id: 'ha_ma', lvl: 80, price: 1026300, egg: 3900 },
  { id: 'duoi_uoi', lvl: 80, price: 1042100, egg: 3960 },
  // ---- Lv100 ----
  { id: 'huou_cao_co', lvl: 100, price: 1500000, egg: 4000 },
  { id: 'ky_lan', lvl: 100, price: 1575000, egg: 4200 },
  { id: 'rong_dat', lvl: 100, price: 1687500, egg: 4500 },
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
  referredBy: { type: String, default: null },                // telegramId của người đã mời mình vào chơi (nếu có)
  referralCount: { type: Number, default: 0 },                // số người mình đã mời được
  claimedMilestones: { type: [Number], default: [] },         // các mốc cấp đã nhận thưởng thành tựu rồi (tránh nhận trùng)
  freeFoodTokens: { type: Number, default: 0 },                // số lượt thức ăn miễn phí đang có (từ link YeuMoney)
  lastCheckinAt: { type: Number, default: 0 },                  // timestamp (ms) lần điểm danh gần nhất
  checkinStreak: { type: Number, default: 0 },                  // số ngày điểm danh liên tiếp hiện tại (1-7)
  pvpWins: { type: Number, default: 0 },                          // số trận PvP đã thắng
  pvpLosses: { type: Number, default: 0 },                        // số trận PvP đã thua
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

// Lưu tạm ai mời ai — ghi lúc người được mời bấm link mời (qua /start bot) nhưng CHƯA vào game lần đầu.
// Khi họ vào game thật (tạo Player), ta đọc bản ghi này để gán referredBy rồi xoá đi.
const ReferralPendingSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true }, // người được mời
  referrerId: { type: String, required: true },                 // người đã mời
}, { timestamps: true });

const ReferralPending = mongoose.model('ReferralPending', ReferralPendingSchema);

/* =========================== PVP — GHÉP TRẬN, KHÔNG ĐẶT CƯỢC =========================== */
// Người thắng nhận thưởng vàng CỐ ĐỊNH từ hệ thống — người thua KHÔNG mất gì cả.
// KHÔNG có cơ chế cược/ăn chia giữa 2 người chơi.
const PvpRoomSchema = new mongoose.Schema({
  gameType: { type: String, required: true }, // 'math' | 'coin'
  status: { type: String, enum: ['waiting', 'playing', 'finished'], default: 'waiting' },
  player1Id: { type: String, required: true },
  player1Name: { type: String, default: '' },
  player1Score: { type: Number, default: null },
  player2Id: { type: String, default: null },
  player2Name: { type: String, default: '' },
  player2Score: { type: Number, default: null },
  isBot: { type: Boolean, default: false },
  winnerId: { type: String, default: null }, // null = hoà
}, { timestamps: true });

const PvpRoom = mongoose.model('PvpRoom', PvpRoomSchema);

// Phí vào trận: KHÔNG chuyển từ người thua sang người thắng — giống trả phí chơi 1 lượt
// arcade, phần thua "biến mất" khỏi hệ thống, không phải cược ăn thua giữa 2 người.
const PVP_ENTRY_FEE = 5000;   // vàng phải trả để vào trận
const PVP_WIN_PROFIT = 3000;  // vàng LỜI thêm cho người thắng, ngoài việc được hoàn lại phí vào trận
const PVP_MATCH_TIMEOUT_MS = 30 * 1000; // 30 giây không có người thật thì cho phép gọi Bot ảo
const PVP_BOT_NAMES = ['Nông dân AI', 'Bot Tí Hon', 'Chủ trại ảo', 'Người máy Xanh'];

function pvpBotScore(gameType) {
  // Random hợp lý cho từng loại game, để bot không quá dễ/quá khó thắng.
  if (gameType === 'math') return Math.floor(Math.random() * 6) * 10 + 20; // 20-70 điểm
  if (gameType === 'coin') return Math.floor(Math.random() * 120) + 10;    // 10-130 điểm
  return 0;
}


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
  // Tính theo giá trứng (không đổi) thay vì giá mua (đã giảm 90%) — tăng dần theo cấp,
  // luôn cao hơn giá 1 quả trứng để hợp lý với mặt bằng giá mới.
  return Math.round(animal.egg * (1 + 0.5 * lvl));
}

function addXpAndGold(player, goldGain, xpGain) {
  player.gold += goldGain;
  bumpWeeklyGold(player, goldGain);
  player.xp += xpGain;
  const levelUps = []; // các mốc thành tựu vừa đạt trong lần cộng này — để báo cho người chơi
  while (player.xp >= xpNeeded(player.level)) {
    player.xp -= xpNeeded(player.level);
    player.level += 1;
    const milestoneReward = LEVEL_MILESTONES[player.level];
    if (milestoneReward && !player.claimedMilestones.includes(player.level)) {
      player.gold += milestoneReward;
      player.claimedMilestones.push(player.level);
      levelUps.push({ level: player.level, reward: milestoneReward });
    }
  }
  return levelUps;
}

// Nếu người chơi này được ai đó mời, trả 10% số vàng vừa kiếm được cho người mời (vàng trong game).
async function payReferralCommission(player, goldGain) {
  if (!player.referredBy || goldGain <= 0) return;
  const commission = Math.round(goldGain * REFERRAL_COMMISSION_RATE);
  if (commission <= 0) return;
  const referrer = await Player.findOne({ telegramId: player.referredBy });
  if (!referrer) return;
  referrer.gold += commission;
  await referrer.save();
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

  // Mốc thành tựu tiếp theo chưa đạt — để hiện cho người chơi biết cần lên cấp mấy để có thưởng
  const nextMilestone = Object.keys(LEVEL_MILESTONES)
    .map(Number)
    .filter(lvl => lvl > player.level)
    .sort((a, b) => a - b)[0];

  return {
    level: player.level, xp: player.xp, xpNeeded: xpNeeded(player.level),
    gold: player.gold, owned, eggs, animalLevel, prices, eggValues, upgradeCosts,
    eggTime: EGG_TIME_SEC, nextEggSec, maxOwned: MAX_OWNED, maxAnimalLevel: MAX_ANIMAL_LEVEL,
    speedBoost, goldBoost, eggTimeByAnimal, fedUntil, hungryDeathMs: HUNGRY_DEATH_MS,
    foodPrices: { speed: FOOD_TYPES.speed.price, gold: FOOD_TYPES.gold.price, feed: FOOD_TYPES.feed.price },
    feedGoldPrice: FEED_GOLD_PRICE,
    freeFoodTokens: player.freeFoodTokens,
    referralCount: player.referralCount,
    referralCommissionRate: REFERRAL_COMMISSION_RATE,
    referralNewPlayerBonus: REFERRAL_NEW_PLAYER_BONUS,
    checkin: {
      streak: player.checkinStreak,
      rewards: CHECKIN_REWARDS,
      nextAvailableAt: (player.lastCheckinAt || 0) + CHECKIN_COOLDOWN_MS,
      willResetStreak: player.lastCheckinAt > 0 && (Date.now() - player.lastCheckinAt) > CHECKIN_STREAK_RESET_MS,
    },
    pvp: {
      wins: player.pvpWins,
      losses: player.pvpLosses,
      entryFee: PVP_ENTRY_FEE,
      winProfit: PVP_WIN_PROFIT,
      matchTimeoutMs: PVP_MATCH_TIMEOUT_MS,
    },
    levelMilestones: LEVEL_MILESTONES,
    nextMilestone: nextMilestone ? { level: nextMilestone, reward: LEVEL_MILESTONES[nextMilestone] } : null,
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
  let referralBonusApplied = false;
  if (!player) {
    player = await Player.create({ telegramId, username: tgUser.username || tgUser.first_name || '' });

    // Kiểm tra có ai đã mời người này trước khi họ vào game lần đầu không.
    const pending = await ReferralPending.findOne({ telegramId });
    if (pending) {
      const referrer = await Player.findOne({ telegramId: pending.referrerId });
      if (referrer) {
        player.referredBy = pending.referrerId;
        player.gold += REFERRAL_NEW_PLAYER_BONUS;
        referralBonusApplied = true;
        referrer.referralCount += 1;
        await referrer.save();
      }
      await ReferralPending.deleteOne({ telegramId });
    }
  }
  const { deaths } = settleEggs(player);
  await player.save();

  const token = jwt.sign({ telegramId }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, state: serializeState(player), deaths, referralBonusApplied });
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
  const goldGain = eggVal * n;
  const levelUps = addXpAndGold(player, goldGain, Math.round(eggVal / 100) * n);

  await player.save();
  await payReferralCommission(player, goldGain);
  res.json({ state: serializeState(player), deaths, levelUps });
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

  const levelUps = goldGain > 0 ? addXpAndGold(player, goldGain, xpGain) : [];
  await player.save();
  await payReferralCommission(player, goldGain);
  res.json({ state: serializeState(player), deaths, levelUps });
}));

// Bảng xếp hạng THẬT dùng chung cho mọi người chơi — sắp theo vàng, top 10.
// Bảng xếp hạng ĐUA TOP HÀNG TUẦN — xếp theo vàng kiếm được trong tuần, tự reset khi sang tuần mới.
// Kèm giải thưởng từng hạng để hiển thị cho người chơi biết trước khi cày.
app.get('/api/leaderboard', asyncHandler(async (req, res) => {
  const ws = getCurrentWeekStart();
  const pool = await getWeeklyPrizePool(ws);
  const prizes = distributePrizePool(pool);

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
    .map((p, i) => ({ ...p, prize: prizes[i] || 0, rank: i + 1 }));

  res.json({
    list: ranked,
    weekStart: ws,
    weekEndsAt: ws + 7 * 24 * 60 * 60 * 1000,
    prizes,
    prizePool: pool,
    minGoldToQualify: WEEKLY_PRIZE_MIN_GOLD,
  });
}));

/* =========================== MUA THỨC ĂN — CHUYỂN KHOẢN ZALOPAY THỦ CÔNG =========================== */

// Client gọi cái này trước để lấy số điện thoại/tên nhận tiền + giá từng loại thức ăn, hiển thị cho người chơi biết chuyển khoản đi đâu.
app.get('/api/payment-info', (req, res) => {
  res.json({ zalopay: ZALOPAY_INFO, foodPrices: { speed: FOOD_TYPES.speed.price, gold: FOOD_TYPES.gold.price, feed: FOOD_TYPES.feed.price } });
});

// Cho ăn bằng VÀNG trong game (không qua ZaloPay) — bấm là có ngay, xử lý tức thì, không cần admin duyệt.
app.post('/api/feed-animal', authMiddleware, asyncHandler(async (req, res) => {
  const { animalId, useToken } = req.body || {};
  const animal = ANIMAL_MAP[animalId];
  if (!animal) return res.status(400).json({ error: 'Con vật không tồn tại.' });

  const player = req.player;
  if ((player.owned.get(animalId) || 0) <= 0) return res.status(400).json({ error: 'Bạn chưa nuôi con này.' });

  if (useToken) {
    if (player.freeFoodTokens <= 0) return res.status(400).json({ error: 'Bạn không còn lượt thức ăn miễn phí nào.' });
    player.freeFoodTokens -= 1;
  } else {
    if (player.gold < FEED_GOLD_PRICE) return res.status(400).json({ error: 'Không đủ vàng để cho ăn.' });
    player.gold -= FEED_GOLD_PRICE;
  }
  player.fedUntil.set(animalId, Date.now() + BOOST_DURATION_MS);

  await player.save();
  res.json({ state: serializeState(player) });
}));

// Điểm danh hàng ngày — 7 ngày liên tiếp, thưởng tăng dần, ngày 7 thưởng lớn.
app.post('/api/checkin', authMiddleware, asyncHandler(async (req, res) => {
  const player = req.player;
  const now = Date.now();
  const nextAvailableAt = (player.lastCheckinAt || 0) + CHECKIN_COOLDOWN_MS;

  if (now < nextAvailableAt) {
    const remainMin = Math.ceil((nextAvailableAt - now) / 60000);
    return res.status(400).json({ error: `Bạn đã điểm danh hôm nay rồi, quay lại sau khoảng ${remainMin} phút.` });
  }

  const missedStreak = player.lastCheckinAt > 0 && (now - player.lastCheckinAt) > CHECKIN_STREAK_RESET_MS;
  const newStreak = (player.lastCheckinAt === 0 || missedStreak) ? 1 : (player.checkinStreak % 7) + 1;
  const reward = CHECKIN_REWARDS[newStreak - 1];

  player.gold += reward;
  // Lưu ý: KHÔNG gọi bumpWeeklyGold ở đây — điểm danh miễn phí không tính vào bảng xếp hạng
  // ăn tiền thật (chỉ vàng từ bán trứng mới tính, để công bằng với người nạp ZaloPay).
  player.checkinStreak = newStreak;
  player.lastCheckinAt = now;

  const levelUps = []; // điểm danh không cộng XP nên không lên cấp, giữ để đồng bộ định dạng response
  await player.save();
  await payReferralCommission(player, reward);

  res.json({ state: serializeState(player), reward, streak: newStreak, levelUps });
}));

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
  player.freeFoodTokens += 1; // mỗi lần xem link được thêm 1 lượt thức ăn miễn phí
  // Lưu ý: KHÔNG gọi bumpWeeklyGold ở đây — vàng từ xem link miễn phí không tính vào bảng
  // xếp hạng ăn tiền thật (chỉ vàng từ bán trứng mới tính, để công bằng với người nạp ZaloPay).
  await player.save();
  await payReferralCommission(player, REWARD_LINK_GOLD);

  res.json({ state: serializeState(player) });
}));

// Người chơi bấm "Tôi đã chuyển khoản" sau khi chuyển tiền xong -> tạo yêu cầu chờ admin duyệt + tự nhắn Telegram báo admin.
app.post('/api/request-food', authMiddleware, asyncHandler(async (req, res) => {
  const { animalId, foodType } = req.body || {};
  const food = FOOD_TYPES[foodType];
  if (!food) return res.status(400).json({ error: 'Loại thức ăn không hợp lệ.' });

  const isVipPackage = foodType === 'vip';
  let animal = null;
  if (!isVipPackage) {
    animal = ANIMAL_MAP[animalId];
    if (!animal) return res.status(400).json({ error: 'Con vật không tồn tại.' });
  }

  const player = req.player;

  const request = await PaymentRequest.create({
    telegramId: player.telegramId,
    username: player.username,
    animalId: isVipPackage ? 'VIP_PACKAGE' : animalId,
    foodType,
    price: food.price,
  });

  if (ADMIN_TELEGRAM_ID) {
    await sendTelegramMessage(ADMIN_TELEGRAM_ID,
      `🔔 Yêu cầu mua thức ăn mới\n` +
      `Người chơi: ${player.username || 'ẩn danh'} (id: ${player.telegramId})\n` +
      `Thức ăn: ${food.name}\n` +
      (isVipPackage ? '' : `Con vật: ${animalId}\n`) +
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
    const fromId = String(message.from.id);
    const text = message.text.trim();

    // /start ref_<telegramId> — ai đó bấm link mời của bạn bè, ghi nhận trước khi họ vào game thật.
    const startMatch = text.match(/^\/start(?:\s+ref_(\S+))?/i);
    if (startMatch) {
      const referrerId = startMatch[1];
      if (referrerId && referrerId !== fromId) {
        const alreadyPlayer = await Player.findOne({ telegramId: fromId }).select('_id').lean();
        const referrerExists = await Player.findOne({ telegramId: referrerId }).select('_id').lean();
        if (!alreadyPlayer && referrerExists) {
          await ReferralPending.findOneAndUpdate(
            { telegramId: fromId },
            { telegramId: fromId, referrerId },
            { upsert: true }
          );
        }
      }
      await sendTelegramMessage(fromId, '🌾 Chào mừng tới Green Meadow Farm! Bấm nút menu bên dưới khung chat để bắt đầu chơi nhé.');
      return res.json({ ok: true });
    }

    const isAdmin = ADMIN_TELEGRAM_ID && fromId === String(ADMIN_TELEGRAM_ID);

    if (isAdmin) {
      const approveMatch = text.match(/^\/approve\s+(\S+)/i);
      const rejectMatch = text.match(/^\/reject\s+(\S+)/i);

      if (text === '/weeklytop') {
        const ws = getCurrentWeekStart();
        const pool = await getWeeklyPrizePool(ws);
        const prizes = distributePrizePool(pool);
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
          await sendTelegramMessage(ADMIN_TELEGRAM_ID, `📊 Tuần này chưa có ai đạt đủ ${WEEKLY_PRIZE_MIN_GOLD.toLocaleString('vi-VN')} vàng để xếp hạng. Quỹ giải thưởng hiện tại: ${pool.toLocaleString('vi-VN')}đ.`);
        } else {
          const lines = ranked.map((p, i) =>
            `${i + 1}. ${p.name} (id: ${p.telegramId}) — ${p.weeklyGold.toLocaleString('vi-VN')} vàng — thưởng ${(prizes[i] || 0).toLocaleString('vi-VN')}đ`
          );
          await sendTelegramMessage(ADMIN_TELEGRAM_ID, `🏆 Đua top tuần này (quỹ giải: ${pool.toLocaleString('vi-VN')}đ — 50% doanh thu ZaloPay tuần):\n\n${lines.join('\n')}\n\nLiên hệ đúng id Telegram ở trên để chuyển thưởng qua ZaloPay/ngân hàng nhé.`);
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

/* =========================== PVP ROUTES =========================== */

// Tìm trận: có phòng đang chờ (waiting) của game này thì ghép vào làm player2; không có thì tạo phòng mới chờ.
app.post('/api/pvp/find-match', authMiddleware, asyncHandler(async (req, res) => {
  const { gameType } = req.body || {};
  if (!['math', 'coin'].includes(gameType)) return res.status(400).json({ error: 'Loại game không hợp lệ.' });

  const player = req.player;
  if (player.gold < PVP_ENTRY_FEE) return res.status(400).json({ error: `Cần tối thiểu ${PVP_ENTRY_FEE.toLocaleString('vi-VN')} vàng để vào trận.` });

  // Có phòng ai đó đang chờ sẵn (không phải chính mình) -> ghép vào ngay, trừ phí vào trận.
  const waitingRoom = await PvpRoom.findOne({
    gameType, status: 'waiting', player1Id: { $ne: player.telegramId },
  }).sort({ createdAt: 1 });

  if (waitingRoom) {
    player.gold -= PVP_ENTRY_FEE;
    await player.save();
    waitingRoom.player2Id = player.telegramId;
    waitingRoom.player2Name = player.username || 'Người chơi ẩn danh';
    waitingRoom.status = 'playing';
    await waitingRoom.save();
    return res.json({ room: waitingRoom });
  }

  // Không có ai chờ sẵn -> trừ phí, tự tạo phòng mới, chờ người khác vào (hoặc gọi bot sau 30s).
  player.gold -= PVP_ENTRY_FEE;
  await player.save();
  const room = await PvpRoom.create({
    gameType, status: 'waiting',
    player1Id: player.telegramId,
    player1Name: player.username || 'Người chơi ẩn danh',
  });
  res.json({ room });
}));

// Client poll định kỳ để biết phòng đã có người 2 vào chưa, hoặc đối thủ đã nộp điểm chưa.
app.get('/api/pvp/room/:roomId', authMiddleware, asyncHandler(async (req, res) => {
  const room = await PvpRoom.findById(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Không tìm thấy phòng.' });
  res.json({ room });
}));

// Huỷ phòng đang chờ (chỉ chủ phòng, chỉ khi chưa có ai vào) — không mất gì vì không hề đặt cược.
app.post('/api/pvp/cancel/:roomId', authMiddleware, asyncHandler(async (req, res) => {
  const room = await PvpRoom.findById(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Không tìm thấy phòng.' });
  if (room.player1Id !== req.player.telegramId) return res.status(403).json({ error: 'Không phải phòng của bạn.' });
  if (room.status !== 'waiting') return res.status(400).json({ error: 'Phòng đã có người, không huỷ được nữa.' });

  req.player.gold += PVP_ENTRY_FEE; // hoàn phí vì chưa đấu thật, chưa có ai vào cả
  await req.player.save();
  await PvpRoom.deleteOne({ _id: room._id });
  res.json({ ok: true, state: serializeState(req.player) });
}));

// Sau 30 giây không ai vào -> chủ phòng bấm gọi Bot ảo để chốt trận, khỏi phải chờ vô thời hạn.
app.post('/api/pvp/fill-bot/:roomId', authMiddleware, asyncHandler(async (req, res) => {
  const room = await PvpRoom.findById(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Không tìm thấy phòng.' });
  if (room.player1Id !== req.player.telegramId) return res.status(403).json({ error: 'Không phải phòng của bạn.' });
  if (room.status !== 'waiting') return res.status(400).json({ error: 'Phòng đã có người thật rồi.' });

  const elapsed = Date.now() - room.createdAt.getTime();
  if (elapsed < PVP_MATCH_TIMEOUT_MS) {
    return res.status(400).json({ error: `Chờ thêm ${Math.ceil((PVP_MATCH_TIMEOUT_MS - elapsed) / 1000)} giây nữa mới gọi được Bot.` });
  }

  room.isBot = true;
  room.player2Id = 'BOT';
  room.player2Name = PVP_BOT_NAMES[Math.floor(Math.random() * PVP_BOT_NAMES.length)];
  room.player2Score = pvpBotScore(room.gameType);
  room.status = 'playing';
  await room.save();
  res.json({ room });
}));

// Nộp điểm sau khi chơi xong lượt của mình. Đủ 2 điểm (hoặc đối thủ là Bot đã có điểm sẵn) -> chốt kết quả ngay.
app.post('/api/pvp/submit-score', authMiddleware, asyncHandler(async (req, res) => {
  const { roomId, score } = req.body || {};
  const room = await PvpRoom.findById(roomId);
  if (!room) return res.status(404).json({ error: 'Không tìm thấy phòng.' });
  if (room.status === 'finished') return res.json({ room }); // đã chốt rồi, trả lại luôn khỏi lỗi

  const myId = req.player.telegramId;
  const finalScore = Math.max(0, Math.round(Number(score) || 0));

  if (room.player1Id === myId) room.player1Score = finalScore;
  else if (room.player2Id === myId) room.player2Score = finalScore;
  else return res.status(403).json({ error: 'Bạn không thuộc phòng này.' });

  // Đủ điểm cả 2 bên (hoặc đối thủ là Bot, đã có điểm random sẵn từ lúc gọi bot) -> chốt kết quả.
  if (room.player1Score !== null && room.player2Score !== null && room.status !== 'finished') {
    room.status = 'finished';
    if (room.player1Score > room.player2Score) room.winnerId = room.player1Id;
    else if (room.player2Score > room.player1Score) room.winnerId = room.player2Id;
    else room.winnerId = null; // hoà — hoàn phí vào trận cho cả 2 người thật, không ai lời/lỗ

    if (room.winnerId && room.winnerId !== 'BOT') {
      // Thắng: được hoàn lại phí vào trận (đã trừ lúc vào) + thêm phần lời.
      const winner = await Player.findOne({ telegramId: room.winnerId });
      if (winner) {
        winner.gold += PVP_ENTRY_FEE + PVP_WIN_PROFIT;
        winner.pvpWins += 1;
        await winner.save();
        await payReferralCommission(winner, PVP_WIN_PROFIT);
      }
    }
    // Thua: KHÔNG được hoàn phí (đã mất từ lúc vào trận) — chỉ cộng thống kê thua.
    const loserId = room.winnerId === room.player1Id ? room.player2Id : room.player1Id;
    if (loserId && loserId !== 'BOT' && loserId !== room.winnerId) {
      const loser = await Player.findOne({ telegramId: loserId });
      if (loser) { loser.pvpLosses += 1; await loser.save(); }
    }
    if (!room.winnerId) {
      // Hoà — hoàn phí vào trận cho cả 2 người thật (không tính Bot).
      if (room.player1Id !== 'BOT') {
        const p1 = await Player.findOne({ telegramId: room.player1Id });
        if (p1) { p1.gold += PVP_ENTRY_FEE; await p1.save(); }
      }
      if (room.player2Id && room.player2Id !== 'BOT') {
        const p2 = await Player.findOne({ telegramId: room.player2Id });
        if (p2) { p2.gold += PVP_ENTRY_FEE; await p2.save(); }
      }
    }
  }

  await room.save();
  res.json({ room });
}));

/* =========================== XỬ LÝ LỖI CHUNG (chống sập) =========================== */
app.use((req, res) => res.status(404).json({ error: 'Không tìm thấy đường dẫn API.' }));
app.use((err, req, res, next) => {
  console.error('🔥 Lỗi server:', err);
  res.status(500).json({ error: 'Đã xảy ra lỗi phía máy chủ, vui lòng thử lại.' });
});

// Trên Vercel KHÔNG dùng app.listen() — thay vào đó xuất app ra để Vercel tự gọi mỗi khi có request.
module.exports = app;
