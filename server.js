// Rewards Mini App backend + verification/ban guard (Express API). Deploy on Vercel, DB on Neon.
// The bot itself (/start, ads) is built in Telebot Creator - this server does NOT set a webhook.
// Mini app page is served from public/index.html (included via vercel.json includeFiles).
// ENV (rewards): DATABASE_URL, BOT_TOKEN, BOT_USERNAME (without @), APP_URL, ADMIN_IDS (comma separated Telegram IDs), BOT_SECRET, OWNER_USERNAME (optional)
// ENV (verification): WEBHOOK_SECRET (key sent in x-status-key), ADMIN_ID (extra admin for /api/admin), MINI_APP_URL (optional),
//                     VERIFY_BOT_TOKEN (optional, only if the verification mini app belongs to a different bot), ALLOWED_ORIGIN (optional)
const express = require('express'), crypto = require('crypto'), path = require('path'), fs = require('fs'), { Pool } = require('pg');
const app = express();
app.use(express.json({ limit: '6mb' }));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
const q = (t, p) => pool.query(t, p);
const BOT = process.env.BOT_TOKEN;
const OWNER = (process.env.OWNER_USERNAME || 'abdu_your_owner').replace(/^@/, '');
const BOT_SECRET = process.env.BOT_SECRET || '';
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const ADMINS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const tg = (m, b) => fetch(`https://api.telegram.org/bot${BOT}/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()).catch(() => ({}));
const wrap = f => (req, res) => f(req, res).catch(e => res.status(500).json({ error: e.message }));
const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id BIGINT PRIMARY KEY, name TEXT, username TEXT, points INT NOT NULL DEFAULT 0, invited_by BIGINT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS images(id SERIAL PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ad_views(token TEXT PRIMARY KEY, user_id BIGINT, ad_id INT, started TIMESTAMPTZ DEFAULT now(), done BOOL DEFAULT false);
CREATE TABLE IF NOT EXISTS rewards(id SERIAL PRIMARY KEY, title TEXT, body TEXT, image_id INT, cost INT, active BOOL DEFAULT true);
ALTER TABLE rewards ADD COLUMN IF NOT EXISTS min_invites INT NOT NULL DEFAULT 0;
ALTER TABLE ad_views ADD COLUMN IF NOT EXISTS confirmed BOOL NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS claims(id SERIAL PRIMARY KEY, user_id BIGINT, reward_id INT, title TEXT, cost INT, status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS tasks(id SERIAL PRIMARY KEY, type TEXT, title TEXT, body TEXT, image_id INT, channel TEXT, link TEXT, points INT, active BOOL DEFAULT true);
CREATE TABLE IF NOT EXISTS task_done(user_id BIGINT, task_id INT, PRIMARY KEY(user_id, task_id));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS fraud_users(telegram_id BIGINT PRIMARY KEY, username TEXT, first_name TEXT, ip_hash TEXT, device_hash TEXT, vpn_detected BOOLEAN DEFAULT FALSE, proxy_detected BOOLEAN DEFAULT FALSE, risk_score INTEGER DEFAULT 0, status TEXT DEFAULT 'verified', ban_reason TEXT, verification_message_sent BOOLEAN DEFAULT FALSE, ban_message_sent BOOLEAN DEFAULT FALSE, first_seen TIMESTAMP DEFAULT NOW(), last_seen TIMESTAMP DEFAULT NOW(), request_count INTEGER DEFAULT 0, whitelisted BOOLEAN DEFAULT FALSE);
ALTER TABLE fraud_users ADD COLUMN IF NOT EXISTS whitelisted BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS fraud_users_device_idx ON fraud_users(device_hash);`;
let ready; const init = () => ready || (ready = q(SCHEMA).catch(e => { ready = null; throw e; }));
app.use((req, res, next) => init().then(() => next(), next));

const DEF = { ad_seconds: 5, invite_points: 5, daily_ad_limit: 100, ad_confirm: 1 };
const settings = async () => { const s = { ...DEF }; (await q('SELECT * FROM settings')).rows.forEach(r => s[r.key] = Number(r.value)); return s; };

// ======================================================================
// VERIFICATION / BAN GUARD (GitHub Pages mini app + Telebot Creator)
// ======================================================================
const VBOT = process.env.VERIFY_BOT_TOKEN || BOT;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://abdulselamahemade608-prog.github.io';
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://abdulselamahemade608-prog.github.io/Telebot/';

// CORS only for the endpoints the GitHub Pages app calls from the browser
app.use(['/api/auth', '/api/health'], (req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,x-init-data,x-device,x-status-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const safeEqualHex = (a, b) => {
  if (!/^[a-f0-9]+$/i.test(String(a)) || !/^[a-f0-9]+$/i.test(String(b))) return false;
  const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
const safeEqualText = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const escapeHtml = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const getClientIP = req => (req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
const isGuardAdmin = id => [process.env.ADMIN_ID, ...ADMINS].filter(Boolean).map(String).includes(String(id));
const hasValidStatusKey = req => { const k = req.headers['x-status-key']; return Boolean(WEBHOOK_SECRET) && Boolean(k) && safeEqualText(k, WEBHOOK_SECRET); };

async function vtg(method, data = {}) {
  if (!VBOT) throw new Error('BOT_TOKEN is missing.');
  const r = await (await fetch(`https://api.telegram.org/bot${VBOT}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).json();
  if (!r.ok) throw new Error(r.description || 'Telegram API error.');
  return r.result;
}
const sendHtml = (chatId, text, extra = {}) => vtg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

async function sendBanMessage(id, reason) {
  try {
    await sendHtml(id, '🚫 <b>Account Permanently Banned</b>\n\nYour account has been blocked because multiple accounts or a policy violation was detected.\n\n' + `Reason: ${escapeHtml(reason)}`);
  } catch (e) { console.error('BAN MESSAGE ERROR:', e.message); }
}
async function sendUnbanMessage(id) {
  try {
    await sendHtml(id, '✅ <b>Your account has been unbanned.</b>\n\nPress the button below to verify again.', { reply_markup: { inline_keyboard: [[{ text: 'VERIFY', web_app: { url: MINI_APP_URL } }]] } });
  } catch (e) { console.error('UNBAN MESSAGE ERROR:', e.message); }
}
// "Successfully verified" message, sent only once per user (atomic false -> true flip)
async function sendVerifiedMessage(id, firstName) {
  const claim = await q('UPDATE fraud_users SET verification_message_sent=true WHERE telegram_id=$1 AND verification_message_sent=false RETURNING telegram_id', [id]);
  if (!claim.rowCount) return false;
  try {
    await sendHtml(id, '✅ <b>Successfully verified!</b>\n\n' + `Welcome, <b>${escapeHtml(firstName)}</b>. ` + 'Your account has been verified.\n\nPress the button below to continue.',
      { reply_markup: { inline_keyboard: [[{ text: 'Continue', callback_data: 'verified_ok' }]] } });
    return true;
  } catch (e) {
    console.error('VERIFIED MESSAGE ERROR:', e.message);
    await q('UPDATE fraud_users SET verification_message_sent=false WHERE telegram_id=$1', [id]).catch(() => {});
    return false;
  }
}
async function banUser(targetId, reason) {
  await q(`INSERT INTO fraud_users(telegram_id,status,ban_reason,risk_score,ban_message_sent,whitelisted) VALUES($1,'banned',$2,100,true,false)
    ON CONFLICT(telegram_id) DO UPDATE SET status='banned', ban_reason=EXCLUDED.ban_reason, risk_score=100, ban_message_sent=true, whitelisted=false, last_seen=NOW()`, [targetId, reason]);
  await sendBanMessage(targetId, reason);
  return `User ${targetId} has been banned.\nReason: ${reason}`;
}
async function unbanUser(targetId) {
  const r = await q(`UPDATE fraud_users SET status='verified', ban_reason=NULL, vpn_detected=false, proxy_detected=false, risk_score=0, ban_message_sent=false, whitelisted=true, last_seen=NOW() WHERE telegram_id=$1 RETURNING first_name`, [targetId]);
  if (!r.rowCount) return { found: false, message: `User ${targetId} was not found.` };
  await sendUnbanMessage(targetId);
  return { found: true, message: `User ${targetId} has been unbanned.` };
}

// initData check for the verification mini app (uses VERIFY_BOT_TOKEN or BOT_TOKEN, 1 hour expiry)
function verifyTelegramInitData(initData) {
  if (!initData || !VBOT) throw new Error('Telegram authentication data is missing.');
  const params = new URLSearchParams(initData), receivedHash = params.get('hash');
  if (!receivedHash) throw new Error('Telegram hash is missing.');
  params.delete('hash');
  const str = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(VBOT).digest();
  if (!safeEqualHex(crypto.createHmac('sha256', secret).update(str).digest('hex'), receivedHash)) throw new Error('Invalid Telegram authentication data.');
  const authDate = Number(params.get('auth_date')), now = Math.floor(Date.now() / 1000);
  if (!authDate || authDate > now + 60 || now - authDate > 3600) throw new Error('Telegram session expired. Open the bot again.');
  const us = params.get('user');
  if (!us) throw new Error('Telegram user data is missing.');
  let user; try { user = JSON.parse(us); } catch { throw new Error('Invalid Telegram user data.'); }
  if (!user.id || !Number.isSafeInteger(user.id)) throw new Error('Invalid Telegram user ID.');
  return user;
}
async function detectVPNProxy(ip) {
  const clean = { vpn: false, proxy: false, tor: false, hosting: false };
  try {
    const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return clean;
    const d = await r.json();
    if (!d || d.success === false) return clean;
    const s = d.security || {};
    return { vpn: Boolean(s.vpn), proxy: Boolean(s.proxy), tor: Boolean(s.tor), hosting: Boolean(s.hosting) };
  } catch (e) { console.error('IP detection error:', e.message); return clean; }
}
async function detectMultiAccount(telegramId, deviceHash) {
  const r = await q("SELECT telegram_id FROM fraud_users WHERE status='verified' AND telegram_id<>$1 AND device_hash=$2 LIMIT 1", [telegramId, deviceHash]);
  return r.rows.length > 0;
}

app.get('/api/health', async (req, res) => {
  try { await q('SELECT 1'); res.json({ ok: true, online: true, database: true }); }
  catch (e) { res.status(500).json({ ok: false, online: true, database: false }); }
});

app.post('/api/auth', async (req, res) => {
  try {
    const initData = req.headers['x-init-data'], deviceId = req.headers['x-device'];
    if (!initData || !deviceId) return res.status(400).json({ ok: false, status: 'error', message: 'Missing Telegram or device data.' });
    if (String(deviceId).length > 200) return res.status(400).json({ ok: false, status: 'error', message: 'Invalid device data.' });
    const tu = verifyTelegramInitData(initData);
    const telegramId = String(tu.id), username = tu.username || '', firstName = tu.first_name || 'User';
    const ipHash = sha256(getClientIP(req)), deviceHash = sha256(deviceId);

    const existing = await q('SELECT status, ban_reason, whitelisted FROM fraud_users WHERE telegram_id=$1', [telegramId]);
    if (existing.rows.length && existing.rows[0].status === 'banned')
      return res.status(403).json({ ok: false, status: 'banned', message: 'Your account is permanently banned. Contact the administrator if you believe this is a mistake.' });
    const isWhitelisted = existing.rows.length > 0 && existing.rows[0].whitelisted === true;

    let security = { vpn: false, proxy: false, tor: false, hosting: false }, multiAccount = false;
    if (!isWhitelisted) [security, multiAccount] = await Promise.all([detectVPNProxy(getClientIP(req)), detectMultiAccount(telegramId, deviceHash)]);
    const vpnDetected = security.vpn || security.tor, proxyDetected = security.proxy || security.hosting;

    if (multiAccount || vpnDetected || proxyDetected) {
      let reason = 'Security violation detected.';
      if (multiAccount) reason = 'Multiple accounts detected.';
      else if (vpnDetected) reason = 'VPN/Tor usage detected.';
      else if (proxyDetected) reason = 'Proxy/hosting connection detected.';
      await q(`INSERT INTO fraud_users(telegram_id,username,first_name,ip_hash,device_hash,vpn_detected,proxy_detected,risk_score,status,ban_reason,ban_message_sent,whitelisted,last_seen)
        VALUES($1,$2,$3,$4,$5,$6,$7,100,'banned',$8,true,false,NOW())
        ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username, first_name=EXCLUDED.first_name, ip_hash=EXCLUDED.ip_hash, device_hash=EXCLUDED.device_hash,
          vpn_detected=EXCLUDED.vpn_detected, proxy_detected=EXCLUDED.proxy_detected, risk_score=100, status='banned', ban_reason=EXCLUDED.ban_reason,
          ban_message_sent=true, whitelisted=false, last_seen=NOW()`,
        [telegramId, username, firstName, ipHash, deviceHash, vpnDetected, proxyDetected, reason]);
      await sendBanMessage(telegramId, reason);
      return res.status(403).json({ ok: false, status: 'banned', message: multiAccount ? 'Multiple accounts detected. Your account is permanently banned.' : reason });
    }

    await q(`INSERT INTO fraud_users(telegram_id,username,first_name,ip_hash,device_hash,vpn_detected,proxy_detected,risk_score,status,verification_message_sent,last_seen,request_count)
      VALUES($1,$2,$3,$4,$5,false,false,0,'verified',false,NOW(),1)
      ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username, first_name=EXCLUDED.first_name, ip_hash=EXCLUDED.ip_hash, device_hash=EXCLUDED.device_hash,
        vpn_detected=false, proxy_detected=false, risk_score=0, status='verified', last_seen=NOW(), request_count=fraud_users.request_count+1`,
      [telegramId, username, firstName, ipHash, deviceHash]);
    const messageSent = await sendVerifiedMessage(telegramId, firstName);
    res.json({ ok: true, status: 'verified', message: 'Verification finished!', telegram_id: telegramId, message_sent: messageSent });
  } catch (e) {
    console.error('AUTH ERROR:', e.message);
    res.status(500).json({ ok: false, status: 'error', message: 'Verification could not be completed. Please try again.' });
  }
});

// GET /api/status?id=USER_ID  (header x-status-key) - used by Telebot Creator
app.get('/api/status', async (req, res) => {
  try {
    if (!hasValidStatusKey(req)) return res.status(403).json({ ok: false, status: 'forbidden' });
    const id = String(req.query.id || '');
    if (!/^\d+$/.test(id)) return res.status(400).json({ ok: false, status: 'error' });
    const r = await q('SELECT status, ban_reason FROM fraud_users WHERE telegram_id=$1', [id]);
    if (!r.rows.length) return res.json({ ok: true, status: 'unknown' });
    const row = r.rows[0];
    if (row.status === 'banned') return res.json({ ok: true, status: 'banned', reason: row.ban_reason || 'Account banned.' });
    res.json({ ok: true, status: 'verified' });
  } catch (e) { console.error('STATUS ERROR:', e.message); res.status(500).json({ ok: false, status: 'error' }); }
});

// GET /api/admin?action=ban|unban&admin=CALLER_ID&target=USER_ID&reason=...  (header x-status-key) - /ban and /unban in Telebot Creator
app.get('/api/admin', async (req, res) => {
  try {
    if (!hasValidStatusKey(req)) return res.status(403).json({ ok: false, status: 'forbidden', message: 'Forbidden.' });
    if (!isGuardAdmin(String(req.query.admin || ''))) return res.json({ ok: false, status: 'not_admin', message: 'Not authorized.' });
    const action = String(req.query.action || ''), target = String(req.query.target || '');
    if (action !== 'ban' && action !== 'unban') return res.status(400).json({ ok: false, status: 'error', message: 'Invalid action.' });
    if (!/^\d+$/.test(target)) return res.status(400).json({ ok: false, status: 'error', message: 'Invalid user ID.' });
    if (action === 'ban') {
      const reason = String(req.query.reason || '').trim().slice(0, 200) || 'Banned by admin.';
      return res.json({ ok: true, status: 'banned', message: await banUser(target, reason) });
    }
    const r = await unbanUser(target);
    res.json({ ok: r.found, status: r.found ? 'unbanned' : 'not_found', message: r.message });
  } catch (e) { console.error('ADMIN ERROR:', e.message); res.status(500).json({ ok: false, status: 'error', message: 'Server error. Please try again.' }); }
});

// ======================================================================
// REWARDS APP
// ======================================================================
// ---- Telegram initData verification ----
function verify(initData) {
  if (!initData) return null;
  const p = new URLSearchParams(initData), hash = p.get('hash'); p.delete('hash');
  const str = [...p].map(([k, v]) => k + '=' + v).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
  if (crypto.createHmac('sha256', key).update(str).digest('hex') !== hash) return null;
  return JSON.parse(p.get('user'));
}
// Creates/updates a user. If the user is new and came from an invite link, the inviter gets points. Used by the app AND by the bot (Telebot Creator).
async function touchUser(id, name, username, ref) {
  const ins = await q("INSERT INTO users(id,name,username) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=COALESCE(NULLIF($2,''),users.name), username=COALESCE($3,users.username) RETURNING (xmax=0) AS fresh", [id, name || '', username || null]);
  const fresh = ins.rows[0].fresh;
  if (fresh && ref && ref !== id) {
    const inv = await q('SELECT 1 FROM users WHERE id=$1', [ref]);
    if (inv.rowCount) {
      await q('UPDATE users SET invited_by=$1 WHERE id=$2', [ref, id]);
      const s = await settings();
      await q('UPDATE users SET points=points+$1 WHERE id=$2', [s.invite_points, ref]);
      tg('sendMessage', { chat_id: ref, text: `${name || 'Someone'} joined with your link. +${s.invite_points} points!` });
    }
  }
  return fresh;
}
const auth = async (req, res, next) => {
  try {
    const u = verify(req.headers['x-init']);
    if (!u) return fail(res, 'Open this app from Telegram', 401);
    // banned users (see verification guard above) cannot use the rewards app
    const banned = await q("SELECT 1 FROM fraud_users WHERE telegram_id=$1 AND status='banned'", [u.id]);
    if (banned.rowCount) return fail(res, 'Your account is banned.', 403);
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
    await touchUser(u.id, name, u.username, Number(req.headers['x-ref']) || 0);
    req.u = u; req.admin = ADMINS.includes(String(u.id)); next();
  } catch (e) { fail(res, e.message, 500); }
};
const adminOnly = (req, res, next) => req.admin ? next() : fail(res, 'Admins only', 403);

// ---- Public ----
app.get('/img/:id', wrap(async (req, res) => {
  const r = await q('SELECT data FROM images WHERE id=$1', [Number(req.params.id) || 0]);
  if (!r.rowCount) return res.status(404).end();
  res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'public,max-age=31536000').send(Buffer.from(r.rows[0].data, 'base64'));
}));

// ---- User API ----
const AD_WINDOW = "30 minutes";
const invitesOf = async id => Number((await q('SELECT count(*) FROM users WHERE invited_by=$1', [id])).rows[0].count);
const adsToday = async id => Number((await q("SELECT count(*) FROM ad_views WHERE user_id=$1 AND done AND started>now()-interval '24 hours'", [id])).rows[0].count);

app.get('/api/home', auth, wrap(async (req, res) => {
  const s = await settings();
  const [me, rewards, tasks, inv, today, pend, topP, topI] = await Promise.all([
    q('SELECT points FROM users WHERE id=$1', [req.u.id]),
    q('SELECT id,title,body,image_id,cost,min_invites FROM rewards WHERE active ORDER BY cost'),
    q('SELECT t.id,t.type,t.title,t.body,t.image_id,t.channel,t.link,t.points,(d.user_id IS NOT NULL) AS done FROM tasks t LEFT JOIN task_done d ON d.task_id=t.id AND d.user_id=$1 WHERE t.active ORDER BY t.id DESC', [req.u.id]),
    invitesOf(req.u.id), adsToday(req.u.id),
    q(`SELECT 1 FROM ad_views WHERE user_id=$1 AND NOT done AND started>now()-interval '${AD_WINDOW}' LIMIT 1`, [req.u.id]),
    q('SELECT id,name,points FROM users WHERE points>0 ORDER BY points DESC, id LIMIT 10'),
    q('SELECT u.id,u.name,count(*)::int AS invites FROM users u JOIN users i ON i.invited_by=u.id GROUP BY u.id,u.name ORDER BY invites DESC, u.id LIMIT 10')]);
  res.json({ top_points: topP.rows, top_invites: topI.rows, me: req.u.id, admin: req.admin, bot: process.env.BOT_USERNAME, owner: OWNER, points: me.rows[0].points, invites: inv, rewards: rewards.rows, tasks: tasks.rows,
    invite_points: s.invite_points, ad_limit: s.daily_ad_limit, ads_today: today, ad_pending: pend.rowCount > 0 });
}));

app.get('/api/profile', auth, wrap(async (req, res) => {
  const id = req.u.id;
  const [u, inv, today, total, tdone, claims, rp] = await Promise.all([
    q('SELECT u.id,u.name,u.username,u.points,u.created_at,i.name AS invited_by_name FROM users u LEFT JOIN users i ON i.id=u.invited_by WHERE u.id=$1', [id]),
    invitesOf(id), adsToday(id),
    q('SELECT count(*) FROM ad_views WHERE user_id=$1 AND done', [id]),
    q('SELECT count(*) FROM task_done WHERE user_id=$1', [id]),
    q('SELECT title,cost,status,created_at FROM claims WHERE user_id=$1 ORDER BY id DESC LIMIT 10', [id]),
    q('SELECT count(*)+1 AS r FROM users WHERE points > (SELECT points FROM users WHERE id=$1)', [id])]);
  const ri = await q('SELECT count(*)+1 AS r FROM (SELECT invited_by FROM users WHERE invited_by IS NOT NULL GROUP BY invited_by HAVING count(*) > $1) t', [inv]);
  res.json({ ...u.rows[0], invites: inv, ads_today: today, ads_total: Number(total.rows[0].count), tasks_done: Number(tdone.rows[0].count),
    claims: claims.rows, rank_points: Number(rp.rows[0].r), rank_invites: Number(ri.rows[0].r) });
}));

// ---- Bot (Telebot Creator) API: protected by the BOT_SECRET env variable. Send it in header x-bot-key (or ?key=). ----
const botAuth = (req, res, next) => {
  const k = req.headers['x-bot-key'] || req.query.key || '';
  if (!BOT_SECRET || !same(k, BOT_SECRET)) return fail(res, 'Forbidden', 403);
  next();
};
const botData = req => ({ ...req.query, ...(req.body || {}) });
// Called by the bot's /start: registers the user and credits the inviter (ref = inviter's Telegram ID, "ref_123" also works).
app.all('/api/bot/start', botAuth, wrap(async (req, res) => {
  const b = botData(req), id = Number(b.user_id);
  if (!id) return fail(res, 'user_id is required');
  const fresh = await touchUser(id, String(b.name || ''), b.username || null, Number(String(b.ref || '').replace('ref_', '')) || 0);
  res.json({ ok: true, fresh });
}));
// Called by the bot when the user finished the ad in Telebot Creator.
app.all('/api/bot/ad', botAuth, wrap(async (req, res) => {
  const b = botData(req), id = Number(b.user_id), token = String(b.token || '').replace(/^ad_/, '');
  if (!id || !token) return fail(res, 'user_id and token are required');
  // The token was created for this exact user when they tapped "Watch an ad", so it cannot be confirmed for someone else or reused.
  const r = await q(`UPDATE ad_views SET confirmed=true WHERE token=$2 AND user_id=$1 AND NOT done AND started>now()-interval '${AD_WINDOW}' RETURNING 1`, [id, token]);
  res.json({ ok: true, found: r.rowCount > 0 });
}));

// Ads are shown by the Telebot Creator bot. The app only opens the bot link (start=ad), the bot runs its ads command,
// then the user returns and collects the point after the minimum watch time.
app.post('/api/ad/start', auth, wrap(async (req, res) => {
  const s = await settings();
  if (!process.env.BOT_USERNAME) return fail(res, 'BOT_USERNAME is not set on the server.');
  if (await adsToday(req.u.id) >= s.daily_ad_limit) return fail(res, 'Daily ad limit reached. Come back tomorrow.');
  await q('DELETE FROM ad_views WHERE user_id=$1 AND NOT done', [req.u.id]);
  const token = crypto.randomBytes(12).toString('hex');
  await q('INSERT INTO ad_views(token,user_id,ad_id) VALUES($1,$2,0)', [token, req.u.id]);
  res.json({ ok: true, link: `https://t.me/${process.env.BOT_USERNAME}?start=ad_${token}`, seconds: s.ad_seconds });
}));

app.post('/api/ad/done', auth, wrap(async (req, res) => {
  const s = await settings();
  if (await adsToday(req.u.id) >= s.daily_ad_limit) return fail(res, 'Daily ad limit reached. Come back tomorrow.');
  const v = (await q(`SELECT token, confirmed, GREATEST(0, CEIL($2 - extract(epoch from now()-started))) AS left FROM ad_views WHERE user_id=$1 AND NOT done AND started>now()-interval '${AD_WINDOW}' ORDER BY started DESC LIMIT 1`, [req.u.id, s.ad_seconds])).rows[0];
  if (!v) return fail(res, 'Tap "Watch an ad" first.');
  if (Number(v.left) > 0) return fail(res, `Watch the full ad in the bot first (${v.left}s left).`);
  if (s.ad_confirm && !v.confirmed) return fail(res, 'Finish watching the ad in the bot first.');
  const r = await q('UPDATE ad_views SET done=true WHERE token=$1 AND NOT done RETURNING 1', [v.token]);
  if (!r.rowCount) return fail(res, 'Tap "Watch an ad" first.');
  await q('UPDATE users SET points=points+1 WHERE id=$1', [req.u.id]);
  res.json({ ok: true });
}));

app.post('/api/task/:id', auth, wrap(async (req, res) => {
  const t = (await q('SELECT * FROM tasks WHERE id=$1 AND active', [Number(req.params.id)])).rows[0];
  if (!t) return fail(res, 'Task not found', 404);
  if (t.type === 'join') {
    const r = await tg('getChatMember', { chat_id: t.channel, user_id: req.u.id });
    if (!['member', 'administrator', 'creator'].includes(r.result && r.result.status)) return fail(res, 'Join the channel first, then tap Verify.');
  }
  const ins = await q('INSERT INTO task_done VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING 1', [req.u.id, t.id]);
  if (!ins.rowCount) return fail(res, 'You already completed this task.');
  await q('UPDATE users SET points=points+$1 WHERE id=$2', [t.points, req.u.id]);
  res.json({ ok: true, points: t.points });
}));

// A reward needs BOTH enough points AND enough invited friends. After a claim the user must contact the owner.
app.post('/api/reward/:id/claim', auth, wrap(async (req, res) => {
  const r = (await q('SELECT * FROM rewards WHERE id=$1 AND active', [Number(req.params.id)])).rows[0];
  if (!r) return fail(res, 'Reward not found', 404);
  const inv = await invitesOf(req.u.id);
  if (inv < r.min_invites) return fail(res, `You need ${r.min_invites} invited friends (you have ${inv}).`);
  const u = await q('UPDATE users SET points=points-$1 WHERE id=$2 AND points>=$1 RETURNING points', [r.cost, req.u.id]);
  if (!u.rowCount) return fail(res, 'Not enough points yet.');
  await q('INSERT INTO claims(user_id,reward_id,title,cost) VALUES($1,$2,$3,$4)', [req.u.id, r.id, r.title, r.cost]);
  const who = req.u.username ? '@' + req.u.username : req.u.first_name;
  ADMINS.forEach(a => tg('sendMessage', { chat_id: a, text: `New claim: ${r.title} (${r.cost} pts, ${inv} invites) by ${who} (ID ${req.u.id}). Open the admin tab to approve.` }));
  tg('sendMessage', { chat_id: req.u.id, text: `Your claim for "${r.title}" was received. To get your reward, contact the admin: @${OWNER}` });
  res.json({ ok: true, owner: OWNER });
}));

// ---- Admin API ----
const ad = [auth, adminOnly];
app.post('/api/admin/image', ad, wrap(async (req, res) => {
  const r = await q('INSERT INTO images(data) VALUES($1) RETURNING id', [String(req.body.data || '')]);
  res.json({ id: r.rows[0].id });
}));
app.get('/api/admin/data', ad, wrap(async (req, res) => {
  const [rewards, tasks, claims, users, s] = await Promise.all([
    q('SELECT * FROM rewards WHERE active ORDER BY id DESC'),
    q('SELECT * FROM tasks WHERE active ORDER BY id DESC'),
    q("SELECT c.*,u.name,u.username FROM claims c JOIN users u ON u.id=c.user_id ORDER BY (c.status='pending') DESC, c.id DESC LIMIT 50"),
    q('SELECT count(*) FROM users'), settings()]);
  res.json({ rewards: rewards.rows, tasks: tasks.rows, claims: claims.rows, users: Number(users.rows[0].count), settings: s });
}));
app.post('/api/admin/reward', ad, wrap(async (req, res) => {
  const b = req.body; await q('INSERT INTO rewards(title,body,image_id,cost,min_invites) VALUES($1,$2,$3,$4,$5)', [b.title, b.body, b.image_id || null, Number(b.cost) || 1, Math.max(0, Number(b.min_invites) || 0)]); res.json({ ok: true });
}));
app.post('/api/admin/task', ad, wrap(async (req, res) => {
  const b = req.body; let ch = (b.channel || '').trim(), link = (b.link || '').trim();
  if (b.type === 'join') { if (!ch) return fail(res, 'Channel username is required'); ch = '@' + ch.replace(/^@|^https?:\/\/t\.me\//, ''); link = 'https://t.me/' + ch.slice(1); }
  await q('INSERT INTO tasks(type,title,body,image_id,channel,link,points) VALUES($1,$2,$3,$4,$5,$6,$7)', [b.type, b.title, b.body, b.image_id || null, ch || null, link || null, Number(b.points) || 1]);
  res.json({ ok: true });
}));
app.delete('/api/admin/:kind/:id', ad, wrap(async (req, res) => {
  const t = { reward: 'rewards', task: 'tasks' }[req.params.kind];
  if (!t) return fail(res, 'Unknown item');
  await q(`UPDATE ${t} SET active=false WHERE id=$1`, [Number(req.params.id)]); res.json({ ok: true });
}));
app.post('/api/admin/claim/:id', ad, wrap(async (req, res) => {
  const st = req.body.status === 'approved' ? 'approved' : 'rejected';
  const c = (await q("UPDATE claims SET status=$1 WHERE id=$2 AND status='pending' RETURNING *", [st, Number(req.params.id)])).rows[0];
  if (!c) return fail(res, 'Already handled');
  if (st === 'rejected') await q('UPDATE users SET points=points+$1 WHERE id=$2', [c.cost, c.user_id]);
  tg('sendMessage', { chat_id: c.user_id, text: st === 'approved' ? `Your reward "${c.title}" was approved!` : `Your claim for "${c.title}" was rejected. ${c.cost} points were returned.` });
  res.json({ ok: true });
}));
app.post('/api/admin/settings', ad, wrap(async (req, res) => {
  for (const k of Object.keys(DEF)) if (req.body[k] !== undefined) await q('INSERT INTO settings VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', [k, String(Math.max(0, Number(req.body[k]) || 0))]);
  res.json({ ok: true });
}));

// Open <APP_URL>/api/setup once after deploying: it sets the Open-app menu button and shows what is missing.
// It does NOT touch the webhook, because the bot runs on Telebot Creator.
app.get('/api/setup', wrap(async (req, res) => {
  const env = { DATABASE_URL: !!process.env.DATABASE_URL, BOT_TOKEN: !!BOT, BOT_USERNAME: !!process.env.BOT_USERNAME, APP_URL: process.env.APP_URL || null, ADMIN_IDS: ADMINS.length, BOT_SECRET: !!BOT_SECRET, OWNER,
    WEBHOOK_SECRET: !!WEBHOOK_SECRET, ADMIN_ID: !!process.env.ADMIN_ID };
  if (!BOT || !process.env.APP_URL) return res.json({ ok: false, env, hint: 'Set BOT_TOKEN and APP_URL in Vercel, then Redeploy.' });
  const url = process.env.APP_URL.replace(/\/$/, '');
  const menu = await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Open app', web_app: { url } } });
  const info = await tg('getWebhookInfo', {});
  let db = 'ok'; try { await q('SELECT 1'); } catch (e) { db = e.message; }
  res.json({ ok: menu.ok, env, db, menu: menu.ok, webhook_info: info.result });
}));

// The rewards mini app page lives in public/index.html
const PAGE_FILE = path.join(__dirname, 'public', 'index.html');
app.get(['/', '/index.html'], (req, res) => fs.readFile(PAGE_FILE, 'utf8', (e, html) =>
  e ? res.status(500).send('public/index.html is missing') : res.set('Cache-Control', 'no-store').type('html').send(html)));

app.use((req, res) => res.status(404).json({ ok: false, error: 'Route not found.' }));

module.exports = app;
if (require.main === module) app.listen(process.env.PORT || 3000, () => console.log('Backend running'));
