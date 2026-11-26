// Rewards Mini App backend (Express API). Deploy on Vercel, DB on Neon.
// The bot itself (/start, ads) is built in Telebot Creator - this server does NOT set a webhook.
// ENV: DATABASE_URL, BOT_TOKEN, BOT_USERNAME (without @), APP_URL (https://your-app.vercel.app), ADMIN_IDS (comma separated Telegram IDs), BOT_SECRET (long random text, the same value goes in Telebot Creator), OWNER_USERNAME (optional, default abdu_your_owner)
const express = require('express'), crypto = require('crypto'), path = require('path'), fs = require('fs'), { Pool } = require('pg');
const app = express();
app.use(express.json({ limit: '6mb' }));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
const q = (t, p) => pool.query(t, p);
const BOT = process.env.BOT_TOKEN;
// Telegram Web App button destination. Set APP_URL in Vercel; this is the safe fallback for this project.
const APP_URL = (process.env.APP_URL || 'https://reward-bxv6.vercel.app').replace(/\/+$/, '');
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
ALTER TABLE users ADD COLUMN IF NOT EXISTS streak INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_checkin DATE;
CREATE TABLE IF NOT EXISTS promos(id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, points INT NOT NULL, max_uses INT NOT NULL DEFAULT 0, used INT NOT NULL DEFAULT 0, expires_at TIMESTAMPTZ, active BOOL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS promo_uses(promo_id INT, user_id BIGINT, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(promo_id, user_id));
CREATE TABLE IF NOT EXISTS broadcasts(id SERIAL PRIMARY KEY, text TEXT, with_button BOOL DEFAULT true, total INT DEFAULT 0, sent INT DEFAULT 0, failed INT DEFAULT 0, last_id BIGINT DEFAULT 0, status TEXT DEFAULT 'sending', created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS verification_welcomes(user_id BIGINT PRIMARY KEY, message_sent BOOL NOT NULL DEFAULT false, created_at TIMESTAMPTZ DEFAULT now());`;
let ready; const init = () => ready || (ready = q(SCHEMA));
app.use((req, res, next) => init().then(() => next(), next));

const DEF = { ad_seconds: 5, invite_points: 5, daily_ad_limit: 100, ad_confirm: 1, checkin_base: 1, checkin_step: 1, checkin_max: 7, maintenance: 0 };
const DEF_MSG = 'The app is under maintenance. Please come back soon.';
const settings = async () => { const s = { ...DEF, maintenance_msg: DEF_MSG }; (await q('SELECT * FROM settings')).rows.forEach(r => { s[r.key] = r.key === 'maintenance_msg' ? r.value : Number(r.value); }); return s; };

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
    // Telegram's signed initData is verified on the server. Invalid browser requests are rejected.
    const u = verify(req.headers['x-init']);
    if (!u) return fail(res, 'Open this app from Telegram', 401);

    const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
    await touchUser(u.id, name, u.username, Number(req.headers['x-ref']) || 0);
    req.u = u;
    req.admin = ADMINS.includes(String(u.id));

    // Create one welcome record per Telegram user; no Telegram callback query is required.
    const firstWelcome = await q(
      'INSERT INTO verification_welcomes(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING RETURNING user_id',
      [u.id]
    );
    req.verifiedWelcome = firstWelcome.rowCount > 0;

    // Send the confirmation once. Its button is a Telegram Web App URL button,
    // so it opens the Mini App directly and needs no TeleBot Creator callback handler.
    if (req.verifiedWelcome && BOT) {
      const result = await tg('sendMessage', {
        chat_id: u.id,
        text: `✅ Account verified successfully!\n\nWelcome to Rewards, ${name || 'friend'}! Your Telegram account has been verified and your app is ready.`,
        reply_markup: {
          inline_keyboard: [[
            { text: '🎁 Open Rewards App', web_app: { url: APP_URL } }
          ]]
        }
      });
      if (result && result.ok) {
        await q('UPDATE verification_welcomes SET message_sent=true WHERE user_id=$1', [u.id]);
      } else {
        console.error('Telegram welcome message could not be sent:', result && (result.description || result.error_code));
      }
    }

    if (!req.admin) {
      const s = await settings();
      if (s.maintenance) return res.status(503).json({ error: s.maintenance_msg, maintenance: true });
    }
    next();
  } catch (e) {
    console.error('Authentication middleware error:', e);
    fail(res, e.message, 500);
  }
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

// ---- Daily check-in (day changes at midnight Ethiopia time) ----
const TZ = 'Africa/Addis_Ababa';
const ckPoints = (s, n) => s.checkin_base + (Math.min(n, Math.max(1, s.checkin_max)) - 1) * s.checkin_step;
async function checkinState(id, s) {
  const r = (await q(`SELECT u.streak, COALESCE(u.last_checkin = t.d, false) AS done_today, COALESCE(u.last_checkin >= t.d - 1, false) AS alive FROM users u, (SELECT (now() AT TIME ZONE '${TZ}')::date AS d) t WHERE u.id=$1`, [id])).rows[0];
  return { streak: r.alive ? r.streak : 0, done_today: r.done_today, base: s.checkin_base, step: s.checkin_step, max: Math.max(1, s.checkin_max) };
}

app.get('/api/home', auth, wrap(async (req, res) => {
  const s = await settings();
  const [me, rewards, tasks, inv, today, pend, topP, topI, ck] = await Promise.all([
    q('SELECT points FROM users WHERE id=$1', [req.u.id]),
    q('SELECT id,title,body,image_id,cost,min_invites FROM rewards WHERE active ORDER BY cost'),
    q('SELECT t.id,t.type,t.title,t.body,t.image_id,t.channel,t.link,t.points,(d.user_id IS NOT NULL) AS done FROM tasks t LEFT JOIN task_done d ON d.task_id=t.id AND d.user_id=$1 WHERE t.active ORDER BY t.id DESC', [req.u.id]),
    invitesOf(req.u.id), adsToday(req.u.id),
    q(`SELECT 1 FROM ad_views WHERE user_id=$1 AND NOT done AND started>now()-interval '${AD_WINDOW}' LIMIT 1`, [req.u.id]),
    q('SELECT id,name,points FROM users WHERE points>0 ORDER BY points DESC, id LIMIT 10'),
    q('SELECT u.id,u.name,count(*)::int AS invites FROM users u JOIN users i ON i.invited_by=u.id GROUP BY u.id,u.name ORDER BY invites DESC, u.id LIMIT 10'),
    checkinState(req.u.id, s)]);
  res.json({ verified_welcome: req.verifiedWelcome === true, checkin: ck, maintenance: req.admin ? s.maintenance : 0, top_points: topP.rows, top_invites: topI.rows, me: req.u.id, admin: req.admin, bot: process.env.BOT_USERNAME, owner: OWNER, points: me.rows[0].points, invites: inv, rewards: rewards.rows, tasks: tasks.rows,
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

app.post('/api/checkin', auth, wrap(async (req, res) => {
  const s = await settings();
  const r = await q(`WITH d AS (SELECT (now() AT TIME ZONE '${TZ}')::date AS today)
    UPDATE users u SET streak = CASE WHEN u.last_checkin = d.today - 1 THEN u.streak + 1 ELSE 1 END, last_checkin = d.today
    FROM d WHERE u.id=$1 AND (u.last_checkin IS NULL OR u.last_checkin < d.today) RETURNING u.streak`, [req.u.id]);
  if (!r.rowCount) return fail(res, 'You already checked in today. Come back tomorrow!');
  const streak = r.rows[0].streak, pts = ckPoints(s, streak);
  await q('UPDATE users SET points=points+$1 WHERE id=$2', [pts, req.u.id]);
  res.json({ ok: true, streak, points: pts });
}));

// Promo code: one use per user, optional max uses and expiry.
app.post('/api/promo', auth, wrap(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) return fail(res, 'Enter a code first.');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const p = (await c.query('SELECT * FROM promos WHERE code=$1 AND active FOR UPDATE', [code])).rows[0];
    const stop = async msg => { await c.query('ROLLBACK'); return fail(res, msg); };
    if (!p) return await stop('Invalid code.');
    if (p.expires_at && new Date(p.expires_at) < new Date()) return await stop('This code has expired.');
    if ((await c.query('SELECT 1 FROM promo_uses WHERE promo_id=$1 AND user_id=$2', [p.id, req.u.id])).rowCount) return await stop('You already used this code.');
    if (p.max_uses > 0 && p.used >= p.max_uses) return await stop('This code has reached its limit.');
    const ins = await c.query('INSERT INTO promo_uses(promo_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING 1', [p.id, req.u.id]);
    if (!ins.rowCount) return await stop('You already used this code.');
    await c.query('UPDATE promos SET used=used+1 WHERE id=$1', [p.id]);
    await c.query('UPDATE users SET points=points+$1 WHERE id=$2', [p.points, req.u.id]);
    await c.query('COMMIT');
    res.json({ ok: true, points: p.points });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
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
  const [rewards, tasks, claims, users, s, promos, broadcasts] = await Promise.all([
    q('SELECT * FROM rewards WHERE active ORDER BY id DESC'),
    q('SELECT * FROM tasks WHERE active ORDER BY id DESC'),
    q("SELECT c.*,u.name,u.username FROM claims c JOIN users u ON u.id=c.user_id ORDER BY (c.status='pending') DESC, c.id DESC LIMIT 50"),
    q('SELECT count(*) FROM users'), settings(),
    q('SELECT id,code,points,max_uses,used,expires_at FROM promos ORDER BY id DESC LIMIT 50'),
    q('SELECT id,total,sent,failed,status,created_at FROM broadcasts ORDER BY id DESC LIMIT 5')]);
  res.json({ rewards: rewards.rows, tasks: tasks.rows, claims: claims.rows, users: Number(users.rows[0].count), settings: s, promos: promos.rows, broadcasts: broadcasts.rows });
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
app.post('/api/admin/promo', ad, wrap(async (req, res) => {
  const b = req.body; let code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!code) code = crypto.randomBytes(5).toString('hex').toUpperCase();
  const pts = Math.floor(Number(b.points) || 0); if (pts < 1) return fail(res, 'Points must be 1 or more.');
  const max = Math.max(0, Math.floor(Number(b.max_uses) || 0)), hrs = Math.max(0, Number(b.hours) || 0);
  try { await q("INSERT INTO promos(code,points,max_uses,expires_at) VALUES($1,$2,$3, CASE WHEN $4::float > 0 THEN now() + $4::float * interval '1 hour' END)", [code, pts, max, hrs]); }
  catch (e) { if (e.code === '23505') return fail(res, 'This code already exists.'); throw e; }
  res.json({ ok: true, code });
}));
app.delete('/api/admin/promo/:id', ad, wrap(async (req, res) => {
  const id = Number(req.params.id);
  await q('DELETE FROM promo_uses WHERE promo_id=$1', [id]); await q('DELETE FROM promos WHERE id=$1', [id]); res.json({ ok: true });
}));

// Broadcast: the admin page calls /step again and again; each step sends to the next 25 users (stays under Telegram limits and Vercel time limits).
app.post('/api/admin/broadcast', ad, wrap(async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return fail(res, 'Write a message first.');
  if (text.length > 3500) return fail(res, 'Message is too long.');
  const total = Number((await q('SELECT count(*) FROM users')).rows[0].count);
  const r = await q('INSERT INTO broadcasts(text,with_button,total) VALUES($1,$2,$3) RETURNING id', [text, req.body.button !== false, total]);
  res.json({ ok: true, id: r.rows[0].id, total });
}));
app.post('/api/admin/broadcast/:id/step', ad, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = (await q('SELECT * FROM broadcasts WHERE id=$1', [id])).rows[0];
  if (!b) return fail(res, 'Broadcast not found', 404);
  if (b.status === 'done') return res.json(b);
  const users = (await q('SELECT id FROM users WHERE id>$1 ORDER BY id LIMIT 25', [b.last_id])).rows;
  if (!users.length) return res.json((await q("UPDATE broadcasts SET status='done' WHERE id=$1 RETURNING *", [id])).rows[0]);
  const markup = b.with_button && process.env.APP_URL ? { inline_keyboard: [[{ text: 'Open app', web_app: { url: process.env.APP_URL } }]] } : undefined;
  const rs = await Promise.all(users.map(u => tg('sendMessage', { chat_id: u.id, text: b.text, reply_markup: markup })));
  const rl = rs.findIndex(r => r && r.error_code === 429), upto = rl === -1 ? users.length : rl;
  if (upto === 0) return res.json({ ...b, wait: (rs[0].parameters && rs[0].parameters.retry_after) || 2 });
  const ok = rs.slice(0, upto).filter(r => r && r.ok).length;
  res.json((await q('UPDATE broadcasts SET sent=sent+$1, failed=failed+$2, last_id=$3 WHERE id=$4 RETURNING *', [ok, upto - ok, users[upto - 1].id, id])).rows[0]);
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
  if (req.body.maintenance_msg !== undefined) await q('INSERT INTO settings VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', ['maintenance_msg', String(req.body.maintenance_msg).trim().slice(0, 300) || DEF_MSG]);
  res.json({ ok: true });
}));


// Open <APP_URL>/api/setup once after deploying: it sets the Open-app menu button and shows what is missing.
// It does NOT touch the webhook, because the bot runs on Telebot Creator.
app.get('/api/setup', wrap(async (req, res) => {
  const env = { DATABASE_URL: !!process.env.DATABASE_URL, BOT_TOKEN: !!BOT, BOT_USERNAME: !!process.env.BOT_USERNAME, APP_URL, ADMIN_IDS: ADMINS.length, BOT_SECRET: !!BOT_SECRET, OWNER };
  if (!BOT) return res.json({ ok: false, env, hint: 'Set BOT_TOKEN in Vercel, then Redeploy.' });
  const url = APP_URL;
  const menu = await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Open app', web_app: { url } } });
  const info = await tg('getWebhookInfo', {});
  let db = 'ok'; try { await q('SELECT 1'); } catch (e) { db = e.message; }
  res.json({ ok: menu.ok, env, db, menu: menu.ok, webhook_info: info.result });
}));
// Front-end files live in /public (index.html + style.css). Vercel bundles them via includeFiles: ["public/**"].
const pub = f => fs.readFileSync(path.join(__dirname, 'public', f), 'utf8');
const PAGE = pub('index.html'), CSS = pub('style.css');
app.get('/style.css', (req, res) => res.set('Cache-Control', 'no-cache').type('css').send(CSS));
app.get(['/', '/index.html'], (req, res) => res.set('Cache-Control', 'no-store').type('html').send(PAGE));
module.exports = app;
if (require.main === module) app.listen(process.env.PORT || 3000);
