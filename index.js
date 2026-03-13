require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const QRCode = require('qrcode');
const { User, Transaction, db } = require('./db');
const GoogleDriveService = require('./googleDrive');
const bot = new Telegraf(process.env.BOT_TOKEN);
const driveService = new GoogleDriveService(process.env.GOOGLE_DRIVE_CREDENTIALS);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const http = require('http');

const isVercel = process.env.VERCEL === '1';
const isRender = !!process.env.RENDER;
const DB_PATH = (isVercel || isRender) ? path.join('/tmp', 'bot_database.db') : path.join(__dirname, 'bot_database.db');
const DB_FILE_NAME = 'bot_database.db';

// --- Global Error Handlers ---
process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

// --- Backup System ---

async function initBackupSystem() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            console.log('Database missing. Searching for backup on Google Drive...');
            const backupFile = await driveService.findFileByName(DB_FILE_NAME);
            if (backupFile) {
                console.log(`Backup found: ${backupFile.id}. Downloading...`);
                await driveService.downloadFile(backupFile.id, DB_PATH);
                console.log('Database restored from Google Drive.');
            } else {
                console.log('No backup found on Google Drive. Starting with a fresh database.');
            }
        }
    } catch (err) {
        console.error('Backup restoration failed:', err.message);
    }
}

// Scheduled Auto-Backup (Every day at midnight)
cron.schedule('0 0 * * *', async () => {
    console.log('Running scheduled database backup...');
    try {
        await driveService.uploadFile(DB_PATH, DB_FILE_NAME);
        console.log('Auto-backup completed successfully.');
    } catch (err) {
        console.error('Auto-backup failed:', err.message);
    }
});

// Constants
const PLANS = {
    '1month': { name: '1-Month Plan', days: 30, price: 99 },
    '3months': { name: '3-Months Plan', days: 90, price: 250 },
    '6months': { name: '6-Months Plan', days: 180, price: 540 },
    '1year': { name: '1-Year Plan', days: 360, price: 1050 }
};

// --- Middleware ---

const checkMembership = async (ctx, next) => {
    const userId = ctx.from.id;
    let user = await User.findOne({ userId });

    if (!user) {
        user = await User.create({
            userId,
            username: ctx.from.username || ctx.from.first_name || 'User'
        });
    }

    ctx.state.user = user;

    const isMember = user.membershipExpiry && new Date(user.membershipExpiry) > new Date();
    ctx.state.isMember = isMember;

    return next();
};

// --- Helpers ---

const deleteMessageAfter = (chatId, messageId, delayMs = 600000) => {
    setTimeout(async () => {
        try {
            await bot.telegram.deleteMessage(chatId, messageId);
            console.log(`Deleted message ${messageId} in chat ${chatId}`);
        } catch (err) {
            console.error('Failed to delete message:', err.message);
        }
    }, delayMs);
};

const generateUPIQR = async (upiId, amount, name) => {
    const upiLink = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(name)}&am=${amount}&cu=INR`;
    try {
        const qrBuffer = await QRCode.toBuffer(upiLink, {
            errorCorrectionLevel: 'H',
            type: 'png',
            margin: 4,
            width: 512,
            color: {
                dark: '#000000',
                light: '#ffffff'
            }
        });
        return qrBuffer;
    } catch (err) {
        console.error('QR Generation Error:', err);
        throw err;
    }
};

// --- State Management ---
const userState = new Map();

// --- Handlers ---

// Handle /start and deep links
bot.start(checkMembership, async (ctx) => {
    const startPayload = ctx.payload;
    const user = ctx.state.user;

    if (!startPayload) {
        return ctx.reply('Welcome! Use a video link from the channel to access content.');
    }

    if (ctx.state.isMember) {
        return deliverVideo(ctx, startPayload);
    } else {
        // Store videoId for later delivery after payment
        userState.set(ctx.from.id, { videoId: startPayload });
        return showMembershipPlans(ctx);
    }
});

// Admin Command: Generate Bot Link
bot.command('link', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;

    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) {
        return ctx.reply('❌ <b>Usage:</b> /link &lt;google_drive_file_id&gt;', { parse_mode: 'HTML' });
    }

    const fileId = parts[1];
    const botInfo = await bot.telegram.getMe();
    const link = `https://t.me/${botInfo.username}?start=${fileId}`;

    await ctx.reply(`🔗 <b>Generated Deep Link:</b>\n\n<code>${link}</code>\n\n<i>Copy and paste this link into your channel. Ensure there are NO SPACES in the link.</i>`, {
        parse_mode: 'HTML'
    });
});

// Admin Command: Manual Backup
bot.command('backup', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const msg = await ctx.reply('🔄 Starting manual database backup...');
    try {
        await driveService.uploadFile(DB_PATH, DB_FILE_NAME);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '✅ Database backup successful!');
    } catch (err) {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '❌ Backup failed: ' + err.message);
    }
});

// Admin Command: Set Webhook (for Vercel)
bot.command('setwebhook', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) {
        return ctx.reply('❌ <b>Usage:</b> /setwebhook &lt;vercel_url&gt;\nExample: <code>/setwebhook https://your-project.vercel.app</code>', { parse_mode: 'HTML' });
    }

    const url = parts[1].replace(/\/$/, '') + '/api';
    try {
        await bot.telegram.setWebhook(url);
        await ctx.reply(`✅ <b>Webhook Set Successfully!</b>\n\nURL: <code>${url}</code>`, { parse_mode: 'HTML' });
    } catch (err) {
        await ctx.reply(`❌ <b>Failed to set Webhook:</b>\n${err.message}`, { parse_mode: 'HTML' });
    }
});

const showMembershipPlans = async (ctx) => {
    const message = `
🌟 <b>Premium Membership Plans</b> 🌟

Select a plan to unlock all study content and videos.

💎 <b>1-Month Plan</b> (30 days): ₹99
💎 <b>3-Months Plan</b> (90 days): ₹250
💎 <b>6-Months Plan</b> (180 days): ₹540
💎 <b>1-Year Plan</b> (360 days): ₹1050

<i>Get instant access after payment verification.</i>
    `;

    const buttons = Object.entries(PLANS).map(([key, plan]) => [
        Markup.button.callback(`${plan.name} - ₹${plan.price}`, `buy_${key}`)
    ]);

    if (ctx.callbackQuery) {
        await ctx.editMessageText(message, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
        });
    } else {
        await ctx.replyWithHTML(message, Markup.inlineKeyboard(buttons));
    }
};

// Handle Plan Selection
bot.action(/^buy_(.+)$/, async (ctx) => {
    const planKey = ctx.match[1];
    const plan = PLANS[planKey];
    ctx.answerCbQuery();

    // Update state
    const state = userState.get(ctx.from.id) || {};
    state.selectedPlan = planKey;
    userState.set(ctx.from.id, state);

    const message = `
💳 <b>Payment for ${plan.name}</b>

<b>Amount to Pay:</b> ₹${plan.price}

Please scan the QR code below to complete your payment. 
After payment, click the <b>"Paid Successfully"</b> button below.
    `;

    try {
        await ctx.deleteMessage();
    } catch (e) { }

    try {
        const qrBuffer = await generateUPIQR(process.env.UPI_ID, plan.price, process.env.MERCHANT_NAME);
        await ctx.replyWithPhoto({ source: qrBuffer }, {
            caption: message,
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('Paid Successfully ✅', `paid_${planKey}`)],
                [Markup.button.callback('⬅️ Back to Plans', 'show_plans')]
            ])
        });
    } catch (err) {
        console.error('Payment Flow Error:', err);
        ctx.reply('Failed to generate payment QR. Please contact support.');
    }
});

bot.action('show_plans', showMembershipPlans);

// Handle "Paid Successfully"
bot.action(/^paid_(.+)$/, async (ctx) => {
    ctx.answerCbQuery();

    await ctx.deleteMessage();
    const msg = await ctx.reply('Please enter the <b>UPI Reference ID / Transaction ID</b> of your payment:', { parse_mode: 'HTML' });

    // Save state that we are expecting a trans ID
    const state = userState.get(ctx.from.id) || {};
    state.awaitingTransId = true;
    state.lastBotMsg = msg.message_id;
    userState.set(ctx.from.id, state);
});

// Handle Transaction ID Input
bot.on('text', async (ctx, next) => {
    const state = userState.get(ctx.from.id);
    if (!state || !state.awaitingTransId) {
        return next();
    }

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return next();

    const transId = text;
    const plan = PLANS[state.selectedPlan];

    // Clean up messages
    try {
        await ctx.deleteMessage(); // Delete User's message
        if (state.lastBotMsg) {
            await ctx.telegram.deleteMessage(ctx.chat.id, state.lastBotMsg); // Delete "Please enter..." msg
        }
    } catch (e) { }

    // Save Transaction to DB
    await Transaction.create({
        userId: ctx.from.id,
        username: ctx.from.username || ctx.from.first_name,
        plan: plan.name,
        amount: plan.price,
        transactionId: transId,
        status: 'pending'
    });

    // Notify User
    await ctx.reply('✅ <b>Payment Submitted!</b>\n\nYour Payment is Currently In Verification Process. Please wait until it is Approved.', { parse_mode: 'HTML' });

    // Notify Admin
    await bot.telegram.sendMessage(ADMIN_ID,
        `🔔 <b>New Payment Verification Request</b>\n\n` +
        `👤 <b>Username:</b> @${ctx.from.username || 'N/A'}\n` +
        `🆔 <b>User ID:</b> ${ctx.from.id}\n` +
        `📅 <b>Plan:</b> ${plan.name} (₹${plan.price})\n` +
        `💸 <b>Transaction ID:</b> <code>${transId}</code>`,
        {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('Approve ✅', `approve_${ctx.from.id}_${state.selectedPlan}`)],
                [Markup.button.callback('Reject ❌', `reject_${ctx.from.id}`)]
            ])
        }
    );

    // Reset state but keep videoId if they were trying to watch something
    const newState = { videoId: state.videoId };
    userState.set(ctx.from.id, newState);
});

// Admin Approval
bot.action(/^approve_(\d+)_(.+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');

    const userId = parseInt(ctx.match[1]);
    const planKey = ctx.match[2];
    const plan = PLANS[planKey];
    ctx.answerCbQuery('Approved');

    // Calculate Expiry
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + plan.days);

    await User.findOneAndUpdate(
        { userId },
        { status: 'active', membershipExpiry: expiry },
        { upsert: true }
    );

    // Update Transaction
    await Transaction.findOneAndUpdate({ userId, status: 'pending' }, { status: 'approved', processedAt: new Date() });

    await ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n✅ <b>APPROVED - ${plan.name}</b>`, { parse_mode: 'HTML' });

    await bot.telegram.sendMessage(userId, 'Congratulations! You have Successfully Paid for the Membership. 🌟\n\nYou can now access the video links provided in the channel.');
});

bot.action(/^reject_(\d+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');

    const userId = ctx.match[1];
    ctx.answerCbQuery('Rejected');

    await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ <b>REJECTED</b>', { parse_mode: 'HTML' });

    await bot.telegram.sendMessage(userId, 'Your payment verification was rejected. Please contact support if this is a mistake.');
});

// Deliver Video
const deliverVideo = async (ctx, videoId) => {
    let loadingMsg;
    try {
        loadingMsg = await ctx.reply('⏳ Your video is Loading...');

        const fileInfo = await driveService.getFileInfo(videoId);
        const stream = await driveService.getFileStream(videoId);

        const caption = `
🎥 <b>Study Content unlocked!</b>

${fileInfo.name}

⚠️ <b>Note:</b> This video will get Automatically deleted from the chat in 600 Seconds.
        `;

        const sentMsg = await ctx.replyWithVideo({ source: stream }, {
            caption,
            parse_mode: 'HTML',
            protect_content: true // Prevent forwarding/downloading
        });

        // Delete loading message
        try {
            if (loadingMsg) {
                await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
            }
        } catch (e) {
            console.error('Failed to delete loading message:', e.message);
        }

        // Start 600s timer
        deleteMessageAfter(ctx.chat.id, sentMsg.message_id, 600000);

    } catch (err) {
        console.error('Error delivering video:', err.message);
        
        // Clean up loading message on error
        if (loadingMsg) {
            try {
                await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
            } catch (e) {}
        }
        
        ctx.reply('Failed to fetch the video. Please check the link or contact admin.');
    }
};

// Export for Vercel
module.exports = { bot, initBackupSystem };

// Start polling and HTTP server if run directly and NOT on Vercel
if (require.main === module && !isVercel) {
    // Simple HTTP server for health checks (Render/UptimeRobot)
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Bot is running and healthy!\n');
    });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Health check server listening on port ${PORT} (0.0.0.0)`);
    }).on('error', (err) => {
        console.error('HTTP Server Error:', err.message);
    });

    // Keep-alive logging
    setInterval(() => {
        console.log(`[Keep-Alive] Bot is still active at ${new Date().toISOString()}`);
    }, 300000); // Every 5 minutes

    initBackupSystem()
        .then(() => {
            console.log('Database system initialized.');
            return bot.launch();
        })
        .then(() => {
            console.log('Bot is running in polling mode...');
        })
        .catch((err) => {
            console.error('Failed to start bot:', err.message);
        });
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
