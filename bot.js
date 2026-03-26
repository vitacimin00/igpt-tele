import { Bot, InlineKeyboard, GrammyError, HttpError } from 'grammy';
import dotenv from 'dotenv';
import fs from 'fs';
import AccountManager from './utils/accountManager.js';
import ChatGPTService from './utils/chatgptService.js';
import ChatGPTLoginService from './utils/chatgptLoginService.js';
import UserManager from './utils/userManager.js';
import MemberManager from './utils/memberManager.js';
import VoucherManager from './utils/voucherManager.js';
import BrowserQueue from './utils/browserQueue.js';
import { createPayment, checkStatus, cancelPayment, getQRImageUrl, gatewayName } from './gateways/index.js';

dotenv.config();

// ============================================================
// CONFIG
// ============================================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
const CHANNEL_ID = process.env.CHANNEL_ID || 'vitaciminstore';
const CHANNEL_LINK = process.env.CHANNEL_LINK || `https://t.me/${CHANNEL_ID}`;
const PRICE_1WEEK = parseInt(process.env.PRICE_1WEEK) || 25000;
const PRICE_1MONTH = parseInt(process.env.PRICE_1MONTH) || 80000;
const FREE_INVITE_ENABLED = (process.env.FREE_INVITE_ENABLED || 'true').toLowerCase() === 'true';

// ============================================================
// SERVICES
// ============================================================
const accountManager = new AccountManager();
const loginService = new ChatGPTLoginService(accountManager);
const chatgptService = new ChatGPTService(accountManager);
const userManager = new UserManager();
const memberManager = new MemberManager();
const voucherManager = new VoucherManager();
const browserQueue = new BrowserQueue();
browserQueue.setService(chatgptService);

// ============================================================
// BOT INIT
// ============================================================
const bot = new Bot(BOT_TOKEN);

// State per user
const userState = {}; // { chatId: { action: 'waiting_email_free' | 'waiting_email_buy_1week' | ... , messageId: number } }
const adminState = {}; // { chatId: { action: 'waiting_add_account' | 'waiting_kick_email' | ... , messageId: number } }

// ============================================================
// HELPERS
// ============================================================
function isAdmin(userId) {
    return ADMIN_IDS.includes(String(userId));
}

function formatRupiah(num) {
    return 'Rp ' + num.toLocaleString('id-ID');
}

function ensureDataDir() {
    if (!fs.existsSync('data')) fs.mkdirSync('data', { recursive: true });
}

async function safeEdit(chatId, messageId, text, options = {}) {
    try {
        await bot.api.editMessageText(chatId, messageId, text, options);
    } catch (e) {
        // Fallback: send new message if edit fails
        try { await bot.api.sendMessage(chatId, text, options); } catch (e2) { }
    }
}

// ============================================================
// KEYBOARDS
// ============================================================
function userDashboardKeyboard(userId) {
    const stats = userManager.getUserStats(userId);
    const hasFree = stats.remaining > 0 && stats.type === 'free';

    const kb = new InlineKeyboard();
    if (FREE_INVITE_ENABLED && hasFree) {
        kb.text('🎁 Free Invite', 'user:free_invite').row();
    }
    kb.text('📨 Invite ChatGPT', 'user:invite_menu').row();
    kb.text('📊 Riwayat', 'user:history')
      .text('🎟️ Voucher', 'user:voucher').row();
    kb.text('❓ Bantuan', 'user:help');
    return kb;
}

function backKeyboard() {
    return new InlineKeyboard().text('⬅️ Kembali', 'user:home');
}

function adminDashboardKeyboard() {
    return new InlineKeyboard()
        .text('👥 Members', 'admin:members').text('🖥️ Akun GPT', 'admin:accounts').row()
        .text('📧 Invite', 'admin:invite').text('🔨 Kick', 'admin:kick').row()
        .text('✚ Tambah Akun', 'admin:add_account').text('📊 Stats', 'admin:stats').row()
        .text('🎟️ Voucher', 'admin:vouchers').text('📢 Broadcast', 'admin:broadcast');
}

function adminBackKeyboard() {
    return new InlineKeyboard().text('⬅️ Kembali', 'admin:home');
}

// ============================================================
// DASHBOARD CONTENT
// ============================================================
function getUserDashboardText(userId, name) {
    const stats = userManager.getUserStats(userId);
    const accounts = accountManager.listAccounts();
    const accountIds = accounts.map(a => a.id);
    const activeOnAccounts = memberManager.getActiveMembersOnAccounts(accountIds).length;
    const totalInvites = memberManager.getTotalInviteCount();
    const accountStats = accountManager.getAccountStats();
    const voucher = voucherManager.getUserVoucher(String(userId));

    const hasFree = stats.remaining > 0 && stats.type === 'free';
    const freeStatus = hasFree ? '✅ 1x Available' : '👌 Already Claimed';

    let text = `🤖 <b>ChatGPT Auto Invite Bot</b>\n\n` +
        `👤 ${escapeHtml(name)}\n`;

    if (FREE_INVITE_ENABLED) {
        text += `🎁 <b>Free invite:</b> ${freeStatus}\n`;
    }

    if (voucher) {
        text += `🎟️ <b>Voucher:</b> ${voucher.code} (${voucherManager.formatDiscount(voucher)}) ✅\n`;
    }

    text += `\n<b>Bot Stats:</b>\n` +
        `├📊 <b>Invite Aktif:</b> ${activeOnAccounts}\n` +
        `├📧 <b>Total Invite:</b> ${totalInvites}\n` +
        `└🟢 <b>Akun ChatGPT Online:</b> ${accountStats.active}/${accountStats.total}\n\n`;

    if (voucher) {
        const priceWeek = voucherManager.applyDiscount(PRICE_1WEEK, voucher);
        const priceMonth = voucherManager.applyDiscount(PRICE_1MONTH, voucher);
        text += `💵<b>Harga:</b>\n` +
            `├⏳ <b>1 Minggu</b> — <s>${formatRupiah(PRICE_1WEEK)}</s> ${formatRupiah(priceWeek)}\n` +
            `└📅 <b>1 Bulan</b> — <s>${formatRupiah(PRICE_1MONTH)}</s> ${formatRupiah(priceMonth)}`;
    } else {
        text += `💵<b>Harga:</b>\n` +
            `├⏳ <b>1 Minggu</b> — ${formatRupiah(PRICE_1WEEK)}\n` +
            `└📅 <b>1 Bulan</b> — ${formatRupiah(PRICE_1MONTH)}`;
    }

    return text;
}

function getAdminDashboardText() {
    const accountStats = accountManager.getAccountStats();
    const activeMembers = memberManager.getAllActiveMembers();
    const allUserStats = userManager.getAllStats();
    const expiredSoon = activeMembers.filter(m => {
        const diff = new Date(m.expiresAt).getTime() - Date.now();
        return diff > 0 && diff < 24 * 60 * 60 * 1000;
    });

    return `👑 <b>Admin Dashboard</b>\n\n` +
        `📊 <b>Ringkasan</b>\n` +
        `├ 👥 ${allUserStats.totalUsers} user\n` +
        `├ 📧 ${accountStats.totalInvites} total invite\n` +
        `├ 🖥️ ${accountStats.active}/${accountStats.total} akun GPT aktif\n` +
        `├ 👥 ${activeMembers.length} member aktif\n` +
        `└ ⚠️ ${expiredSoon.length} expire &lt; 24 jam`;
}

function escapeHtml(text) {
    return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================
// /start — USER DASHBOARD
// ============================================================
bot.command('start', async (ctx) => {
    const userId = ctx.from.id;
    const name = ctx.from.first_name || 'User';
    // Auto-create user if new (getUser auto-creates)
    ensureDataDir();
    userManager.getUser(userId);
    userManager.updateName(userId, name, ctx.from.username || null);

    const text = getUserDashboardText(userId, name);
    const kb = userDashboardKeyboard(userId);

    const sent = await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    userState[userId] = { messageId: sent.message_id, action: null };
});

// ============================================================
// /admin — ADMIN DASHBOARD
// ============================================================
bot.command('admin', async (ctx) => {
    const userId = ctx.from.id;
    if (!isAdmin(userId)) {
        await ctx.reply('❌ Kamu bukan admin.');
        return;
    }

    const text = getAdminDashboardText();
    const kb = adminDashboardKeyboard();

    const sent = await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    adminState[userId] = { messageId: sent.message_id, action: null };
});

// ============================================================
// CALLBACK QUERIES — USER
// ============================================================
bot.callbackQuery('user:home', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    const name = ctx.from.first_name || 'User';

    delete userState[userId]?.action;

    const text = getUserDashboardText(userId, name);
    const kb = userDashboardKeyboard(userId);

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery('user:free_invite', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;

    // Check channel subscription
    try {
        const member = await bot.api.getChatMember(`@${CHANNEL_ID}`, userId);
        if (['left', 'kicked'].includes(member.status)) {
            const kb = new InlineKeyboard()
                .url('📢 Subscribe Channel', CHANNEL_LINK).row()
                .text('✅ Sudah Subscribe', 'user:check_sub').row()
                .text('⬅️ Kembali', 'user:home');

            await ctx.editMessageText(
                `🎁 <b>Free Invite</b>\n\n` +
                `⚠️ Untuk menggunakan free invite,\n` +
                `subscribe channel kami dulu:\n\n` +
                `📢 @${CHANNEL_ID}`,
                { parse_mode: 'HTML', reply_markup: kb }
            );
            return;
        }
    } catch (e) {
        // Can't verify — proceed anyway
    }

    // Subscribed — ask for email
    userState[userId] = { ...userState[userId], action: 'waiting_email_free' };

    await ctx.editMessageText(
        `🎁 <b>Free Invite</b> (1x per user)\n\n` +
        `Kirim email yang mau diundang ke\n` +
        `ChatGPT Plus workspace.\n\n` +
        `📅 Durasi: 1 Minggu\n\n` +
        `⚠️ Pastikan email valid.\n\n` +
        `Balas dengan email:`,
        { parse_mode: 'HTML', reply_markup: backKeyboard() }
    );
});

bot.callbackQuery('user:check_sub', async (ctx) => {
    const userId = ctx.from.id;

    try {
        const member = await bot.api.getChatMember(`@${CHANNEL_ID}`, userId);
        if (['left', 'kicked'].includes(member.status)) {
            await ctx.answerCallbackQuery({ text: '❌ Kamu belum subscribe channel!', show_alert: true });
            return;
        }
    } catch (e) {
        await ctx.answerCallbackQuery({ text: '⚠️ Tidak bisa cek, coba lagi.', show_alert: true });
        return;
    }

    await ctx.answerCallbackQuery({ text: '✅ Sudah subscribe!' });

    // Proceed to email input
    userState[userId] = { ...userState[userId], action: 'waiting_email_free' };

    await ctx.editMessageText(
        `🎁 <b>Free Invite</b> (1x per user)\n\n` +
        `Kirim email yang mau diundang ke\n` +
        `ChatGPT Plus workspace.\n\n` +
        `📅 Durasi: 1 Minggu\n\n` +
        `⚠️ Pastikan email valid.\n\n` +
        `Balas dengan email:`,
        { parse_mode: 'HTML', reply_markup: backKeyboard() }
    );
});

// Invite ChatGPT menu — plan details
bot.callbackQuery('user:invite_menu', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    const voucher = voucherManager.getUserVoucher(String(userId));

    const priceWeek = voucher ? voucherManager.applyDiscount(PRICE_1WEEK, voucher) : PRICE_1WEEK;
    const priceMonth = voucher ? voucherManager.applyDiscount(PRICE_1MONTH, voucher) : PRICE_1MONTH;

    let text = `🤖 <b>Invite ChatGPT Team</b>\n\n` +
        `Pilih plan yang diinginkan:\n\n` +
        `⏳ <b>Plan 1 Minggu</b>\n` +
        `├ Durasi: 7 hari (Auto kick)\n` +
        `├ Akses: ChatGPT Team workspace\n` +
        `├ Garansi: 3 hari\n`;

    if (voucher && priceWeek !== PRICE_1WEEK) {
        text += `└ 💵 <s>${formatRupiah(PRICE_1WEEK)}</s> → <b>${formatRupiah(priceWeek)}</b>\n`;
    } else {
        text += `└ 💵 <b>${formatRupiah(PRICE_1WEEK)}</b>\n`;
    }

    text += `\n📅 <b>Plan 1 Bulan</b>\n` +
        `├ Durasi: 25-28 hari\n` +
        `├ Akses: ChatGPT Team workspace\n` +
        `├ Garansi: 14 hari (Reinvite "Hubungi Admin")\n`;

    if (voucher && priceMonth !== PRICE_1MONTH) {
        text += `└ 💵 <s>${formatRupiah(PRICE_1MONTH)}</s> → <b>${formatRupiah(priceMonth)}</b>\n`;
    } else {
        text += `└ 💵 <b>${formatRupiah(PRICE_1MONTH)}</b>\n`;
    }

    if (voucher) {
        text += `\n🎟️ Voucher <code>${voucher.code}</code> aktif (${voucherManager.formatDiscount(voucher)})`;
    }

    const kb = new InlineKeyboard()
        .text(`🛍️ Beli Plan 1 Minggu`, 'user:buy_1week')
        .text(`🛍️ Beli Plan 1 Bulan`, 'user:buy_1month').row()
        .text('⬅️ Kembali', 'user:home');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery('user:buy_1week', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    userState[userId] = { ...userState[userId], action: 'waiting_email_buy_1week' };

    const voucher = voucherManager.getUserVoucher(String(userId));
    const price = voucher ? voucherManager.applyDiscount(PRICE_1WEEK, voucher) : PRICE_1WEEK;
    const priceText = voucher && price !== PRICE_1WEEK
        ? `<s>${formatRupiah(PRICE_1WEEK)}</s> → <b>${formatRupiah(price)}</b>`
        : formatRupiah(PRICE_1WEEK);

    await ctx.editMessageText(
        `📅 <b>Beli: ChatGPT Team 1 Minggu</b>\n\n` +
        `💵 Harga: ${priceText}\n` +
        `📅 Durasi: 7 hari\n\n` +
        `📧 Kirim email yang mau diundang:\n` +
        `(balas dengan email)`,
        { parse_mode: 'HTML', reply_markup: backKeyboard() }
    );
});

bot.callbackQuery('user:buy_1month', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    userState[userId] = { ...userState[userId], action: 'waiting_email_buy_1month' };

    const voucher = voucherManager.getUserVoucher(String(userId));
    const price = voucher ? voucherManager.applyDiscount(PRICE_1MONTH, voucher) : PRICE_1MONTH;
    const priceText = voucher && price !== PRICE_1MONTH
        ? `<s>${formatRupiah(PRICE_1MONTH)}</s> → <b>${formatRupiah(price)}</b>`
        : formatRupiah(PRICE_1MONTH);

    await ctx.editMessageText(
        `📅 <b>Beli: ChatGPT Team 1 Bulan</b>\n\n` +
        `💵 Harga: ${priceText}\n` +
        `📅 Durasi: 30 hari\n\n` +
        `📧 Kirim email yang mau diundang:\n` +
        `(balas dengan email)`,
        { parse_mode: 'HTML', reply_markup: backKeyboard() }
    );
});

bot.callbackQuery('user:history', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    const members = memberManager.getMembersByUser(userId);
    
    let text = `📊 <b>Riwayat Invite</b>\n\n`;
    
    if (members.length === 0) {
        text += `Belum ada riwayat invite.`;
    } else {
        const recent = members.slice(-10).reverse();
        recent.forEach((m, i) => {
            const status = m.status === 'active' ? '✅ Aktif' : 
                          m.status === 'removed' ? '⛔️ Removed' : '⏰ Expired';
            const plan = m.plan === '1month' ? '1 Bulan' : '1 Minggu';
            const timeLeft = m.status === 'active' ? ` | ⏰ ${memberManager.getTimeRemaining(m)}` : '';
            text += `${i + 1}. ${escapeHtml(m.userEmail)}\n`;
            text += `   📅 ${plan} | ${status}${timeLeft}\n\n`;
        });
    }

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: backKeyboard() });
});

bot.callbackQuery('user:help', async (ctx) => {
    await ctx.answerCallbackQuery();

    const text = `❓ <b>Bantuan</b>\n\n` +
        `Bot ini bisa invite kamu ke workspace\n` +
        `ChatGPT Team secara otomatis.\n\n` +
        `<b>Cara pakai:</b>\n` +
        `1. Klik tombol plan yang diinginkan\n` +
        `2. Masukkan email kamu\n` +
        `3. Bot akan otomatis invite\n\n` +
        `<b>Plan tersedia:</b>\n` +
        `🎁 Free — 1x per user (Subscribe Channel)\n` +
        `⏳ 1 Minggu — ${formatRupiah(PRICE_1WEEK)}\n` +
        `📅 1 Bulan — ${formatRupiah(PRICE_1MONTH)}\n\n` +
        `⏰ Akses akan otomatis di-remove\nsetelah masa aktif habis.`;

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: backKeyboard() });
});

// User voucher flow
bot.callbackQuery('user:voucher', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    const voucher = voucherManager.getUserVoucher(String(userId));

    if (voucher) {
        await ctx.editMessageText(
            `🎟️ <b>Voucher Aktif</b>\n\n` +
            `📌 Kode: <code>${voucher.code}</code>\n` +
            `💰 Diskon: ${voucherManager.formatDiscount(voucher)}\n\n` +
            `<i>Voucher akan otomatis diterapkan\nsaat checkout.</i>`,
            { parse_mode: 'HTML', reply_markup: new InlineKeyboard()
                .text('🗑️ Hapus Voucher', 'user:remove_voucher').row()
                .text('⬅️ Kembali', 'user:home')
            }
        );
    } else {
        const state = userState[userId] || {};
        state.action = 'waiting_voucher';
        userState[userId] = state;

        await ctx.editMessageText(
            `🎟️ <b>Apply Voucher</b>\n\n` +
            `Masukkan kode voucher:`,
            { parse_mode: 'HTML', reply_markup: backKeyboard() }
        );
    }
});

bot.callbackQuery('user:remove_voucher', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Voucher dihapus.' });
    voucherManager.removeUserVoucher(String(ctx.from.id));
    // Back to dashboard
    const userId = ctx.from.id;
    const name = ctx.from.first_name || 'User';
    await ctx.editMessageText(getUserDashboardText(userId, name), {
        parse_mode: 'HTML', reply_markup: userDashboardKeyboard(userId)
    });
});

// Confirm invite callback
bot.callbackQuery(/^confirm_invite:(.+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const plan = ctx.match[1]; // 'free', '1week', '1month'
    const email = ctx.match[2];
    const userId = ctx.from.id;

    // For paid plans — create QRIS payment
    if (plan !== 'free') {
        const planLabel = plan === '1month' ? '1 Bulan' : '1 Minggu';
        const basePrice = plan === '1month' ? PRICE_1MONTH : PRICE_1WEEK;

        // Check account availability BEFORE payment
        const preCheckAccount = accountManager.getAvailableAccount();
        if (!preCheckAccount) {
            await ctx.editMessageText(
                `🚧 <b>Slot Penuh</b>\n\n` +
                `Semua akun GPT sedang penuh.\nHubungi admin untuk info lebih lanjut.`,
                { parse_mode: 'HTML', reply_markup: backKeyboard() }
            );
            return;
        }

        // Apply voucher discount
        const voucher = voucherManager.getUserVoucher(String(userId));
        const price = voucher ? voucherManager.applyDiscount(basePrice, voucher) : basePrice;

        // Save pending order
        const now = new Date(Date.now() + 7 * 60 * 60 * 1000); // WIB (UTC+7)
        const dd = String(now.getUTCDate()).padStart(2, '0');
        const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
        const yy = String(now.getUTCFullYear()).slice(-2);
        const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
        const orderId = `GPT-${dd}${mm}${yy}-${rand}`;
        const orders = loadOrders();
        orders.push({
            id: orderId,
            userId: String(userId),
            userName: ctx.from.first_name,
            email,
            plan,
            price,
            basePrice,
            voucherCode: voucher ? voucher.code : null,
            status: 'pending',
            createdAt: new Date().toISOString()
        });
        saveOrders(orders);

        // 100% discount — skip QRIS, process like free
        if (price <= 0) {
            order = orders.find(o => o.id === orderId);
            order.status = 'paid';
            saveOrders(orders);

            // Mark voucher as used
            if (voucher) {
                voucherManager.useVoucher(voucher.code, String(userId));
            }

            const chatId = ctx.chat.id;
            const msgId = ctx.callbackQuery.message.message_id;

            await ctx.editMessageText(
                `🎉 <b>Voucher 100% Applied!</b>\n\n` +
                `📧 ${escapeHtml(email)}\n` +
                `📅 Plan: ${planLabel}\n` +
                `💵 ${formatRupiah(basePrice)} → <b>GRATIS</b>\n\n` +
                `⏳ Memproses invite...`,
                { parse_mode: 'HTML' }
            );

            // Process invite (non-blocking)
            const account = accountManager.getAvailableAccount();
            if (!account) {
                await ctx.editMessageText(
                    `✅ Pembayaran diterima!\n\n⚠️ Semua akun GPT penuh.\nAdmin akan proses manual.`,
                    { parse_mode: 'HTML', reply_markup: backKeyboard() }
                );
                return;
            }

            browserQueue.add('invite', account.id,
                () => chatgptService.inviteTeamMember(account, email),
                { email }
            ).then(async (result) => {
                if (result.success) {
                    const memberRecord = memberManager.addMember(email, account.id, account.email, plan, userId);
                    const timeLeft = memberManager.getTimeRemaining(memberRecord);
                    try {
                        await bot.api.editMessageText(chatId, msgId,
                            `🎉 <b>Invite Berhasil!</b>\n\n` +
                            `📧 ${escapeHtml(email)}\n` +
                            `📅 Plan: ${planLabel}\n` +
                            `💵 ${formatRupiah(basePrice)} → <b>GRATIS</b>\n` +
                            `⏰ Aktif sampai: ${new Date(memberRecord.expiresAt).toLocaleDateString('id-ID')}\n` +
                            `⏳ Sisa: ${timeLeft}\n\n` +
                            `📬 <i>Cek inbox email kamu untuk join\nworkspace ChatGPT Team!</i>`,
                            { parse_mode: 'HTML', reply_markup: backKeyboard() }
                        );
                    } catch (e) { }
                } else {
                    try {
                        await bot.api.editMessageText(chatId, msgId,
                            `❌ <b>Invite Gagal</b>\n\n${escapeHtml(result.message)}`,
                            { parse_mode: 'HTML', reply_markup: backKeyboard() }
                        );
                    } catch (e) { }
                }
            }).catch(e => console.error(`❌ Free voucher invite error: ${e.message}`));

            return;
        }

        // Create QRIS payment
        await ctx.editMessageText(
            `⏳ Membuat pembayaran QRIS...`,
            { parse_mode: 'HTML' }
        );

        const payment = await createPayment(orderId, price);

        if (!payment.success) {
            await ctx.editMessageText(
                `❌ <b>Gagal buat QRIS</b>\n\n${escapeHtml(payment.error)}\n\nCoba lagi nanti.`,
                { parse_mode: 'HTML', reply_markup: backKeyboard() }
            );
            return;
        }

        const qrImageUrl = getQRImageUrl(payment.data.qris_string);
        const totalPayment = payment.data.total_payment || price;

        // Send QR image as new message
        const fee = payment.data.fee || 0;
        const qrMsg = await bot.api.sendPhoto(ctx.chat.id, qrImageUrl, {
            caption: `💳 <b>Invoice QRIS</b>\n\n` +
                `🆔 <code>${orderId}</code>\n` +
                `📧 Email: ${escapeHtml(email)}\n` +
                `📅 Plan: ${planLabel}\n` +
                `💵 Subtotal: ${formatRupiah(price)}\n` +
                (fee ? `📊 Fee: ${formatRupiah(fee)}\n` : '') +
                `<b>TOTAL: ${formatRupiah(totalPayment)}</b>\n\n` +
                `⚠️ Scan QR di atas dengan e-wallet atau m-banking.\n` +
                `⏰ Expired dalam 15 menit`,
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard()
                .text('❌ Batal', `cancel_payment:${orderId}`)
        });

        // Update dashboard message
        try {
            await ctx.editMessageText(
                `💳 <b>Menunggu Pembayaran...</b>\n\n` +
                `📧 ${escapeHtml(email)}\n` +
                `📅 ${planLabel} — ${formatRupiah(totalPayment)}\n\n` +
                `⏳ Scan QRIS di bawah, bot akan otomatis\nproses setelah pembayaran masuk.`,
                { parse_mode: 'HTML' }
            );
        } catch (e) { }

        // Notify admin — order masuk
        for (const adminId of ADMIN_IDS) {
            try {
                await bot.api.sendMessage(adminId,
                    `🛒 <b>ORDER BARU</b>\n\n` +
                    `👤 ${escapeHtml(ctx.from.first_name)} (<code>${userId}</code>)\n` +
                    `🆔 <code>${orderId}</code>\n` +
                    `📧 ${escapeHtml(email)}\n` +
                    `📅 ${planLabel}\n` +
                    `💵 ${formatRupiah(totalPayment)}\n` +
                    `💳 QRIS via ${gatewayName}\n\n` +
                    `⏳ Menunggu pembayaran...`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) { }
        }

        // Start polling payment status
        pollPaymentStatus(orderId, price, ctx.chat.id, qrMsg.message_id, userState[userId]?.messageId);

        return;
    }

    // Free invite — process immediately
    // Check limit
    const canInvite = userManager.canInvite(userId);
    if (!canInvite) {
        await ctx.editMessageText(
            `❌ <b>Kuota Free Habis</b>\n\n` +
            `Kamu sudah menggunakan free invite.\n\n` +
            `💵 Beli plan untuk invite lagi:\n` +
            `📅 1 Minggu — ${formatRupiah(PRICE_1WEEK)}\n` +
            `📅 1 Bulan — ${formatRupiah(PRICE_1MONTH)}`,
            { parse_mode: 'HTML', reply_markup: backKeyboard() }
        );
        return;
    }

    // Get available account
    const account = accountManager.getAvailableAccount();
    if (!account) {
        await ctx.editMessageText(
            `🚧 <b>Semua Slot Penuh</b>\n\nSemua akun GPT sedang penuh.\nCoba lagi nanti.`,
            { parse_mode: 'HTML', reply_markup: backKeyboard() }
        );
        return;
    }

    // Process invite — fire and forget (don't block Grammy)
    const chatId = ctx.chat.id;
    const msgId = ctx.callbackQuery.message.message_id;
    const queuePos = browserQueue.getQueueLength() + 1;

    await ctx.editMessageText(
        `⏳ <b>Memproses invite...</b>\n\n` +
        `📧 ${escapeHtml(email)}\n` +
        `📅 Plan: 1 Minggu (Free)\n\n` +
        `Mohon tunggu ~30-60 detik...` +
        (queuePos > 1 ? `\n📋 Antrian ke-${queuePos}` : ''),
        { parse_mode: 'HTML' }
    );

    // Non-blocking — runs in background
    browserQueue.add('invite', account.id,
        () => chatgptService.inviteTeamMember(account, email),
        { email }
    ).then(async (result) => {
        if (result.success) {
            userManager.incrementUsage(userId);
            const memberRecord = memberManager.addMember(email, account.id, account.email, '1week', userId);
            const timeLeft = memberManager.getTimeRemaining(memberRecord);

            await bot.api.editMessageText(chatId, msgId,
                `🎉 <b>Invite Berhasil!</b>\n\n` +
                `📧 ${escapeHtml(email)}\n` +
                `📅 Plan: 1 Minggu (Free)\n` +
                `⏰ Aktif sampai: ${new Date(memberRecord.expiresAt).toLocaleDateString('id-ID')}\n` +
                `⏳ Sisa: ${timeLeft}\n\n` +
                `📬 <i>Cek inbox email kamu untuk join\nworkspace ChatGPT Team!</i>`,
                { parse_mode: 'HTML', reply_markup: backKeyboard() }
            );
        } else {
            await bot.api.editMessageText(chatId, msgId,
                `❌ <b>Invite Gagal</b>\n\n${escapeHtml(result.message)}`,
                { parse_mode: 'HTML', reply_markup: backKeyboard() }
            );
        }
    }).catch(e => console.error(`❌ Free invite error: ${e.message}`));
});

bot.callbackQuery('cancel_invite', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Dibatalkan.' });
    const userId = ctx.from.id;
    const name = ctx.from.first_name || 'User';
    delete userState[userId]?.action;
    await ctx.editMessageText(getUserDashboardText(userId, name), {
        parse_mode: 'HTML',
        reply_markup: userDashboardKeyboard(userId)
    });
});

// Cancel payment callback
bot.callbackQuery(/^cancel_payment:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Order dibatalkan.' });
    const orderId = ctx.match[1];

    // Cancel via gateway
    await cancelPayment(orderId);

    // Update order status
    const orders = loadOrders();
    const order = orders.find(o => o.id === orderId);
    if (order) {
        order.status = 'cancelled';
        saveOrders(orders);
        // Return voucher
        if (order.voucherCode) {
            voucherManager.returnVoucher(order.voucherCode, order.userId);
        }
    }

    // Delete QR message
    try { await ctx.deleteMessage(); } catch (e) { }

    // Update dashboard message back
    const userId = ctx.from.id;
    const name = ctx.from.first_name || 'User';
    const dashMsgId = userState[userId]?.messageId;
    if (dashMsgId) {
        try {
            await bot.api.editMessageText(ctx.chat.id, dashMsgId,
                getUserDashboardText(userId, name),
                { parse_mode: 'HTML', reply_markup: userDashboardKeyboard(userId) }
            );
        } catch (e) { }
    }

});

// ============================================================
// PAYMENT STATUS POLLING
// ============================================================
async function pollPaymentStatus(orderId, amount, chatId, qrMessageId, dashboardMessageId) {
    const MAX_POLLS = 180; // 180 * 5s = 15 minutes
    let polls = 0;

    const interval = setInterval(async () => {
        polls++;

        try {
            const orders = loadOrders();
            const order = orders.find(o => o.id === orderId);

            // Stop if order already processed/cancelled
            if (!order || order.status !== 'pending') {
                clearInterval(interval);
                return;
            }

            const result = await checkStatus(orderId, amount);

            if (result.success && result.status === 'completed') {
                clearInterval(interval);

                // Update order
                order.status = 'paid';
                saveOrders(orders);
                // Mark voucher as used
                if (order.voucherCode) {
                    voucherManager.useVoucher(order.voucherCode, order.userId);
                }

                console.log(`💳 Payment ${orderId} completed!`);

                // Delete QR message
                try { await bot.api.deleteMessage(chatId, qrMessageId); } catch (e) { }

                // Auto-process invite
                await processPayment(order, chatId, dashboardMessageId);

            } else if (result.success && result.status === 'expired' || polls >= MAX_POLLS) {
                clearInterval(interval);

                // Mark as expired
                order.status = 'expired';
                saveOrders(orders);
                // Return voucher
                if (order.voucherCode) {
                    voucherManager.returnVoucher(order.voucherCode, order.userId);
                }

                console.log(`⏰ Payment ${orderId} expired`);

                // Delete QR message
                try { await bot.api.deleteMessage(chatId, qrMessageId); } catch (e) { }

                // Cancel via gateway
                try { await cancelPayment(orderId); } catch (e) { }

                // Notify user
                try {
                    await bot.api.editMessageText(chatId, dashboardMessageId,
                        `⏰ <b>Pembayaran Expired</b>\n\n` +
                        `🆔 <code>${orderId}</code>\n\n` +
                        `Waktu pembayaran 15 menit telah habis.\n` +
                        `Silakan lakukan pembayaran ulang.`,
                        { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('𖠿 Dashboard', 'user:home') }
                    );
                } catch (e) {
                    try {
                        await bot.api.sendMessage(chatId,
                            `⏰ Pembayaran <code>${orderId}</code> expired. Silakan order ulang.`,
                            { parse_mode: 'HTML' }
                        );
                    } catch (e2) { }
                }


            }
        } catch (e) {
            console.error(`Poll error ${orderId}:`, e.message);
        }
    }, 5000);
}

async function processPayment(order, chatId, dashboardMessageId) {
    const account = accountManager.getAvailableAccount();

    if (!account) {
        try {
            await bot.api.editMessageText(chatId, dashboardMessageId,
                `✅ <b>Pembayaran Diterima!</b>\n\n` +
                `⚠️ Tapi semua akun GPT penuh.\nAdmin akan proses manual.`,
                { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('𖠿 Dashboard', 'user:home') }
            );
        } catch (e) { }
        return;
    }

    // Update dashboard to processing
    try {
        await bot.api.editMessageText(chatId, dashboardMessageId,
            `✅ <b>Pembayaran Diterima!</b>\n\n` +
            `⏳ Memproses invite...\n` +
            `📧 ${escapeHtml(order.email)}\n\n` +
            `Mohon tunggu ~30-60 detik...`,
            { parse_mode: 'HTML' }
        );
    } catch (e) { }

    const result = await browserQueue.add('invite', account.id,
        () => chatgptService.inviteTeamMember(account, order.email),
        { email: order.email }
    );

    if (result.success) {
        const memberRecord = memberManager.addMember(order.email, account.id, account.email, order.plan);
        const timeLeft = memberManager.getTimeRemaining(memberRecord);
        const planLabel = order.plan === '1month' ? '1 Bulan' : '1 Minggu';

        // Update order
        const orders = loadOrders();
        const o = orders.find(x => x.id === order.id);
        if (o) { o.status = 'completed'; saveOrders(orders); }

        try {
            await bot.api.editMessageText(chatId, dashboardMessageId,
                `🎉 <b>Invite Berhasil!</b>\n\n` +
                `📧 ${escapeHtml(order.email)}\n` +
                `📅 Plan: ${planLabel}\n` +
                `💵 ${formatRupiah(order.price)}\n` +
                `⏰ Aktif sampai: ${new Date(memberRecord.expiresAt).toLocaleDateString('id-ID')}\n` +
                `⏳ Sisa: ${timeLeft}\n\n` +
                `📬 <i>Cek inbox email kamu untuk join\nworkspace ChatGPT Team!</i>`,
                { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('𖠿 Dashboard', 'user:home') }
            );
        } catch (e) { }

        // Notify admins
        for (const adminId of ADMIN_IDS) {
            try {
                await bot.api.sendMessage(adminId,
                    `✅ <b>AUTO-INVITE (Paid)</b>\n\n` +
                    `👤 ${escapeHtml(order.userName)} (<code>${order.userId}</code>)\n` +
                    `🆔 <code>${order.id}</code>\n` +
                    `📧 ${escapeHtml(order.email)}\n` +
                    `📅 ${planLabel}\n` +
                    `💵 ${formatRupiah(order.price)}\n` +
                    `🖥️ Head: ${escapeHtml(account.email)} ${account.inviteCount}/${account.maxInvites}`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) { }
        }
    } else {
        // Invite failed — notify admin for manual processing
        const orders = loadOrders();
        const o = orders.find(x => x.id === order.id);
        if (o) { o.status = 'paid_invite_failed'; saveOrders(orders); }

        try {
            await bot.api.editMessageText(chatId, dashboardMessageId,
                `✅ Pembayaran diterima!\n\n` +
                `⚠️ Invite gagal: ${escapeHtml(result.message)}\n\n` +
                `Admin akan proses manual.`,
                { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('𖠿 Dashboard', 'user:home') }
            );
        } catch (e) { }

        for (const adminId of ADMIN_IDS) {
            try {
                await bot.api.sendMessage(adminId,
                    `⚠️ <b>PAID BUT INVITE FAILED</b>\n\n` +
                    `👤 ${escapeHtml(order.userName)} (<code>${order.userId}</code>)\n` +
                    `🆔 ${order.id}\n` +
                    `📧 ${escapeHtml(order.email)}\n` +
                    `💵 ${formatRupiah(order.price)}\n` +
                    `❌ ${escapeHtml(result.message)}`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: new InlineKeyboard()
                            .text('🔄 Retry Invite', `admin:approve:${order.id}`)
                    }
                );
            } catch (e) { }
        }
    }
}

// ============================================================
// CALLBACK QUERIES — ADMIN
// ============================================================
bot.callbackQuery('admin:home', async (ctx) => {
    await ctx.answerCallbackQuery();
    delete adminState[ctx.from.id]?.action;
    await ctx.editMessageText(getAdminDashboardText(), {
        parse_mode: 'HTML',
        reply_markup: adminDashboardKeyboard()
    });
});

bot.callbackQuery('admin:members', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showMembersSlide(ctx, 0);
});

bot.callbackQuery(/^member_page:(-?\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const page = parseInt(ctx.match[1]);
    await showMembersSlide(ctx, page);
});

async function showMembersSlide(ctx, page) {
    const members = memberManager.getAllActiveMembers();
    const perPage = 5;
    const totalPages = Math.max(1, Math.ceil(members.length / perPage));

    // Clamp page
    if (page < 0) page = totalPages - 1;
    if (page >= totalPages) page = 0;

    let text = `👥 <b>Active Members (${members.length})</b>\n\n`;

    if (members.length === 0) {
        text += `Belum ada member aktif.`;
    } else {
        const start = page * perPage;
        const slice = members.slice(start, start + perPage);
        slice.forEach((m, i) => {
            const plan = m.plan === '1month' ? '1 Bulan' : '1 Minggu';
            const timeLeft = memberManager.getTimeRemaining(m);
            text += `${start + i + 1}. ${escapeHtml(m.userEmail)}\n`;
            text += `   📅 ${plan} | ⏰ ${timeLeft}\n`;
            text += `   🖥️ ${escapeHtml(m.gptAccountEmail)}\n\n`;
        });
        text += `📄 Halaman ${page + 1}/${totalPages}`;
    }

    const kb = new InlineKeyboard();
    if (totalPages > 1) {
        kb.text('👈', `member_page:${page - 1}`)
          .text(`${page + 1}/${totalPages}`, 'noop')
          .text('👉', `member_page:${page + 1}`).row();
    }
    kb.text('⬅️ Kembali', 'admin:home');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
}

bot.callbackQuery('admin:accounts', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showAccountSlide(ctx, 0);
});

bot.callbackQuery(/^acc_page:(-?\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const page = parseInt(ctx.match[1]);
    await showAccountSlide(ctx, page);
});

bot.callbackQuery(/^sync_account:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: '⏳ Sync akun...' });
    const accId = ctx.match[1];
    const account = accountManager.getAccountById(accId);
    if (!account) return;

    const chatId = ctx.chat.id;
    const msgId = ctx.callbackQuery.message.message_id;
    try {
        await ctx.editMessageText(
            `🖥️ <b>Akun GPT</b>\n\n` +
            `📧 ${escapeHtml(account.email)}\n\n` +
            `🔄 <i>Sync billing + members, tunggu sebentar...</i>`,
            { parse_mode: 'HTML' }
        );
    } catch (e) { }

    // Non-blocking
    browserQueue.add('sync', account.id,
        () => chatgptService.syncAccount(account),
        { email: account.email }
    ).then(async (result) => {
        if (result.success) {
            account.billingPlan = result.plan;
            account.billingRenew = result.renewsAt;
            account.billingSeats = result.seats;
            account.joinedEmails = result.joinedEmails;
            account.pendingEmails = result.pendingEmails;
            account.lastSynced = new Date().toISOString();
            accountManager.updateAccount(account);

            // Update member status based on sync
            const members = memberManager.getMembersByAccount(accId);
            for (const m of members) {
                if (result.joinedEmails.includes(m.userEmail)) {
                    memberManager.updateMemberStatus(m.userEmail, accId, 'joined');
                } else if (result.pendingEmails.includes(m.userEmail)) {
                    memberManager.updateMemberStatus(m.userEmail, accId, 'pending');
                }
            }
        } else {
            try {
                await bot.api.editMessageText(chatId, msgId,
                    `🖥️ <b>Akun GPT</b>\n\n` +
                    `📧 ${escapeHtml(account.email)}\n\n` +
                    `❌ Sync gagal: ${escapeHtml(result.message || 'Unknown error')}`,
                    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'admin:accounts') }
                );
            } catch (e) { }
            return;
        }

        const accounts = accountManager.listAccounts();
        const idx = accounts.findIndex(a => a.id === accId);
        try {
            await showAccountSlideById(chatId, msgId, idx >= 0 ? idx : 0);
        } catch (e) { }
    }).catch(e => console.error(`❌ Sync error: ${e.message}`));
});

async function showAccountSlide(ctx, page) {
    const accounts = accountManager.listAccounts();

    if (accounts.length === 0) {
        const kb = new InlineKeyboard()
            .text('✚ Tambah Akun', 'admin:add_account').row()
            .text('⬅️ Kembali', 'admin:home');
        await ctx.editMessageText(`🖥️ <b>Akun GPT</b>\n\nBelum ada akun.`, {
            parse_mode: 'HTML', reply_markup: kb
        });
        return;
    }

    if (page < 0) page = accounts.length - 1;
    if (page >= accounts.length) page = 0;

    const acc = accounts[page];
    const hasSession = accountManager.hasSession(acc.id);
    const members = memberManager.getMembersByAccount(acc.id);

    let text = `🖥️ <b>Akun GPT (${page + 1}/${accounts.length})</b>\n\n`;
    text += `📧 ${escapeHtml(acc.email)}\n`;
    text += `📊 Slot: ${acc.inviteCount}/${acc.maxInvites}\n`;
    text += `🔐 Session: ${hasSession ? '✅ Aktif' : '❌ Expired'}\n`;

    // Billing info (cached)
    if (acc.billingPlan) {
        text += `\n💳 <b>Billing</b>\n`;
        text += `├ 📋 ${escapeHtml(acc.billingPlan)}\n`;
        text += `├ 🔄 Renews: ${escapeHtml(acc.billingRenew)}\n`;
        text += `└ 💺 Seats: ${escapeHtml(acc.billingSeats || 'N/A')}\n`;
    }

    // Members list — split by joined/pending
    const joined = members.filter(m => m.memberStatus === 'joined');
    const pending = members.filter(m => m.memberStatus !== 'joined');

    if (joined.length > 0) {
        text += `\n✅ <b>Joined (${joined.length})</b>\n`;
        joined.forEach((m, i) => {
            const isLast = i === joined.length - 1;
            const timeLeft = memberManager.getTimeRemaining(m);
            text += `${isLast ? '└' : '├'} ${escapeHtml(m.userEmail)}\n`;
            text += `${isLast ? ' ' : '│'}  ⏳ ${timeLeft}\n`;
        });
    }

    if (pending.length > 0) {
        text += `\n⏳ <b>Pending (${pending.length})</b>\n`;
        pending.forEach((m, i) => {
            const isLast = i === pending.length - 1;
            const timeLeft = memberManager.getTimeRemaining(m);
            text += `${isLast ? '└' : '├'} ${escapeHtml(m.userEmail)}\n`;
            text += `${isLast ? ' ' : '│'}  ⏳ ${timeLeft}\n`;
        });
    }

    if (members.length === 0) {
        text += `\n👥 <i>Belum ada member</i>\n`;
    }

    if (acc.lastSynced) {
        const syncTime = new Date(acc.lastSynced).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        text += `\n🔄 <i>Sync: ${syncTime}</i>`;
    }

    // Keyboard with navigation
    const kb = new InlineKeyboard();

    if (accounts.length > 1) {
        kb.text('👈', `acc_page:${page - 1}`)
          .text(`${page + 1}/${accounts.length}`, 'noop')
          .text('👉', `acc_page:${page + 1}`).row();
    }

    kb.text('🔑 Login', `acc_login:${acc.id}`)
      .text('🔄 Sync', `sync_account:${acc.id}`).row();
    kb.text('✚ Tambah Akun', 'admin:add_account')
      .text('🗑️ Hapus Akun', 'admin:delete_account').row();
    kb.text('⬅️ Kembali', 'admin:home');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
}

// Version without ctx for background callbacks
async function showAccountSlideById(chatId, msgId, page) {
    const accounts = accountManager.listAccounts();
    if (accounts.length === 0) return;
    if (page < 0) page = accounts.length - 1;
    if (page >= accounts.length) page = 0;

    const acc = accounts[page];
    const hasSession = accountManager.hasSession(acc.id);
    const members = memberManager.getMembersByAccount(acc.id);

    let text = `🖥️ <b>Akun GPT (${page + 1}/${accounts.length})</b>\n\n`;
    text += `📧 ${escapeHtml(acc.email)}\n`;
    text += `📊 Slot: ${acc.inviteCount}/${acc.maxInvites}\n`;
    text += `🔐 Session: ${hasSession ? '✅ Aktif' : '❌ Expired'}\n`;
    if (acc.billingPlan) {
        text += `\n💳 <b>Billing</b>\n`;
        text += `├ 📋 ${escapeHtml(acc.billingPlan)}\n`;
        text += `├ 🔄 Renews: ${escapeHtml(acc.billingRenew)}\n`;
        text += `└ 💺 Seats: ${escapeHtml(acc.billingSeats || 'N/A')}\n`;
    }
    const joined2 = members.filter(m => m.memberStatus === 'joined');
    const pending2 = members.filter(m => m.memberStatus !== 'joined');

    if (joined2.length > 0) {
        text += `\n✅ <b>Joined (${joined2.length})</b>\n`;
        joined2.forEach((m, i) => {
            const isLast = i === joined2.length - 1;
            const timeLeft = memberManager.getTimeRemaining(m);
            text += `${isLast ? '└' : '├'} ${escapeHtml(m.userEmail)}\n`;
            text += `${isLast ? ' ' : '│'}  ⏳ ${timeLeft}\n`;
        });
    }
    if (pending2.length > 0) {
        text += `\n⏳ <b>Pending (${pending2.length})</b>\n`;
        pending2.forEach((m, i) => {
            const isLast = i === pending2.length - 1;
            const timeLeft = memberManager.getTimeRemaining(m);
            text += `${isLast ? '└' : '├'} ${escapeHtml(m.userEmail)}\n`;
            text += `${isLast ? ' ' : '│'}  ⏳ ${timeLeft}\n`;
        });
    }
    if (members.length === 0) {
        text += `\n👥 <i>Belum ada member</i>\n`;
    }
    if (acc.lastSynced) {
        const syncTime = new Date(acc.lastSynced).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        text += `\n🔄 <i>Sync: ${syncTime}</i>`;
    }

    const kb = new InlineKeyboard();
    if (accounts.length > 1) {
        kb.text('👈', `acc_page:${page - 1}`)
          .text(`${page + 1}/${accounts.length}`, 'noop')
          .text('👉', `acc_page:${page + 1}`).row();
    }
    kb.text('🔑 Login', `acc_login:${acc.id}`)
      .text('🔄 Sync', `sync_account:${acc.id}`).row();
    kb.text('✚ Tambah Akun', 'admin:add_account')
      .text('🗑️ Hapus Akun', 'admin:delete_account').row();
    kb.text('⬅️ Kembali', 'admin:home');

    await bot.api.editMessageText(chatId, msgId, text, { parse_mode: 'HTML', reply_markup: kb });
}

bot.callbackQuery('noop', async (ctx) => {
    await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^acc_login:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: '⏳ Login...' });
    const accId = ctx.match[1];
    const account = accountManager.getAccountById(accId);
    if (!account) return;

    const chatId = ctx.chat.id;
    const msgId = ctx.callbackQuery.message.message_id;
    try {
        await ctx.editMessageText(
            `🔑 <b>Login</b>\n\n📧 ${escapeHtml(account.email)}\n\n⏳ <i>Sedang login, tunggu sebentar...</i>`,
            { parse_mode: 'HTML' }
        );
    } catch (e) { }

    // Non-blocking
    browserQueue.add('login', account.id,
        () => chatgptLoginService.loginAccount(account),
        { email: account.email }
    ).then(async (result) => {
        const accounts = accountManager.listAccounts();
        const idx = accounts.findIndex(a => a.id === accId);
        try {
            await showAccountSlideById(chatId, msgId, idx >= 0 ? idx : 0);
        } catch (e) {
            const status = result.success ? '✅ Login berhasil!' : `❌ ${escapeHtml(result.message)}`;
            try {
                await bot.api.editMessageText(chatId, msgId,
                    `🔑 <b>Login</b>\n\n📧 ${escapeHtml(account.email)}\n\n${status}`,
                    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'admin:accounts') }
                );
            } catch (e2) { }
        }
    }).catch(e => console.error(`❌ Login error: ${e.message}`));
});

bot.callbackQuery(/^force_remove:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const email = ctx.match[1];
    const member = memberManager.findMemberByEmail(email);

    if (member) {
        memberManager.removeMember(email);
        accountManager.decrementInviteCount(member.gptAccountId);
        await ctx.editMessageText(
            `🧹 <b>Dihapus</b>\n\n` +
            `📧 ${escapeHtml(email)}\n` +
            `✅ Dihapus dari database, slot dikembalikan.`,
            { parse_mode: 'HTML', reply_markup: adminBackKeyboard() }
        );
    } else {
        await ctx.editMessageText(
            `❌ ${escapeHtml(email)} tidak ditemukan di database.`,
            { parse_mode: 'HTML', reply_markup: adminBackKeyboard() }
        );
    }
});

bot.callbackQuery('admin:stats', async (ctx) => {
    await ctx.answerCallbackQuery();
    const accountStats = accountManager.getAccountStats();
    const activeMembers = memberManager.getAllActiveMembers();
    const allUserStats = userManager.getAllStats();

    const text = `📊 <b>Statistik Bot</b>\n\n` +
        `👥 Total User: ${allUserStats.totalUsers}\n` +
        `📧 Total Invite: ${accountStats.totalInvites}\n` +
        `🖥️ Akun GPT: ${accountStats.active}/${accountStats.total} aktif\n` +
        `👥 Member Aktif: ${activeMembers.length}\n` +
        `📊 Slot Terpakai: ${accountStats.totalInvites}/${accountStats.total * (parseInt(process.env.MAX_INVITES_PER_ACCOUNT) || 4)}`;

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
});

bot.callbackQuery('admin:invite', async (ctx) => {
    await ctx.answerCallbackQuery();
    adminState[ctx.from.id] = { ...adminState[ctx.from.id], action: 'waiting_admin_invite_email' };

    await ctx.editMessageText(
        `📧 <b>Admin Invite</b>\n\n` +
        `Kirim email yang mau di-invite.\n` +
        `Bot auto pilih akun GPT tersedia.\n\n` +
        `Balas dengan email:`,
        { parse_mode: 'HTML', reply_markup: adminBackKeyboard() }
    );
});

// Admin invite plan selection
bot.callbackQuery(/^admin_invite_plan:(.+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const plan = ctx.match[1]; // '1week' or '1month'
    const email = ctx.match[2];
    const userId = ctx.from.id;
    const state = adminState[userId];
    if (!state) return;

    const account = accountManager.getAvailableAccount();
    if (!account) {
        await ctx.editMessageText(
            `❌ Tidak ada akun GPT tersedia.`,
            { parse_mode: 'HTML', reply_markup: adminBackKeyboard() }
        );
        return;
    }

    const planLabel = plan === '1month' ? '1 Bulan' : '1 Minggu';
    const chatId = ctx.chat.id;
    const msgId = ctx.callbackQuery.message.message_id;

    await ctx.editMessageText(
        `⏳ <b>Invite...</b>\n📧 ${escapeHtml(email)}\n📅 ${planLabel}\n🖥️ via ${escapeHtml(account.email)}`,
        { parse_mode: 'HTML' }
    );

    browserQueue.add('invite', account.id,
        () => chatgptService.inviteTeamMember(account, email),
        { email }
    ).then(async (result) => {
        if (result.success) {
            const memberRecord = memberManager.addMember(email, account.id, account.email, plan);
            await safeEdit(chatId, msgId,
                `🎉 <b>Invite Berhasil!</b>\n\n` +
                `📧 ${escapeHtml(email)}\n` +
                `📅 ${planLabel}\n` +
                `⏰ Expire: ${new Date(memberRecord.expiresAt).toLocaleDateString('id-ID')}\n\n` +
                `📬 Cek inbox email untuk join workspace.`,
                { parse_mode: 'HTML', reply_markup: adminBackKeyboard() }
            );
        } else {
            await safeEdit(chatId, msgId,
                `❌ <b>Gagal:</b> ${escapeHtml(result.message)}`,
                { parse_mode: 'HTML', reply_markup: adminBackKeyboard() }
            );
        }
    }).catch(e => console.error(`❌ Admin invite error: ${e.message}`));
});

bot.callbackQuery('admin:kick', async (ctx) => {
    await ctx.answerCallbackQuery();
    adminState[ctx.from.id] = { ...adminState[ctx.from.id], action: 'waiting_kick_email' };

    const members = memberManager.getAllActiveMembers();
    let text = `🔨 <b>Kick Member</b>\n\n`;

    if (members.length > 0) {
        text += `Member aktif:\n`;
        members.forEach((m, i) => {
            text += `${i + 1}. ${escapeHtml(m.userEmail)}\n`;
        });
        text += `\nBalas dengan email yang mau di-kick:`;
    } else {
        text += `Tidak ada member aktif.`;
    }

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
});

bot.callbackQuery('admin:add_account', async (ctx) => {
    await ctx.answerCallbackQuery();
    adminState[ctx.from.id] = { ...adminState[ctx.from.id], action: 'waiting_add_account' };

    await ctx.editMessageText(
        `✚ <b>Tambah Akun GPT</b>\n\n` +
        `Kirim data akun dengan format:\n\n` +
        `<code>email password 2fa_secret</code>\n\n` +
        `Bisa multi akun (1 per baris):\n` +
        `<code>akun1@gmail.com pass1 2FA1\nakun2@gmail.com pass2 2FA2</code>\n\n` +
        `2FA secret opsional.`,
        { parse_mode: 'HTML', reply_markup: adminBackKeyboard() }
    );
});

bot.callbackQuery('admin:delete_account', async (ctx) => {
    await ctx.answerCallbackQuery();
    adminState[ctx.from.id] = { ...adminState[ctx.from.id], action: 'waiting_delete_account' };

    const accounts = accountManager.listAccounts();
    let text = `🗑️ <b>Hapus Akun GPT</b>\n\n`;

    if (accounts.length > 0) {
        text += `Akun terdaftar:\n`;
        accounts.forEach((acc, i) => {
            text += `${i + 1}. ${escapeHtml(acc.email)}\n`;
        });
        text += `\nBalas dengan email akun yang mau dihapus:`;
    } else {
        text += `Tidak ada akun terdaftar.`;
    }

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
});

// Admin Voucher Management
bot.callbackQuery('admin:vouchers', async (ctx) => {
    await ctx.answerCallbackQuery();
    const vouchers = voucherManager.listVouchers();

    let text = `🎟️ <b>Voucher (${vouchers.length})</b>\n\n`;
    if (vouchers.length === 0) {
        text += `<i>Belum ada voucher.</i>`;
    } else {
        vouchers.forEach((v, i) => {
            const disc = v.type === 'percent' ? `-${v.value}%` : `-${v.value.toLocaleString('id-ID')}`;
            const uses = v.maxUses === -1 ? `${v.usedCount}/∞` : `${v.usedCount}/${v.maxUses}`;
            const claimed = v.claimedBy.length;
            text += `${i + 1}. <code>${v.code}</code> (${disc})\n`;
            text += `   Used: ${uses} | Claimed: ${claimed}\n`;
            text += `   ${v.active ? '🟢 Aktif' : '🔴 Nonaktif'}\n\n`;
        });
    }

    const kb = new InlineKeyboard()
        .text('✚ Buat Voucher', 'admin:create_voucher').row()
        .text('🗑️ Hapus Voucher', 'admin:delete_voucher').row()
        .text('⬅️ Kembali', 'admin:home');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery('admin:create_voucher', async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = adminState[ctx.from.id] || {};
    state.action = 'waiting_voucher_create';
    state.messageId = ctx.callbackQuery.message.message_id;
    adminState[ctx.from.id] = state;

    await ctx.editMessageText(
        `➕ <b>Buat Voucher</b>\n\n` +
        `Kirim dalam format:\n` +
        `<code>KODE TIPE NILAI MAX</code>\n\n` +
        `Contoh:\n` +
        `<code>DISKON50 percent 50 10</code>\n` +
        `→ Diskon 50%, max 10 pemakaian\n\n` +
        `<code>HEMAT5K fixed 5000 -1</code>\n` +
        `→ Potongan Rp 5.000, unlimited`,
        { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'admin:vouchers') }
    );
});

bot.callbackQuery('admin:delete_voucher', async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = adminState[ctx.from.id] || {};
    state.action = 'waiting_voucher_delete';
    state.messageId = ctx.callbackQuery.message.message_id;
    adminState[ctx.from.id] = state;

    await ctx.editMessageText(
        `🗑️ <b>Hapus Voucher</b>\n\nKetik kode voucher yang mau dihapus:`,
        { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'admin:vouchers') }
    );
});

bot.callbackQuery('admin:broadcast', async (ctx) => {
    await ctx.answerCallbackQuery();
    adminState[ctx.from.id] = { ...adminState[ctx.from.id], action: 'waiting_broadcast', messageId: ctx.callbackQuery.message.message_id };

    await ctx.editMessageText(
        `📢 <b>Broadcast</b>\n\n` +
        `Kirim pesan yang mau di-broadcast ke semua user.\n\n` +
        `✅ Support: teks, foto, video, dokumen, sticker\n` +
        `✅ Formatting bold/italic/link tetap terkirim`,
        { parse_mode: 'HTML', reply_markup: adminBackKeyboard() }
    );
});

// Admin approve/reject order
bot.callbackQuery(/^admin:approve:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const orderId = ctx.match[1];
    const orders = loadOrders();
    const order = orders.find(o => o.id === orderId);

    if (!order || order.status !== 'pending') {
        await ctx.editMessageText('⚠️ Order tidak ditemukan atau sudah diproses.');
        return;
    }

    order.status = 'processing';
    saveOrders(orders);

    await ctx.editMessageText(
        `⏳ <b>Memproses order...</b>\n\n` +
        `📧 ${escapeHtml(order.email)}\n` +
        `📅 ${order.plan === '1month' ? '1 Bulan' : '1 Minggu'}`,
        { parse_mode: 'HTML' }
    );

    // Process the invite
    const account = accountManager.getAvailableAccount();
    if (!account) {
        order.status = 'failed';
        saveOrders(orders);
        await ctx.editMessageText('❌ Tidak ada akun GPT tersedia!');
        return;
    }

    const chatId = ctx.chat.id;
    const msgId = ctx.callbackQuery.message.message_id;

    // Non-blocking
    browserQueue.add('invite', account.id,
        () => chatgptService.inviteTeamMember(account, order.email),
        { email: order.email }
    ).then(async (result) => {
        if (result.success) {
            const memberRecord = memberManager.addMember(order.email, account.id, account.email, order.plan, order.userId);
            order.status = 'completed';
            saveOrders(orders);

            const timeLeft = memberManager.getTimeRemaining(memberRecord);
            const planLabel = order.plan === '1month' ? '1 Bulan' : '1 Minggu';

            try {
                await bot.api.editMessageText(chatId, msgId,
                    `✅ <b>Order Selesai!</b>\n\n` +
                    `📧 ${escapeHtml(order.email)}\n` +
                    `📅 ${planLabel}\n` +
                    `⏰ Expire: ${new Date(memberRecord.expiresAt).toLocaleDateString('id-ID')}\n` +
                    `💵 ${formatRupiah(order.price)}`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) { }

            // Notify user
            try {
                await bot.api.sendMessage(order.userId,
                    `🎉 <b>Invite Berhasil!</b>\n\n` +
                    `📧 ${escapeHtml(order.email)}\n` +
                    `📅 Plan: ${planLabel}\n` +
                    `⏰ Aktif sampai: ${new Date(memberRecord.expiresAt).toLocaleDateString('id-ID')}\n` +
                    `⏳ Sisa: ${timeLeft}\n\n` +
                    `📬 <i>Cek inbox email kamu untuk join\nworkspace ChatGPT Team!</i>`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) { }
        } else {
            order.status = 'failed';
            saveOrders(orders);
            try {
                await bot.api.editMessageText(chatId, msgId,
                    `❌ <b>Invite Gagal</b>\n\n${escapeHtml(result.message)}`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) { }
        }
    }).catch(e => console.error(`❌ Retry invite error: ${e.message}`));
});

bot.callbackQuery(/^admin:reject:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const orderId = ctx.match[1];
    const orders = loadOrders();
    const order = orders.find(o => o.id === orderId);

    if (!order) {
        await ctx.editMessageText('⚠️ Order tidak ditemukan.');
        return;
    }

    order.status = 'rejected';
    saveOrders(orders);

    await ctx.editMessageText(
        `❌ <b>Order Ditolak</b>\n\n` +
        `📧 ${escapeHtml(order.email)}\n` +
        `👤 ${escapeHtml(order.userName)}`,
        { parse_mode: 'HTML' }
    );

    // Notify user
    try {
        await bot.api.sendMessage(order.userId,
            `❌ <b>Order Ditolak</b>\n\n` +
            `📧 ${escapeHtml(order.email)}\n\n` +
            `Hubungi admin untuk info lebih lanjut.`,
            { parse_mode: 'HTML' }
        );
    } catch (e) { }
});

// ============================================================
// TEXT INPUT HANDLER (email, add account, broadcast, etc.)
// ============================================================
bot.on('message:text', async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text.trim();

    // Skip commands
    if (text.startsWith('/')) return;

    // Check admin state FIRST (so broadcast etc. isn't intercepted by user state)
    const aState = adminState[userId];
    if (aState?.action && isAdmin(userId)) {
        await handleAdminTextInput(ctx, userId, text, aState);
        return;
    }

    // Check user state
    const uState = userState[userId];
    if (uState?.action) {
        await handleUserTextInput(ctx, userId, text, uState);
        return;
    }
});

async function handleUserTextInput(ctx, userId, text, state) {
    const action = state.action;

    // Voucher code input
    if (action === 'waiting_voucher') {
        try { await ctx.deleteMessage(); } catch (e) { }
        const result = voucherManager.claimVoucher(text, String(userId));

        if (result.success) {
            state.action = null;
            const name = ctx.from.first_name || 'User';
            await bot.api.editMessageText(ctx.chat.id, state.messageId,
                getUserDashboardText(userId, name),
                { parse_mode: 'HTML', reply_markup: userDashboardKeyboard(userId) }
            );
        } else {
            // Keep action so user can retry
            try {
                await bot.api.editMessageText(ctx.chat.id, state.messageId,
                    `🎟️ <b>Apply Voucher</b>\n\n❌ ${escapeHtml(result.message)}\n\nMasukkan kode lain atau kembali:`,
                    { parse_mode: 'HTML', reply_markup: backKeyboard() }
                );
            } catch (e) {
                // Same message error — send reply instead
                const reply = await ctx.reply(`❌ ${result.message}\n\nCoba kode lain:`);
                setTimeout(() => { try { bot.api.deleteMessage(ctx.chat.id, reply.message_id); } catch(e) {} }, 3000);
            }
        }
        return;
    }

    if (['waiting_email_free', 'waiting_email_buy_1week', 'waiting_email_buy_1month'].includes(action)) {
        const email = text.toLowerCase().trim();

        if (!email.includes('@') || !email.includes('.')) {
            await ctx.reply('❌ Email tidak valid. Coba lagi.');
            return;
        }

        // Check email duplication — block if email already active in members
        const existingMember = memberManager.findMemberByEmail(email);
        if (existingMember) {
            await ctx.reply(`❌ Email ${escapeHtml(email)} sudah terdaftar dan masih aktif.\n⏳ Sisa: ${memberManager.getTimeRemaining(existingMember)}`, { parse_mode: 'HTML' });
            return;
        }

        // Delete user's email message to keep chat clean
        try { await ctx.deleteMessage(); } catch (e) { }

        const voucher = voucherManager.getUserVoucher(String(userId));

        let plan, planLabel, confirmData;
        if (action === 'waiting_email_free') {
            plan = 'free';
            planLabel = '1 Minggu (Free)';
            confirmData = `confirm_invite:free:${email}`;
        } else if (action === 'waiting_email_buy_1week') {
            plan = '1week';
            const p = voucher ? voucherManager.applyDiscount(PRICE_1WEEK, voucher) : PRICE_1WEEK;
            planLabel = `1 Minggu (${formatRupiah(p)})`;
            confirmData = `confirm_invite:1week:${email}`;
        } else {
            plan = '1month';
            const p = voucher ? voucherManager.applyDiscount(PRICE_1MONTH, voucher) : PRICE_1MONTH;
            planLabel = `1 Bulan (${formatRupiah(p)})`;
            confirmData = `confirm_invite:1month:${email}`;
        }

        const kb = new InlineKeyboard()
            .text('✅ Konfirmasi', confirmData)
            .text('❌ Batal', 'cancel_invite');

        // Edit the dashboard message
        try {
            await bot.api.editMessageText(ctx.chat.id, state.messageId,
                `📧 <b>Konfirmasi Invite</b>\n\n` +
                `📧 Email: ${escapeHtml(email)}\n` +
                `📅 Plan: ${planLabel}\n\n` +
                `Yakin mau invite email ini?`,
                { parse_mode: 'HTML', reply_markup: kb }
            );
        } catch (e) {
            // Fallback: send new message
            await ctx.reply(
                `📧 <b>Konfirmasi Invite</b>\n\n` +
                `📧 Email: ${escapeHtml(email)}\n` +
                `📅 Plan: ${planLabel}\n\n` +
                `Yakin mau invite email ini?`,
                { parse_mode: 'HTML', reply_markup: kb }
            );
        }

        state.action = null;
    }
}

async function handleAdminTextInput(ctx, userId, text, state) {
    const action = state.action;

    try { await ctx.deleteMessage(); } catch (e) { }

    // Voucher create
    if (action === 'waiting_voucher_create') {
        const parts = text.split(/\s+/);
        if (parts.length < 4) {
            await safeEdit(ctx.chat.id, state.messageId,
                `❌ Format salah.\n\nContoh: <code>DISKON50 percent 50 10</code>`,
                { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'admin:vouchers') }
            );
            state.action = null;
            return;
        }

        const [code, type, value, maxUses] = parts;
        if (!['percent', 'fixed'].includes(type)) {
            await safeEdit(ctx.chat.id, state.messageId,
                `❌ Tipe harus <code>percent</code> atau <code>fixed</code>.`,
                { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'admin:vouchers') }
            );
            state.action = null;
            return;
        }

        const result = voucherManager.createVoucher(code, type, parseInt(value), parseInt(maxUses));
        await safeEdit(ctx.chat.id, state.messageId,
            result.success
                ? `✅ Voucher <code>${code.toUpperCase()}</code> berhasil dibuat!\n\nTipe: ${type}\nNilai: ${value}\nMax: ${maxUses}`
                : `❌ ${result.message}`,
            { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'admin:vouchers') }
        );
        state.action = null;
        return;
    }

    // Voucher delete
    if (action === 'waiting_voucher_delete') {
        const result = voucherManager.deleteVoucher(text);
        await safeEdit(ctx.chat.id, state.messageId,
            result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
            { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'admin:vouchers') }
        );
        state.action = null;
        return;
    }

    if (action === 'waiting_add_account') {
        const lines = text.split('\n').map(l => l.trim()).filter(l => l);
        const results = [];

        for (const line of lines) {
            const parts = line.split(/\s+/);
            if (parts.length < 2) {
                results.push(`❌ <code>${escapeHtml(line)}</code> — format salah`);
                continue;
            }
            const [email, password, twoFASecret] = parts;
            const result = accountManager.addAccount(email, password, twoFASecret || '');
            results.push(result.success
                ? `✅ ${escapeHtml(email)}`
                : `❌ ${escapeHtml(email)} — ${escapeHtml(result.message)}`);
        }

        await safeEdit(ctx.chat.id, state.messageId,
            `✚ <b>Tambah Akun</b>\n\n${results.join('\n')}`,
            { parse_mode: 'HTML', reply_markup: adminBackKeyboard() }
        );
        state.action = null;
    }

    if (action === 'waiting_delete_account') {
        const email = text.toLowerCase().trim();
        const result = accountManager.deleteAccountByEmail(email);

        await safeEdit(ctx.chat.id, state.messageId,
            `🗑️ <b>Hapus Akun</b>\n\n${escapeHtml(result.message)}`,
            { parse_mode: 'HTML', reply_markup: adminBackKeyboard() }
        );
        state.action = null;
    }

    if (action === 'waiting_admin_invite_email') {
        const email = text.toLowerCase().trim();
        if (!email.includes('@')) {
            await ctx.reply('❌ Email tidak valid.');
            return;
        }

        state.inviteEmail = email;
        state.action = null;

        const kb = new InlineKeyboard()
            .text('📅 1 Minggu', `admin_invite_plan:1week:${email}`)
            .text('📅 1 Bulan', `admin_invite_plan:1month:${email}`).row()
            .text('⬅️ Kembali', 'admin:home');

        await safeEdit(ctx.chat.id, state.messageId,
            `📧 <b>Admin Invite</b>\n\n` +
            `Email: <code>${escapeHtml(email)}</code>\n\n` +
            `Pilih durasi plan:`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
        return;
    }


    if (action === 'waiting_kick_email') {
        const email = text.toLowerCase().trim();
        const member = memberManager.findMemberByEmail(email);

        if (!member) {
            await safeEdit(ctx.chat.id, state.messageId,
                `❌ ${escapeHtml(email)} tidak ditemukan di member aktif.`,
                { parse_mode: 'HTML', reply_markup: adminBackKeyboard() }
            );
            state.action = null;
            return;
        }

        const account = accountManager.getAccountById(member.gptAccountId);
        if (!account) {
            await safeEdit(ctx.chat.id, state.messageId,
                `❌ Akun GPT tidak ditemukan.`,
                { parse_mode: 'HTML', reply_markup: adminBackKeyboard() }
            );
            state.action = null;
            return;
        }

        await safeEdit(ctx.chat.id, state.messageId,
            `⏳ <b>Kick...</b>\n🔨 ${escapeHtml(email)}\n🖥️ via ${escapeHtml(account.email)}`,
            { parse_mode: 'HTML' }
        );
        state.action = null;

        const chatId = ctx.chat.id;
        const msgId = state.messageId;

        // Non-blocking
        browserQueue.add('kick', account.id,
            () => chatgptService.kickTeamMember(account, email),
            { email }
        ).then(async (result) => {
            if (result.success) {
                memberManager.removeMember(email);
                accountManager.decrementInviteCount(account.id);
                await safeEdit(chatId, msgId,
                    `✅ <b>Kick Berhasil!</b>\n\n🔨 ${escapeHtml(email)}\n📊 Slot: ${account.inviteCount - 1}/${account.maxInvites}`,
                    { parse_mode: 'HTML', reply_markup: adminBackKeyboard() }
                );
            } else {
                const notFound = result.message && result.message.includes('tidak ditemukan');
                if (notFound) {
                    await safeEdit(chatId, msgId,
                        `⚠️ <b>Email tidak ada di ChatGPT</b>\n\n` +
                        `📧 ${escapeHtml(email)}\n` +
                        `ℹ️ User mungkin tidak pernah join workspace.\n\n` +
                        `Hapus dari database dan kembalikan slot?`,
                        { parse_mode: 'HTML', reply_markup: new InlineKeyboard()
                            .text('✅ Ya, Hapus', `force_remove:${email}`)
                            .text('❌ Batal', 'admin:home')
                        }
                    );
                } else {
                    await safeEdit(chatId, msgId,
                        `❌ <b>Kick Gagal:</b> ${escapeHtml(result.message)}`,
                        { parse_mode: 'HTML', reply_markup: adminBackKeyboard() }
                    );
                }
            }
        }).catch(e => console.error(`❌ Admin kick error: ${e.message}`));
    }

    if (action === 'waiting_broadcast') {
        await doBroadcast(ctx, state);
    }
}

// Broadcast: copy admin message to all users (text, photo, video, any)
async function doBroadcast(ctx, state) {
    const users = userManager.loadUsers().users || [];
    let sent = 0;
    console.log(`📢 Broadcast dimulai ke ${users.length} users, msgId: ${ctx.message.message_id}`);

    await safeEdit(ctx.chat.id, state.messageId,
        `📢 <b>Broadcasting...</b>\n👥 ${users.length} users`,
        { parse_mode: 'HTML' }
    );

    for (const user of users) {
        try {
            const tgId = user.telegramId;
            await bot.api.copyMessage(tgId, ctx.chat.id, ctx.message.message_id);
            sent++;
        } catch (e) {
            console.error(`❌ Broadcast to ${user.telegramId}: ${e.message}`);
        }
    }

    await safeEdit(ctx.chat.id, state.messageId,
        `📢 <b>Broadcast Selesai!</b>\n\n✅ Terkirim: ${sent}/${users.length}`,
        { parse_mode: 'HTML', reply_markup: adminBackKeyboard() }
    );
    state.action = null;
}

// Catch non-text messages (photo, video, doc, sticker) for broadcast
bot.on('message', async (ctx) => {
    // Only handle for admin broadcast
    const userId = ctx.from.id;
    if (!ADMIN_IDS.includes(userId)) return;
    const state = adminState[userId];
    if (!state || state.action !== 'waiting_broadcast') return;
    // Text messages already handled by bot.on('message:text')
    if (ctx.message.text) return;

    await doBroadcast(ctx, state);
});

// ============================================================
// ORDERS
// ============================================================
function loadOrders() {
    try {
        if (fs.existsSync('data/orders.json')) {
            return JSON.parse(fs.readFileSync('data/orders.json', 'utf8'));
        }
    } catch (e) { }
    return [];
}

function saveOrders(orders) {
    ensureDataDir();
    fs.writeFileSync('data/orders.json', JSON.stringify(orders, null, 2));
}

// ============================================================
// AUTO-KICK TIMER
// ============================================================
function startAutoKickTimer() {
    const CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

    console.log('⏰ Auto-kick timer aktif (cek /1 jam)');

    setInterval(async () => {
        await processExpiredMembers();
    }, CHECK_INTERVAL);

    // Check 10s after boot
    setTimeout(async () => {
        await processExpiredMembers();
    }, 10000);
}

async function processExpiredMembers() {
    const expired = memberManager.getExpiredMembers();
    if (expired.length === 0) return;

    console.log(`⏰ ${expired.length} member expired, processing...`);

    for (const member of expired) {
        const account = accountManager.getAccountById(member.gptAccountId);

        if (!account) {
            memberManager.removeMember(member.userEmail);
            continue;
        }

        try {
            const result = await browserQueue.add('kick', account.id,
                () => chatgptService.kickTeamMember(account, member.userEmail),
                { email: member.userEmail }
            );

            if (result.success) {
                memberManager.removeMember(member.userEmail);
                accountManager.decrementInviteCount(account.id);
                console.log(`✅ Auto-kick: ${member.userEmail}`);

                // Notify admins
                for (const adminId of ADMIN_IDS) {
                    try {
                        await bot.api.sendMessage(adminId,
                            `⏰ <b>AUTO-KICK</b>\n\n` +
                            `📧 ${member.userEmail}\n` +
                            `📅 ${member.plan === '1month' ? '1 Bulan' : '1 Minggu'}\n` +
                            `✅ Removed dari ${account.email}\n` +
                            `📊 Slot: ${account.inviteCount - 1}/${account.maxInvites}`,
                            { parse_mode: 'HTML' }
                        );
                    } catch (e) { }
                }
            } else {
                // Email not found in ChatGPT = user never joined → cleanup our database anyway
                const notFound = result.message && result.message.includes('tidak ditemukan');
                if (notFound) {
                    memberManager.removeMember(member.userEmail);
                    accountManager.decrementInviteCount(account.id);
                    console.log(`🧹 Auto-cleanup: ${member.userEmail} (not in ChatGPT, removed from db)`);
                    for (const adminId of ADMIN_IDS) {
                        try {
                            await bot.api.sendMessage(adminId,
                                `🧹 <b>AUTO-CLEANUP</b>\n\n` +
                                `📧 ${member.userEmail}\n` +
                                `ℹ️ Email tidak ada di ChatGPT (tidak pernah join).\n` +
                                `✅ Dihapus dari database, slot dikembalikan.`,
                                { parse_mode: 'HTML' }
                            );
                        } catch (e) { }
                    }
                } else {
                    console.log(`❌ Auto-kick gagal: ${member.userEmail}`);
                    for (const adminId of ADMIN_IDS) {
                        try {
                            await bot.api.sendMessage(adminId,
                                `⚠️ <b>AUTO-KICK GAGAL</b>\n\n📧 ${member.userEmail}\n❌ ${result.message}`,
                                { parse_mode: 'HTML' }
                            );
                        } catch (e) { }
                    }
                }
            }
        } catch (e) {
            console.error(`❌ Error auto-kick ${member.userEmail}:`, e.message);
        }

        // Wait between kicks
        await new Promise(r => setTimeout(r, 5000));
    }
}

// ============================================================
// ERROR HANDLING & START
// ============================================================
bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`❌ Error for ${ctx?.update?.update_id}:`);
    const e = err.error;
    if (e instanceof GrammyError) {
        console.error('Grammy error:', e.description);
    } else if (e instanceof HttpError) {
        console.error('HTTP error:', e);
    } else {
        console.error('Unknown error:', e);
    }
});

console.log('🤖 Starting Telegram Bot...');
bot.start({
    onStart: () => {
        console.log('✅ Bot aktif!');
        startAutoKickTimer();
    }
});
