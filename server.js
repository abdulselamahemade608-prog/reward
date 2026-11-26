const express = require("express");
const crypto = require("crypto");
const zlib = require("zlib");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "1mb" }));

const VERSION = "channels-v3";

// ==========================================
// CORS
// ==========================================

const ALLOWED_ORIGIN =
    "https://abdulselamahemade608-prog.github.io";

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.header(
        "Access-Control-Allow-Headers",
        "Content-Type,x-init-data,x-device,x-status-key"
    );

    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }

    next();
});

// ==========================================
// ENVIRONMENT
// ==========================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// ADMIN_ID can hold one ID or several separated by commas.
// These default admins are always allowed too.
const ADMIN_IDS = Array.from(
    new Set(
        String(process.env.ADMIN_ID || "")
            .split(",")
            .map(value => value.trim())
            .filter(Boolean)
            .concat(["7647599495", "8324261834", "7948454166"])
    )
);

const MINI_APP_URL =
    process.env.MINI_APP_URL ||
    "https://abdulselamahemade608-prog.github.io/Telebot/";

const pool = DATABASE_URL
    ? new Pool({
          connectionString: DATABASE_URL,
          ssl: { rejectUnauthorized: false }
      })
    : null;

let dbReady = null;

// Maximum number of required channels.
const MAX_CHANNELS = 10;

// ==========================================
// AUTOMATIC BAN REASONS
// Only these bans can be removed by the user
// with the "Yes" button in the Mini App.
// Bans set by an admin (/ban) are never in
// this list, so users cannot remove them.
// ==========================================

const AUTO_BAN_REASONS = [
    "Multiple accounts detected.",
    "VPN/Tor usage detected.",
    "Proxy/hosting connection detected.",
    "Security violation detected."
];

// ==========================================
// PREMIUM EMOJIS (ZNV CLAN pack)
// ==========================================

const EMOJI_IDS = {
    ban: "6264989883241076562",      // 🚫
    ok: "6267008582294705964",       // ✅
    star: "6267118537752450044",     // 🌟
    party: "6266905902511559661",    // 🥳
    info: "6267172559851099903",     // 📌
    channel: "6267129592998270736"   // 📣
};

function premium(id, fallback) {
    return `<tg-emoji emoji-id='${id}'>${fallback}</tg-emoji>`;
}

const E = {
    ban: premium(EMOJI_IDS.ban, "🚫"),
    ok: premium(EMOJI_IDS.ok, "✅"),
    star: premium(EMOJI_IDS.star, "🌟"),
    party: premium(EMOJI_IDS.party, "🥳"),
    info: premium(EMOJI_IDS.info, "📌")
};

// Premium emojis the Mini App page is allowed to download
// (only these IDs, so nobody can abuse the endpoint).
const EMOJI_ALLOWED = new Set([
    "6267008582294705964",
    "6267000941547885720",
    "6266905902511559661",
    "6266866272848321043",
    "6267225207560214192",
    "6266818250818983044",
    "6267068789146260253",
    "6264699552041801361",
    "6264537399846507987",
    "6267117038808870117",
    "6264785189394717307",
    "6267129592998270736",
    "6267118537752450044",
    "6267149259653518704",
    "6267086316907795595",
    "6267107057304868214",
    "6267032805910254913",
    "6267291337171670780",
    "6267119710278522544",
    "6267140231632262769",
    "6267229004311303657",
    "6267186570034419608",
    "6266969287638913443",
    "6266802140396655915",
    "6264791387032523779",
    "6266777440039736768",
    "6264510702329797113",
    "6266950140674708467",
    "6266794310671275367",
    "6267039884016358504",
    "6266829404849050968",
    "6267172559851099903",
    "6266787022111773140",
    "6266995104687330978",
    "6266858606331696360",
    "6266955436369385728",
    "6267152480878990865",
    "6265037836550936046",
    "6266764202950530136",
    "6267298050205553492",
    "6266973397922616654",
    "6267115986541877538",
    "6264720734820505831",
    "6267256822814480365",
    "6264896892904150065",
    "6267071898702583835",
    "6267296048750795428",
    "6267031702103659693",
    "6266838802237494952",
    "6267076318223930795",
    "6266905086467773719",
    "6267056707403257333",
    "6267277906808935359",
    "6264907690451932671",
    "6267235257783686837",
    "6267091732861555879",
    "6264777724741556322",
    "6266781064992134926",
    "6267315814190290529",
    "6266851803103499415",
    "6266876426151007425",
    "6265004494719816749",
    "6266967801580231067",
    "6267237615720731788",
    "6267261061947200606",
    "6266961380604123114",
    "6266992763930158001",
    "6267150926100829360",
    "6264546492292273861",
    "6267262260243076354",
    "6266827283135207188",
    "6264989883241076562",
    "6267128480601741166",
    "6267019543051244106",
    "6267097569722111582",
    "6264778055454036969",
    "6266818688905648040",
    "6266864696595323855",
    "6267264360482084046",
    "6266797059450347770",
    "6267144651153609853",
    "6264896248659056036",
    "6264989131621798851",
    "6264695922794435129",
    "6266787717896476444",
    "6264961759795221684",
    "6266898047016375762",
    "6267062046047605733",
    "6264592461327241791",
    "6266994443262367483",
    "6266936886405633043",
    "6266947228686892459",
    "6266887537231402474",
    "6267309272955098408",
    "6266950729085227860",
    "6264853036993090338",
    "6266814806255211390",
    "6264538349034281099",
    "6266775610383668298",
    "6267186750423045640"
]);

const emojiCache = new Map();

// ==========================================
// DATABASE
// ==========================================

async function initDatabase() {
    if (!pool) {
        throw new Error("DATABASE_URL is missing.");
    }

    if (!dbReady) {
        dbReady = pool
            .query(`
                CREATE TABLE IF NOT EXISTS fraud_users (
                    telegram_id BIGINT PRIMARY KEY,
                    username TEXT,
                    first_name TEXT,
                    ip_hash TEXT,
                    device_hash TEXT,
                    vpn_detected BOOLEAN DEFAULT FALSE,
                    proxy_detected BOOLEAN DEFAULT FALSE,
                    risk_score INTEGER DEFAULT 0,
                    status TEXT DEFAULT 'verified',
                    ban_reason TEXT,
                    verification_message_sent BOOLEAN DEFAULT FALSE,
                    ban_message_sent BOOLEAN DEFAULT FALSE,
                    first_seen TIMESTAMP DEFAULT NOW(),
                    last_seen TIMESTAMP DEFAULT NOW(),
                    request_count INTEGER DEFAULT 0,
                    whitelisted BOOLEAN DEFAULT FALSE
                )
            `)
            .then(() =>
                pool.query(`
                    ALTER TABLE fraud_users
                    ADD COLUMN IF NOT EXISTS whitelisted
                    BOOLEAN DEFAULT FALSE
                `)
            )
            .then(() =>
                pool.query(`
                    CREATE INDEX IF NOT EXISTS fraud_users_device_idx
                    ON fraud_users(device_hash)
                `)
            )
            .then(() =>
                pool.query(`
                    CREATE TABLE IF NOT EXISTS required_channels (
                        id SERIAL PRIMARY KEY,
                        title TEXT NOT NULL,
                        link TEXT NOT NULL,
                        chat_id TEXT NOT NULL UNIQUE,
                        active BOOLEAN DEFAULT TRUE,
                        created_at TIMESTAMP DEFAULT NOW()
                    )
                `)
            )
            .catch(error => {
                dbReady = null;
                throw error;
            });
    }

    return dbReady;
}

// ==========================================
// HELPERS
// ==========================================

function sha256(value) {
    return crypto
        .createHash("sha256")
        .update(String(value))
        .digest("hex");
}

function safeEqualHex(a, b) {
    if (!/^[a-f0-9]+$/i.test(String(a))) return false;
    if (!/^[a-f0-9]+$/i.test(String(b))) return false;

    const first = Buffer.from(String(a), "hex");
    const second = Buffer.from(String(b), "hex");

    return first.length === second.length &&
        first.length > 0 &&
        crypto.timingSafeEqual(first, second);
}

function safeEqualText(a, b) {
    const first = crypto
        .createHash("sha256")
        .update(String(a))
        .digest();

    const second = crypto
        .createHash("sha256")
        .update(String(b))
        .digest();

    return crypto.timingSafeEqual(first, second);
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function getClientIP(req) {
    return (
        req.headers["x-vercel-forwarded-for"] ||
        req.headers["x-real-ip"] ||
        req.socket.remoteAddress ||
        "unknown"
    ).toString().split(",")[0].trim();
}

function isAdmin(id) {
    return ADMIN_IDS.includes(String(id));
}

function hasValidStatusKey(req) {
    const key = req.headers["x-status-key"];

    return Boolean(WEBHOOK_SECRET) &&
        Boolean(key) &&
        safeEqualText(key, WEBHOOK_SECRET);
}

// The Mini App shows these checks one by one.
// ok: true = passed, false = failed, null = not checked.
function buildChecks(device, network, channels) {
    return [
        { id: "telegram", ok: true },
        { id: "device", ok: device },
        { id: "network", ok: network },
        { id: "channels", ok: channels }
    ];
}

// ==========================================
// TELEGRAM API
// ==========================================

async function telegram(method, data = {}) {
    if (!BOT_TOKEN) {
        throw new Error("BOT_TOKEN is missing.");
    }

    const response = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(data)
        }
    );

    const result = await response.json();

    if (!result.ok) {
        throw new Error(
            result.description || "Telegram API error."
        );
    }

    return result.result;
}

async function sendTelegramMessage(chatId, text, extra = {}) {
    return telegram("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        ...extra
    });
}

// ==========================================
// REQUIRED CHANNELS
// ==========================================

// Accepts: https://t.me/name, t.me/name, @name or name.
// Private channels (invite links) cannot be checked by link, so
// they need the channel ID that starts with -100 as well.
function parseChannel(linkRaw, chatIdRaw) {
    const link = String(linkRaw || "").trim();
    const chatId = String(chatIdRaw || "").trim();

    if (chatId) {
        if (!/^-100\d{5,}$/.test(chatId)) {
            return { error: "Channel ID must look like -1001234567890." };
        }

        if (!/^https?:\/\/(t|telegram)\.me\/\S+$/i.test(link)) {
            return { error: "Write the channel join link (https://t.me/...)." };
        }

        return { chatId, link };
    }

    const match = link.match(
        /^(?:https?:\/\/)?(?:(?:t|telegram)\.me\/)?@?([A-Za-z][A-Za-z0-9_]{3,31})\/?$/
    );

    if (!match) {
        return {
            error:
                "Use a public channel link like https://t.me/yourchannel. " +
                "Private invite links need the channel ID (-100...) too."
        };
    }

    return {
        chatId: "@" + match[1],
        link: "https://t.me/" + match[1]
    };
}

// true = joined, false = not joined, null = could not check
// (for example the bot is not an admin of that channel).
async function isMember(chatId, userId) {
    try {
        const member = await telegram("getChatMember", {
            chat_id: chatId,
            user_id: Number(userId)
        });

        if (["creator", "administrator", "member"].includes(member.status)) {
            return true;
        }

        return member.status === "restricted" && member.is_member === true;

    } catch (error) {
        console.error(
            "CHANNEL CHECK ERROR (" + chatId + "):",
            error.message
        );

        return null;
    }
}

async function getRequiredChannels() {
    const result = await pool.query(
        `
        SELECT id, title, link, chat_id
        FROM required_channels
        WHERE active = true
        ORDER BY id
        `
    );

    return result.rows;
}

// ==========================================
// BOT MESSAGES TO USERS
// Each function returns true when Telegram
// accepted the message, false otherwise.
// ==========================================

async function sendBanMessage(telegramId, reason) {
    try {
        await sendTelegramMessage(
            telegramId,
            `${E.ban} <b>You are banned</b>\n\n` +
            "Your account has been permanently blocked " +
            "by the administrator or by our security system.\n\n" +
            `${E.info} <b>Reason:</b> ${escapeHtml(reason)}`
        );

        return true;

    } catch (error) {
        console.error(
            "BAN MESSAGE ERROR (" + telegramId + "):",
            error.message
        );

        return false;
    }
}

async function sendUnbanMessage(telegramId) {
    try {
        await sendTelegramMessage(
            telegramId,
            `${E.ok} <b>Your account has been unbanned.</b>\n\n` +
            "Press the button below to verify again.",
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: "VERIFY",
                                web_app: { url: MINI_APP_URL }
                            }
                        ]
                    ]
                }
            }
        );

        return true;

    } catch (error) {
        console.error(
            "UNBAN MESSAGE ERROR (" + telegramId + "):",
            error.message
        );

        return false;
    }
}

// ==========================================
// SEND "SUCCESSFULLY VERIFIED" MESSAGE (ONCE)
// ==========================================

async function sendVerifiedMessage(telegramId, firstName) {
    // Atomic claim: only one request can flip false -> true,
    // so the message is never sent twice at the same time.
    const claim = await pool.query(
        `
        UPDATE fraud_users
        SET verification_message_sent = true
        WHERE telegram_id = $1
          AND verification_message_sent = false
        RETURNING telegram_id
        `,
        [telegramId]
    );

    if (claim.rowCount === 0) {
        return false;
    }

    try {
        await sendTelegramMessage(
            telegramId,
            `${E.party} ` +
            "<b>Successfully verified!</b>\n\n" +
            `Welcome, <b>${escapeHtml(firstName)}</b>. ` +
            "Your account has been verified.\n\n" +
            "Press the button below to continue.",
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: "Continue",
                                style: "success",
                                icon_custom_emoji_id: EMOJI_IDS.ok,
                                callback_data: "verified_ok"
                            }
                        ]
                    ]
                }
            }
        );

        return true;

    } catch (error) {
        console.error("VERIFIED MESSAGE ERROR:", error.message);

        // Allow a retry on the next verification
        await pool.query(
            `
            UPDATE fraud_users
            SET verification_message_sent = false
            WHERE telegram_id = $1
            `,
            [telegramId]
        ).catch(() => {});

        return false;
    }
}

// ==========================================
// ADMIN ACTIONS: BAN / UNBAN
// ==========================================

async function banUser(targetId, reason) {
    await pool.query(
        `
        INSERT INTO fraud_users (
            telegram_id,
            status,
            ban_reason,
            risk_score,
            ban_message_sent,
            whitelisted
        )
        VALUES ($1,'banned',$2,100,false,false)
        ON CONFLICT (telegram_id)
        DO UPDATE SET
            status = 'banned',
            ban_reason = EXCLUDED.ban_reason,
            risk_score = 100,
            ban_message_sent = false,
            whitelisted = false,
            last_seen = NOW()
        `,
        [targetId, reason]
    );

    const notified = await sendBanMessage(targetId, reason);

    if (notified) {
        await pool.query(
            `
            UPDATE fraud_users
            SET ban_message_sent = true
            WHERE telegram_id = $1
            `,
            [targetId]
        );
    }

    return {
        notified,
        message:
            `User ${targetId} has been banned.\n` +
            `Reason: ${reason}`
    };
}

async function unbanUser(targetId) {
    const result = await pool.query(
        `
        UPDATE fraud_users
        SET status = 'verified',
            ban_reason = NULL,
            vpn_detected = false,
            proxy_detected = false,
            risk_score = 0,
            ban_message_sent = false,
            whitelisted = true,
            last_seen = NOW()
        WHERE telegram_id = $1
        RETURNING first_name
        `,
        [targetId]
    );

    if (result.rowCount === 0) {
        return {
            found: false,
            notified: false,
            message: `User ${targetId} was not found.`
        };
    }

    const notified = await sendUnbanMessage(targetId);

    return {
        found: true,
        notified,
        message: `User ${targetId} has been unbanned.`
    };
}

// ==========================================
// VERIFY TELEGRAM MINI APP DATA
// ==========================================

function verifyTelegramInitData(initData) {
    if (!initData || !BOT_TOKEN) {
        throw new Error("Telegram authentication data is missing.");
    }

    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");

    if (!receivedHash) {
        throw new Error("Telegram hash is missing.");
    }

    params.delete("hash");

    const dataCheckString = Array.from(params.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");

    const secretKey = crypto
        .createHmac("sha256", "WebAppData")
        .update(BOT_TOKEN)
        .digest();

    const calculatedHash = crypto
        .createHmac("sha256", secretKey)
        .update(dataCheckString)
        .digest("hex");

    if (!safeEqualHex(calculatedHash, receivedHash)) {
        throw new Error("Invalid Telegram authentication data.");
    }

    const authDate = Number(params.get("auth_date"));

    if (
        !authDate ||
        authDate > Math.floor(Date.now() / 1000) + 60 ||
        Math.floor(Date.now() / 1000) - authDate > 3600
    ) {
        throw new Error("Telegram session expired. Open the bot again.");
    }

    const userString = params.get("user");

    if (!userString) {
        throw new Error("Telegram user data is missing.");
    }

    let user;

    try {
        user = JSON.parse(userString);
    } catch {
        throw new Error("Invalid Telegram user data.");
    }

    if (!user.id || !Number.isSafeInteger(user.id)) {
        throw new Error("Invalid Telegram user ID.");
    }

    return user;
}

// ==========================================
// VPN / PROXY DETECTION
// ==========================================

async function detectVPNProxy(ip) {
    const clean = {
        vpn: false,
        proxy: false,
        tor: false,
        hosting: false
    };

    try {
        const response = await fetch(
            `https://ipwho.is/${encodeURIComponent(ip)}`,
            { signal: AbortSignal.timeout(4000) }
        );

        if (!response.ok) return clean;

        const data = await response.json();

        if (!data || data.success === false) {
            return clean;
        }

        const security = data.security || {};

        return {
            vpn: Boolean(security.vpn),
            proxy: Boolean(security.proxy),
            tor: Boolean(security.tor),
            hosting: Boolean(security.hosting)
        };
    } catch (error) {
        console.error("IP detection error:", error.message);
        return clean;
    }
}

// ==========================================
// MULTIPLE ACCOUNT DETECTION
// ==========================================

async function detectMultiAccount(telegramId, deviceHash) {
    const result = await pool.query(
        `
        SELECT telegram_id
        FROM fraud_users
        WHERE status = 'verified'
          AND telegram_id <> $1
          AND device_hash = $2
        LIMIT 1
        `,
        [telegramId, deviceHash]
    );

    return result.rows.length > 0;
}

// ==========================================
// ROOT / HEALTH
// ==========================================

app.get("/", (req, res) => {
    res.json({
        ok: true,
        app: "Telegram Verification Mini App",
        status: "online",
        version: VERSION,
        database: Boolean(pool),
        mini_app: MINI_APP_URL
    });
});

app.get("/api/health", async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({
                ok: false,
                online: true,
                version: VERSION,
                database: false
            });
        }

        await pool.query("SELECT 1");

        return res.json({
            ok: true,
            online: true,
            version: VERSION,
            database: true
        });
    } catch (error) {
        return res.status(500).json({
            ok: false,
            online: true,
            version: VERSION,
            database: false
        });
    }
});

// ==========================================
// PREMIUM EMOJI FOR THE MINI APP PAGE
// GET /api/emoji/:id
// The bot token stays on the server. Animated
// emojis (.tgs) are unzipped into Lottie JSON.
// ==========================================

app.get("/api/emoji/:id", async (req, res) => {
    try {
        const id = String(req.params.id || "");

        if (!EMOJI_ALLOWED.has(id)) {
            return res.status(404).json({
                ok: false,
                error: "Emoji not allowed."
            });
        }

        let item = emojiCache.get(id);

        if (!item) {
            const stickers = await telegram(
                "getCustomEmojiStickers",
                { custom_emoji_ids: [id] }
            );

            const sticker = Array.isArray(stickers)
                ? stickers[0]
                : null;

            if (!sticker) {
                throw new Error("Emoji not found.");
            }

            const file = await telegram(
                "getFile",
                { file_id: sticker.file_id }
            );

            const download = await fetch(
                `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
            );

            if (!download.ok) {
                throw new Error("Emoji download failed.");
            }

            const buffer = Buffer.from(
                await download.arrayBuffer()
            );

            const path = String(file.file_path).toLowerCase();

            if (path.endsWith(".tgs")) {
                item = {
                    type: "application/json",
                    body: zlib.gunzipSync(buffer)
                };
            } else if (path.endsWith(".webm")) {
                item = {
                    type: "video/webm",
                    body: buffer
                };
            } else {
                item = {
                    type: "image/webp",
                    body: buffer
                };
            }

            emojiCache.set(id, item);
        }

        res.set("Content-Type", item.type);
        res.set("Cache-Control", "public, max-age=86400");

        return res.send(item.body);

    } catch (error) {
        console.error("EMOJI ERROR:", error.message);

        return res.status(502).json({
            ok: false,
            error: "Emoji could not be loaded."
        });
    }
});

// ==========================================
// MINI APP AUTH
// ==========================================

app.post("/api/auth", async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({
                ok: false,
                status: "error",
                message: "Database is not configured."
            });
        }

        await initDatabase();

        const initData = req.headers["x-init-data"];
        const deviceId = req.headers["x-device"];

        if (!initData || !deviceId) {
            return res.status(400).json({
                ok: false,
                status: "error",
                message: "Missing Telegram or device data."
            });
        }

        if (String(deviceId).length > 200) {
            return res.status(400).json({
                ok: false,
                status: "error",
                message: "Invalid device data."
            });
        }

        const telegramUser = verifyTelegramInitData(initData);

        const telegramId = String(telegramUser.id);
        const username = telegramUser.username || "";
        const firstName = telegramUser.first_name || "User";
        const userIsAdmin = isAdmin(telegramId);

        const ipHash = sha256(getClientIP(req));
        const deviceHash = sha256(deviceId);

        // Existing bans are checked first.
        const existing = await pool.query(
            `
            SELECT status, ban_reason, whitelisted, ban_message_sent
            FROM fraud_users
            WHERE telegram_id = $1
            `,
            [telegramId]
        );

        if (
            existing.rows.length > 0 &&
            existing.rows[0].status === "banned"
        ) {
            // If the ban message never reached the user,
            // try to deliver it now.
            if (existing.rows[0].ban_message_sent !== true) {
                const delivered = await sendBanMessage(
                    telegramId,
                    existing.rows[0].ban_reason || "Account banned."
                );

                if (delivered) {
                    await pool.query(
                        `
                        UPDATE fraud_users
                        SET ban_message_sent = true
                        WHERE telegram_id = $1
                        `,
                        [telegramId]
                    );
                }
            }

            return res.status(403).json({
                ok: false,
                status: "banned",
                message:
                    "Your account is permanently banned. Contact the administrator if you believe this is a mistake."
            });
        }

        const isWhitelisted =
            existing.rows.length > 0 &&
            existing.rows[0].whitelisted === true;

        let security = {
            vpn: false,
            proxy: false,
            tor: false,
            hosting: false
        };

        let multiAccount = false;

        if (!isWhitelisted) {
            [security, multiAccount] = await Promise.all([
                detectVPNProxy(getClientIP(req)),
                detectMultiAccount(telegramId, deviceHash)
            ]);
        }

        const vpnDetected = security.vpn || security.tor;
        const proxyDetected = security.proxy || security.hosting;

        // ==========================================
        // BAN: MULTIPLE ACCOUNTS / SECURITY RULES
        // ==========================================

        if (multiAccount || vpnDetected || proxyDetected) {
            let reason = "Security violation detected.";

            if (multiAccount) {
                reason = "Multiple accounts detected.";
            } else if (vpnDetected) {
                reason = "VPN/Tor usage detected.";
            } else if (proxyDetected) {
                reason = "Proxy/hosting connection detected.";
            }

            await pool.query(
                `
                INSERT INTO fraud_users (
                    telegram_id,
                    username,
                    first_name,
                    ip_hash,
                    device_hash,
                    vpn_detected,
                    proxy_detected,
                    risk_score,
                    status,
                    ban_reason,
                    ban_message_sent,
                    whitelisted,
                    last_seen
                )
                VALUES (
                    $1,$2,$3,$4,$5,$6,$7,100,
                    'banned',$8,false,false,NOW()
                )
                ON CONFLICT (telegram_id)
                DO UPDATE SET
                    username = EXCLUDED.username,
                    first_name = EXCLUDED.first_name,
                    ip_hash = EXCLUDED.ip_hash,
                    device_hash = EXCLUDED.device_hash,
                    vpn_detected = EXCLUDED.vpn_detected,
                    proxy_detected = EXCLUDED.proxy_detected,
                    risk_score = 100,
                    status = 'banned',
                    ban_reason = EXCLUDED.ban_reason,
                    ban_message_sent = false,
                    whitelisted = false,
                    last_seen = NOW()
                `,
                [
                    telegramId,
                    username,
                    firstName,
                    ipHash,
                    deviceHash,
                    vpnDetected,
                    proxyDetected,
                    reason
                ]
            );

            const delivered = await sendBanMessage(telegramId, reason);

            if (delivered) {
                await pool.query(
                    `
                    UPDATE fraud_users
                    SET ban_message_sent = true
                    WHERE telegram_id = $1
                    `,
                    [telegramId]
                );
            }

            return res.status(403).json({
                ok: false,
                status: "banned",
                message: multiAccount
                    ? "Multiple accounts detected. Your account is permanently banned."
                    : reason,
                checks: buildChecks(
                    !multiAccount,
                    !(vpnDetected || proxyDetected),
                    null
                )
            });
        }

        // ==========================================
        // REQUIRED CHANNELS
        // The user must join every channel the admin
        // added. Admins skip this step. If Telegram
        // cannot check a channel (the bot is not an
        // admin there) that channel is skipped.
        // ==========================================

        if (!userIsAdmin) {
            const channels = await getRequiredChannels();

            if (channels.length > 0) {
                const results = await Promise.all(
                    channels.map(channel =>
                        isMember(channel.chat_id, telegramId)
                    )
                );

                const list = channels.map((channel, index) => ({
                    title: channel.title,
                    link: channel.link,
                    joined: results[index] !== false
                }));

                if (list.some(channel => !channel.joined)) {
                    return res.json({
                        ok: false,
                        status: "join",
                        message:
                            "Join all the channels below, then press the check button.",
                        channels: list,
                        checks: buildChecks(true, true, false)
                    });
                }
            }
        }

        // ==========================================
        // SAVE VERIFIED USER
        // ==========================================

        await pool.query(
            `
            INSERT INTO fraud_users (
                telegram_id,
                username,
                first_name,
                ip_hash,
                device_hash,
                vpn_detected,
                proxy_detected,
                risk_score,
                status,
                verification_message_sent,
                last_seen,
                request_count
            )
            VALUES (
                $1,$2,$3,$4,$5,false,false,0,
                'verified',false,NOW(),1
            )
            ON CONFLICT (telegram_id)
            DO UPDATE SET
                username = EXCLUDED.username,
                first_name = EXCLUDED.first_name,
                ip_hash = EXCLUDED.ip_hash,
                device_hash = EXCLUDED.device_hash,
                vpn_detected = false,
                proxy_detected = false,
                risk_score = 0,
                status = 'verified',
                last_seen = NOW(),
                request_count = fraud_users.request_count + 1
            `,
            [
                telegramId,
                username,
                firstName,
                ipHash,
                deviceHash
            ]
        );

        // ==========================================
        // SEND SUCCESS MESSAGE DIRECTLY IN THE BOT
        // (flag reset first, so the Continue button
        //  is sent every time the Mini App completes)
        // ==========================================

        await pool.query(
            `
            UPDATE fraud_users
            SET verification_message_sent = false
            WHERE telegram_id = $1
            `,
            [telegramId]
        );

        const messageSent = await sendVerifiedMessage(
            telegramId,
            firstName
        );

        return res.json({
            ok: true,
            status: "verified",
            message: "Verification finished!",
            telegram_id: telegramId,
            message_sent: messageSent,
            is_admin: userIsAdmin,
            checks: buildChecks(true, true, true)
        });

    } catch (error) {
        console.error("AUTH ERROR:", error.message);

        return res.status(500).json({
            ok: false,
            status: "error",
            message: "Verification could not be completed. Please try again."
        });
    }
});

// ==========================================
// REQUIRED CHANNELS: ADMIN PANEL (inside the Mini App)
// POST /api/channels
// Headers: x-init-data (must belong to an admin)
// Body: { action: "list" }
//       { action: "add", title, link, chat_id? }
//       { action: "delete", id }
// ==========================================

app.post("/api/channels", async (req, res) => {
    let user;

    try {
        user = verifyTelegramInitData(req.headers["x-init-data"]);
    } catch (error) {
        return res.status(401).json({
            ok: false,
            message: error.message
        });
    }

    try {
        if (!isAdmin(user.id)) {
            return res.status(403).json({
                ok: false,
                message: "Admins only."
            });
        }

        if (!pool) {
            return res.status(500).json({
                ok: false,
                message: "Database is not configured."
            });
        }

        await initDatabase();

        const body = req.body || {};
        const action = String(body.action || "list");

        if (action === "add") {
            const title = String(body.title || "").trim().slice(0, 60);

            if (!title) {
                return res.status(400).json({
                    ok: false,
                    message: "Write a title for the channel."
                });
            }

            const parsed = parseChannel(body.link, body.chat_id);

            if (parsed.error) {
                return res.status(400).json({
                    ok: false,
                    message: parsed.error
                });
            }

            const count = await pool.query(
                "SELECT count(*)::int AS n FROM required_channels WHERE active = true"
            );

            if (count.rows[0].n >= MAX_CHANNELS) {
                return res.status(400).json({
                    ok: false,
                    message: `You can add up to ${MAX_CHANNELS} channels.`
                });
            }

            const duplicate = await pool.query(
                "SELECT 1 FROM required_channels WHERE chat_id = $1",
                [parsed.chatId]
            );

            if (duplicate.rowCount > 0) {
                return res.status(400).json({
                    ok: false,
                    message: "This channel is already added."
                });
            }

            // The bot must be an admin of the channel,
            // otherwise Telegram will not tell it who joined.
            try {
                const me = await telegram("getMe");

                const member = await telegram("getChatMember", {
                    chat_id: parsed.chatId,
                    user_id: me.id
                });

                if (!["administrator", "creator"].includes(member.status)) {
                    return res.status(400).json({
                        ok: false,
                        message:
                            "Make the bot an ADMIN of this channel first, then add it again."
                    });
                }
            } catch (error) {
                return res.status(400).json({
                    ok: false,
                    message:
                        "Telegram says: " + error.message +
                        ". Add the bot as an admin of the channel first."
                });
            }

            await pool.query(
                `
                INSERT INTO required_channels (title, link, chat_id)
                VALUES ($1, $2, $3)
                `,
                [title, parsed.link, parsed.chatId]
            );
        }

        if (action === "delete") {
            await pool.query(
                "DELETE FROM required_channels WHERE id = $1",
                [Number(body.id) || 0]
            );
        }

        const list = await pool.query(
            `
            SELECT id, title, link, chat_id
            FROM required_channels
            WHERE active = true
            ORDER BY id
            `
        );

        return res.json({
            ok: true,
            channels: list.rows
        });

    } catch (error) {
        console.error("CHANNELS ERROR:", error.message);

        return res.status(500).json({
            ok: false,
            message: "Server error. Please try again."
        });
    }
});

// ==========================================
// SELF UNBAN (the "Yes" button in the Mini App)
// POST /api/unban-self
// Headers: x-init-data
// Only AUTOMATIC bans (VPN, proxy, multiple
// accounts) can be removed here. Admin bans
// cannot. Verification runs again afterwards,
// so cheaters are banned again right away.
// ==========================================

app.post("/api/unban-self", async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({
                ok: false,
                status: "error",
                message: "Database is not configured."
            });
        }

        await initDatabase();

        const initData = req.headers["x-init-data"];

        if (!initData) {
            return res.status(400).json({
                ok: false,
                status: "error",
                message: "Missing Telegram data."
            });
        }

        const telegramUser = verifyTelegramInitData(initData);
        const telegramId = String(telegramUser.id);

        const existing = await pool.query(
            `
            SELECT status, ban_reason
            FROM fraud_users
            WHERE telegram_id = $1
            `,
            [telegramId]
        );

        if (
            existing.rows.length === 0 ||
            existing.rows[0].status !== "banned"
        ) {
            return res.json({
                ok: true,
                status: "not_banned",
                message: "Your account is not banned."
            });
        }

        const reason = existing.rows[0].ban_reason || "";

        if (!AUTO_BAN_REASONS.includes(reason)) {
            return res.status(403).json({
                ok: false,
                status: "admin_ban",
                message:
                    "This ban was set by an administrator. Please contact the administrator."
            });
        }

        // whitelisted = false, so the security checks
        // (VPN, proxy, multiple accounts) run again.
        await pool.query(
            `
            UPDATE fraud_users
            SET status = 'verified',
                ban_reason = NULL,
                vpn_detected = false,
                proxy_detected = false,
                risk_score = 0,
                ban_message_sent = false,
                whitelisted = false,
                last_seen = NOW()
            WHERE telegram_id = $1
            `,
            [telegramId]
        );

        return res.json({
            ok: true,
            status: "unbanned",
            message: "You have been unbanned."
        });

    } catch (error) {
        console.error("UNBAN SELF ERROR:", error.message);

        return res.status(500).json({
            ok: false,
            status: "error",
            message: "Could not unban you. Please try again."
        });
    }
});

// ==========================================
// STATUS API FOR TELEBOT CREATOR
// GET /api/status?id=USER_ID
// Header: x-status-key
// ==========================================

app.get("/api/status", async (req, res) => {
    try {
        if (!hasValidStatusKey(req)) {
            return res.status(403).json({
                ok: false,
                status: "forbidden"
            });
        }

        const id = String(req.query.id || "");

        if (!/^\d+$/.test(id)) {
            return res.status(400).json({
                ok: false,
                status: "error"
            });
        }

        if (!pool) {
            return res.status(500).json({
                ok: false,
                status: "error"
            });
        }

        await initDatabase();

        const result = await pool.query(
            `
            SELECT status, ban_reason
            FROM fraud_users
            WHERE telegram_id = $1
            `,
            [id]
        );

        if (result.rows.length === 0) {
            return res.json({
                ok: true,
                status: "unknown"
            });
        }

        const row = result.rows[0];

        if (row.status === "banned") {
            return res.json({
                ok: true,
                status: "banned",
                reason: row.ban_reason || "Account banned."
            });
        }

        return res.json({
            ok: true,
            status: "verified"
        });

    } catch (error) {
        console.error("STATUS ERROR:", error.message);

        return res.status(500).json({
            ok: false,
            status: "error"
        });
    }
});

// ==========================================
// ADMIN API FOR TELEBOT CREATOR (/ban, /unban)
// GET /api/admin?action=ban|unban&admin=CALLER_ID&target=USER_ID&reason=...
// Header: x-status-key
// Response includes "notified": true/false
// (whether the user received the Telegram message)
// ==========================================

app.get("/api/admin", async (req, res) => {
    try {
        if (!hasValidStatusKey(req)) {
            return res.status(403).json({
                ok: false,
                status: "forbidden",
                message: "Forbidden."
            });
        }

        const caller = String(req.query.admin || "");

        if (!isAdmin(caller)) {
            return res.json({
                ok: false,
                status: "not_admin",
                message: "Not authorized."
            });
        }

        const action = String(req.query.action || "");
        const target = String(req.query.target || "");

        if (action !== "ban" && action !== "unban") {
            return res.status(400).json({
                ok: false,
                status: "error",
                message: "Invalid action."
            });
        }

        if (!/^\d+$/.test(target)) {
            return res.status(400).json({
                ok: false,
                status: "error",
                message: "Invalid user ID."
            });
        }

        if (isAdmin(target)) {
            return res.json({
                ok: false,
                status: "error",
                message: "You cannot ban an admin."
            });
        }

        if (!pool) {
            return res.status(500).json({
                ok: false,
                status: "error",
                message: "Database is not configured."
            });
        }

        await initDatabase();

        if (action === "ban") {
            const reason =
                String(req.query.reason || "").trim().slice(0, 200) ||
                "Banned by admin.";

            const result = await banUser(target, reason);

            return res.json({
                ok: true,
                status: "banned",
                notified: result.notified,
                message: result.message
            });
        }

        const result = await unbanUser(target);

        return res.json({
            ok: result.found,
            status: result.found ? "unbanned" : "not_found",
            notified: result.notified,
            message: result.message
        });

    } catch (error) {
        console.error("ADMIN ERROR:", error.message);

        return res.status(500).json({
            ok: false,
            status: "error",
            message: "Server error. Please try again."
        });
    }
});

// ==========================================
// 404
// ==========================================

app.use((req, res) => {
    res.status(404).json({
        ok: false,
        error: "Route not found."
    });
});

// ==========================================
// VERCEL / LOCAL
// ==========================================

module.exports = app;

if (require.main === module) {
    const port = process.env.PORT || 3000;

    app.listen(port, () => {
        console.log(`Backend running on port ${port}`);
    });
}
