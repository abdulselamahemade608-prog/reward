// Rewards Mini App backend (Express API). Deploy on Vercel, DB on Neon.
// The bot itself (/start, ads) is built in Telebot Creator - this server does NOT set a webhook.
// ENV: DATABASE_URL, BOT_TOKEN, BOT_USERNAME (without @), APP_URL (https://your-app.vercel.app), ADMIN_IDS (comma separated Telegram IDs), BOT_SECRET (long random text, the same value goes in Telebot Creator), OWNER_USERNAME (optional, default abdu_your_owner)
const express = require('express'), crypto = require('crypto'), path = require('path'), { Pool } = require('pg');
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
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);`;
let ready; const init = () => ready || (ready = q(SCHEMA));
app.use((req, res, next) => init().then(() => next(), next));

const DEF = { ad_seconds: 5, invite_points: 5, daily_ad_limit: 100, ad_confirm: 0 };
const settings = async () => { const s = { ...DEF }; (await q('SELECT * FROM settings')).rows.forEach(r => s[r.key] = Number(r.value)); return s; };

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
  const id = Number(botData(req).user_id);
  if (!id) return fail(res, 'user_id is required');
  const r = await q(`UPDATE ad_views SET confirmed=true WHERE token=(SELECT token FROM ad_views WHERE user_id=$1 AND NOT done AND started>now()-interval '${AD_WINDOW}' ORDER BY started DESC LIMIT 1) RETURNING 1`, [id]);
  res.json({ ok: true, found: r.rowCount > 0 });
}));

// Ads are shown by the Telebot Creator bot. The app only opens the bot link (start=ad), the bot runs its ads command,
// then the user returns and collects the point after the minimum watch time.
app.post('/api/ad/start', auth, wrap(async (req, res) => {
  const s = await settings();
  if (!process.env.BOT_USERNAME) return fail(res, 'BOT_USERNAME is not set on the server.');
  if (await adsToday(req.u.id) >= s.daily_ad_limit) return fail(res, 'Daily ad limit reached. Come back tomorrow.');
  await q('DELETE FROM ad_views WHERE user_id=$1 AND NOT done', [req.u.id]);
  await q('INSERT INTO ad_views(token,user_id,ad_id) VALUES($1,$2,0)', [crypto.randomBytes(12).toString('hex'), req.u.id]);
  res.json({ ok: true, link: `https://t.me/${process.env.BOT_USERNAME}?start=ad`, seconds: s.ad_seconds });
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
  const env = { DATABASE_URL: !!process.env.DATABASE_URL, BOT_TOKEN: !!BOT, BOT_USERNAME: !!process.env.BOT_USERNAME, APP_URL: process.env.APP_URL || null, ADMIN_IDS: ADMINS.length, BOT_SECRET: !!BOT_SECRET, OWNER };
  if (!BOT || !process.env.APP_URL) return res.json({ ok: false, env, hint: 'Set BOT_TOKEN and APP_URL in Vercel, then Redeploy.' });
  const url = process.env.APP_URL.replace(/\/$/, '');
  const menu = await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Open app', web_app: { url } } });
  const info = await tg('getWebhookInfo', {});
  let db = 'ok'; try { await q('SELECT 1'); } catch (e) { db = e.message; }
  res.json({ ok: menu.ok, env, db, menu: menu.ok, webhook_info: info.result });
}));
const PAGE = "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<title>Rewards</title>\n<link href=\"https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;700;800&display=swap\" rel=\"stylesheet\">\n<script src=\"https://telegram.org/js/telegram-web-app.js\"></script>\n<style>\n:root{--bg:#f4f2ff;--card:#fff;--ink:#1b1340;--mut:#6f6a8f;--line:#e6e2fa;--v:#6c4cf1;--pk:#ff5c8a;--mint:#12b886;--sun:#ffb020;--sky:#2d9cff;--red:#f0445b}\n@media(prefers-color-scheme:dark){:root{--bg:#120d2b;--card:#1d1642;--ink:#f1eeff;--mut:#a39fc9;--line:#2c2460}}\n*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}\nbody{margin:0;background:var(--bg);color:var(--ink);font:500 15px/1.45 \"Plus Jakarta Sans\",system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;padding-bottom:96px}\n.wrap{padding:16px;max-width:560px;margin:auto}\nsvg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}\nh1,h2,h3{margin:0}h2{font-size:18px;font-weight:800;margin:26px 0 12px;display:flex;align-items:center;gap:10px}\n.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}\n.top b{font-size:20px;font-weight:800}.top span{color:var(--mut);font-size:13px;display:block}\n.hero{position:relative;overflow:hidden;border-radius:26px;padding:24px;color:#fff;background:linear-gradient(135deg,#6c4cf1 0%,#b04cf1 55%,#ff5c8a 100%);box-shadow:0 18px 40px -18px #6c4cf1}\n.hero:before,.hero:after{content:\"\";position:absolute;border-radius:50%;background:rgba(255,255,255,.14)}\n.hero:before{width:190px;height:190px;right:-50px;top:-70px}.hero:after{width:110px;height:110px;right:50px;bottom:-60px}\n.hero small{opacity:.85;font-weight:700;display:flex;align-items:center;gap:6px}\n.hero .n{font-size:64px;font-weight:800;letter-spacing:-3px;line-height:1;margin:8px 0 18px}\n.hero button{position:relative;z-index:1}\n.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:14px;margin-bottom:12px}\n.card .ph{width:100%;height:150px;object-fit:cover;border-radius:14px;margin-bottom:12px;display:block}\n.noimg{height:110px;border-radius:14px;margin-bottom:12px;display:grid;place-items:center;color:#fff}.noimg svg{width:40px;height:40px}\n.row{display:flex;gap:10px;align-items:center;justify-content:space-between}\n.head{display:flex;gap:12px;align-items:center}\n.ico{width:42px;height:42px;border-radius:14px;display:grid;place-items:center;color:#fff;flex:none}\n.g1{background:linear-gradient(135deg,#6c4cf1,#9a7bff)}.g2{background:linear-gradient(135deg,#ff5c8a,#ff8f6b)}\n.g3{background:linear-gradient(135deg,#12b886,#4fd6a8)}.g4{background:linear-gradient(135deg,#ffb020,#ffd24d);color:#4a2f00}\n.g5{background:linear-gradient(135deg,#2d9cff,#59c2ff)}.g6{background:linear-gradient(135deg,#f0445b,#ff7a8a)}\n.mut{color:var(--mut);font-size:13px;white-space:pre-wrap}\nbutton{font:inherit;font-weight:700;border:0;border-radius:14px;padding:11px 16px;background:var(--v);color:#fff;cursor:pointer;display:inline-flex;align-items:center;gap:8px;justify-content:center;transition:transform .12s}\nbutton:active{transform:scale(.96)}\nbutton.w{background:#fff;color:#4b2fd0}button.soft{background:color-mix(in srgb,var(--v) 14%,transparent);color:var(--v)}\nbutton.bad{background:color-mix(in srgb,var(--red) 14%,transparent);color:var(--red);padding:9px}button.ok{background:var(--mint)}button.full{width:100%}\nbutton:disabled{opacity:.5}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid var(--sun);outline-offset:2px}\n.pill{display:inline-flex;align-items:center;gap:4px;background:color-mix(in srgb,var(--sun) 24%,transparent);color:#b36b00;border-radius:99px;padding:4px 10px;font-weight:800;font-size:13px;white-space:nowrap}\n.pill svg{width:14px;height:14px}.st{font-size:12px;font-weight:800;padding:3px 10px;border-radius:99px}\n.st.pending{background:#ffb02033;color:#b36b00}.st.approved{background:#12b88622;color:var(--mint)}.st.rejected{background:#f0445b22;color:var(--red)}\n.done{opacity:.6}.bar{height:8px;background:var(--line);border-radius:9px;overflow:hidden;margin:10px 0 12px}.bar i{display:block;height:100%;border-radius:9px;background:linear-gradient(90deg,var(--sun),var(--pk));width:0;transition:width .4s}\n.invite{background:linear-gradient(135deg,#12b886,#2d9cff);color:#fff;border:0}.invite .mut{color:#ffffffcc}\nnav{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));max-width:536px;margin:auto;display:flex;gap:6px;background:var(--card);border:1px solid var(--line);border-radius:22px;padding:6px;box-shadow:0 14px 30px -14px #1b134066;z-index:5}\nnav button{flex:1;flex-direction:column;gap:2px;font-size:12px;background:none;color:var(--mut);padding:8px;border-radius:16px}\nnav button.on{background:var(--v);color:#fff}\ninput,select,textarea{width:100%;font:inherit;padding:12px;margin:5px 0 10px;border:1.5px solid var(--line);border-radius:14px;background:var(--bg);color:var(--ink)}\nlabel{font-size:13px;color:var(--mut);font-weight:700}\n#ov{position:fixed;inset:0;background:var(--bg);z-index:9;display:none;overflow:auto}\n#toast{position:fixed;left:50%;top:14px;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:11px 18px;border-radius:99px;z-index:20;display:none;max-width:90%;text-align:center;font-weight:700}\n.empty{text-align:center;color:var(--mut);padding:26px 10px}.empty .ico{margin:0 auto 10px;width:54px;height:54px;border-radius:18px}\n.center{min-height:100vh;display:grid;place-items:center;text-align:center;padding:30px}\n@media(prefers-reduced-motion:reduce){*{transition:none!important}}\n</style></head><body>\n<div class=\"wrap\" id=\"app\"></div><div id=\"ov\"></div><div id=\"toast\"></div><nav id=\"nav\"></nav>\n<script>\nconst tg=window.Telegram&&window.Telegram.WebApp;\nconst P={home:'<path d=\"M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z\"/>',tasks:'<path d=\"M9 11l3 3 8-8\"/><path d=\"M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9\"/>',\nshield:'<path d=\"M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z\"/><path d=\"M9 12l2 2 4-4\"/>',play:'<path d=\"M7 4l13 8-13 8z\" fill=\"currentColor\"/>',\ngift:'<rect x=\"3\" y=\"8\" width=\"18\" height=\"4\" rx=\"1\"/><path d=\"M12 8v13M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8M7.5 8a2.5 2.5 0 1 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 1 1 0 5\"/>',\nusers:'<circle cx=\"9\" cy=\"8\" r=\"3.5\"/><path d=\"M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6\"/><circle cx=\"17.5\" cy=\"9\" r=\"2.5\"/><path d=\"M17 14c2.7 0 4.5 1.8 4.5 4.5\"/>',\nsend:'<path d=\"M21 3L3 10.5l6.5 2.5L12 20z\"/><path d=\"M9.5 13L21 3\"/>',bot:'<rect x=\"4\" y=\"8\" width=\"16\" height=\"12\" rx=\"3\"/><path d=\"M12 4v4M9 14h.01M15 14h.01\"/>',\nshare:'<circle cx=\"18\" cy=\"5\" r=\"3\"/><circle cx=\"6\" cy=\"12\" r=\"3\"/><circle cx=\"18\" cy=\"19\" r=\"3\"/><path d=\"M8.6 10.5l6.8-4M8.6 13.5l6.8 4\"/>',copy:'<rect x=\"9\" y=\"9\" width=\"11\" height=\"11\" rx=\"2\"/><path d=\"M5 15V6a2 2 0 0 1 2-2h9\"/>',\nplus:'<path d=\"M12 5v14M5 12h14\"/>',trash:'<path d=\"M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3\"/>',\nstar:'<path d=\"M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z\" fill=\"currentColor\"/>',check:'<path d=\"M5 12.5l4.5 4.5L19 7\"/>',\nx:'<path d=\"M6 6l12 12M18 6L6 18\"/>',ad:'<path d=\"M3 11v2a1 1 0 0 0 1 1h3l7 4V6L7 10H4a1 1 0 0 0-1 1z\"/><path d=\"M18 9a4 4 0 0 1 0 6\"/>',\nset:'<path d=\"M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0\"/><circle cx=\"16\" cy=\"6\" r=\"2\"/><circle cx=\"10\" cy=\"12\" r=\"2\"/><circle cx=\"18\" cy=\"18\" r=\"2\"/>',\nout:'<path d=\"M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5\"/>',user:'<circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7\"/>',inbox:'<path d=\"M4 13l2-8h12l2 8v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z\"/><path d=\"M4 13h5a3 3 0 0 0 6 0h5\"/>'};\nconst ic=n=>`<svg viewBox=\"0 0 24 24\">${P[n]}</svg>`;\nconst tile=(n,g)=>`<span class=\"ico ${g}\">${ic(n)}</span>`;\nconst $=s=>document.querySelector(s);\nconst esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\n\nif(!tg||!tg.initData){\n  $('#app').innerHTML=`<div class=\"center\"><div>${tile('send','g1').replace('ico','ico\" style=\"width:64px;height:64px;margin:0 auto 16px')}<h2 style=\"justify-content:center;margin:0 0 6px\">Open this app in Telegram</h2><p class=\"mut\">Start the bot and tap the app button. This page does not work in a normal browser.</p></div></div>`;\n  throw new Error('Not inside Telegram');\n}\ntg.ready();tg.expand();\nconst ref=String(new URLSearchParams(location.search).get('ref')||(tg.initDataUnsafe&&tg.initDataUnsafe.start_param)||'').replace('ref_','');\nasync function api(p,m='GET',b){\n  const r=await fetch('/api/'+p,{method:m,headers:{'Content-Type':'application/json','x-init':tg.initData,'x-ref':ref},body:b?JSON.stringify(b):undefined});\n  const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Something went wrong');return j}\nlet tt;function toast(t){const e=$('#toast');e.textContent=t;e.style.display='block';clearTimeout(tt);tt=setTimeout(()=>e.style.display='none',2800)}\nconst run=async f=>{try{await f()}catch(e){toast(e.message)}};\nconst open=u=>/^https:\\/\\/t\\.me\\//.test(u)?tg.openTelegramLink(u):tg.openLink(u);\nconst GR=['g1','g2','g3','g4','g5'];\nconst img=(id,i=0,icon='gift')=>id?`<img class=\"ph\" src=\"/img/${id}\" alt=\"\">`:`<div class=\"noimg ${GR[i%5]}\">${ic(icon)}</div>`;\nlet S={},A=null,PR=null,tab='home',first=true;\n\nasync function load(){S=await api('home');if(tab==='admin')A=await api('admin/data');if(tab==='profile')PR=await api('profile');render();\n  if(first&&tab==='home'){first=false;const e=$('.hero .n');if(e){const to=S.points,t0=performance.now();(function f(t){const k=Math.min(1,(t-t0)/700);e.textContent=Math.round(to*(1-Math.pow(1-k,3)));if(k<1)requestAnimationFrame(f)})(t0)}}}\nfunction render(){\n  $('#nav').innerHTML=[['home','Home','home'],['tasks','Tasks','tasks'],['profile','Profile','user'],...(S.admin?[['admin','Admin','shield']]:[])].map(([k,l,i])=>`<button class=\"${tab===k?'on':''}\" onclick=\"tab='${k}';run(load)\">${ic(i)}${l}</button>`).join('');\n  $('#app').innerHTML=tab==='home'?home():tab==='tasks'?tasks():tab==='profile'?profile():admin();scrollTo(0,0)}\nconst medal=i=>['🥇','🥈','🥉'][i]||('#'+(i+1));\nconst board=(t,i,g,rows,val)=>`<h2>${tile(i,g)} ${t}</h2>`+(rows.length?`<div class=\"card\" style=\"padding:4px 14px\">`+rows.map((u,k)=>`<div class=\"row\" style=\"padding:11px 0;${k?'border-top:1px solid var(--line)':''}\"><div class=\"head\"><b style=\"min-width:34px\">${medal(k)}</b><b>${esc(u.name||'User')}${String(u.id)===String(S.me)?' (you)':''}</b></div><span class=\"pill\">${val(u)}</span></div>`).join('')+`</div>`:`<div class=\"empty\">${tile(i,g)}No one yet.<br>Be the first!</div>`);\nfunction home(){return `\n<div class=\"top\"><div><span>Welcome back</span><b>${esc(tg.initDataUnsafe.user?.first_name||'Friend')}</b></div></div>\n<div class=\"hero\"><small>${ic('star')} Your points</small><div class=\"n\">${S.points}</div>${S.ad_pending?`<button class=\"w\" onclick=\"run(collectAd)\">${ic('star')} Collect 1 point</button> <button style=\"background:#ffffff33;color:#fff\" onclick=\"run(watch)\">${ic('play')} Open ad again</button>`:`<button class=\"w\" onclick=\"run(watch)\">${ic('play')} Watch an ad, get 1 point</button>`}\n<div style=\"position:relative;z-index:1;margin-top:12px;font-size:12px;opacity:.9\">Ads today: ${S.ads_today} / ${S.ad_limit}</div></div>\n<h2>${tile('gift','g2')} Rewards</h2>\n${(S.rewards||[]).length?(S.rewards||[]).map((r,i)=>{const mi=r.min_invites||0,np=Math.max(0,r.cost-S.points),ni=Math.max(0,mi-S.invites),ok=!np&&!ni,pc=Math.min(100,S.points/r.cost*100),pi=mi?Math.min(100,S.invites/mi*100):100;\nconst lbl=ok?ic('gift')+' Claim reward':[np?np+' more points':'',ni?ni+' more invites':''].filter(Boolean).join(' + ')+' needed';\nreturn `<div class=\"card\">${img(r.image_id,i)}\n<div class=\"row\"><b style=\"font-size:16px\">${esc(r.title)}</b><span><span class=\"pill\">${ic('star')}${r.cost}</span>${mi?` <span class=\"pill\">${ic('users')}${mi}</span>`:''}</span></div>\n<div class=\"mut\" style=\"margin-top:4px\">${esc(r.body)}</div>\n<div class=\"mut\" style=\"margin-top:8px\">Points ${Math.min(S.points,r.cost)} / ${r.cost}</div><div class=\"bar\"><i style=\"width:${pc}%\"></i></div>\n${mi?`<div class=\"mut\">Invites ${Math.min(S.invites,mi)} / ${mi}</div><div class=\"bar\"><i style=\"width:${pi}%\"></i></div>`:''}\n<button class=\"full ${ok?'ok':'soft'}\" ${ok?'':'disabled'} onclick=\"run(()=>claim(${r.id}))\">${lbl}</button></div>`}).join('')\n:`<div class=\"empty\">${tile('gift','g2')}No rewards yet.<br>Check back soon.</div>`}\n${board('Top points','star','g4',S.top_points||[],u=>u.points+' pts')}`}\nfunction tasks(){\n  const link=`https://t.me/${S.bot}?start=ref_${S.me}`;\n  return `<div class=\"card invite\"><div class=\"head\">${tile('users','g6').replace('g6','')} <div><b style=\"font-size:17px\">Invite friends</b><div class=\"mut\">Earn ${S.invite_points} points for every friend who joins with your link.<br>You invited <b>${S.invites}</b> friend(s) so far.</div></div></div>\n<div class=\"row\" style=\"margin-top:14px\"><button class=\"w full\" onclick=\"tg.openTelegramLink('https://t.me/share/url?url='+encodeURIComponent('${link}'))\">${ic('share')} Share</button>\n<button class=\"w full\" onclick=\"navigator.clipboard.writeText('${link}').then(()=>toast('Link copied'))\">${ic('copy')} Copy</button></div></div>\n${board('Top inviters','users','g3',S.top_invites||[],u=>u.invites+' invites')}\n<h2>${tile('tasks','g1')} Tasks</h2>\n${(S.tasks||[]).length?(S.tasks||[]).map((t,i)=>`<div class=\"card ${t.done?'done':''}\">${t.image_id?img(t.image_id):''}\n<div class=\"head\">${tile(t.type==='join'?'send':'bot',t.type==='join'?'g5':'g1')}<div style=\"flex:1\"><b>${esc(t.title)}</b><div class=\"mut\">${esc(t.body)}</div></div><span class=\"pill\">${ic('star')}${t.points}</span></div>\n<div class=\"row\" style=\"margin-top:12px\">${t.done?`<span class=\"st approved\" style=\"display:inline-flex;gap:4px;align-items:center\">${ic('check').replace('<svg','<svg width=14 height=14')} Completed</span>`:`\n<button class=\"soft full\" onclick=\"open('${esc(t.link)}')\">${ic('out')} ${t.type==='join'?'Join channel':'Open bot'}</button>\n<button class=\"full\" onclick=\"run(()=>doTask(${t.id}))\">${ic('check')} ${t.type==='join'?'Verify':'I did it'}</button>`}</div></div>`).join('')\n:`<div class=\"empty\">${tile('tasks','g1')}No tasks yet.<br>Check back soon.</div>`}`}\nfunction profile(){if(!PR)return '<p class=\"mut\">Loading...</p>';const p=PR,uu=(tg.initDataUnsafe&&tg.initDataUnsafe.user)||{};\n  const row=(k,v)=>`<div class=\"row\" style=\"padding:10px 0;border-top:1px solid var(--line)\"><span class=\"mut\">${k}</span><b>${v}</b></div>`;\n  const link=`https://t.me/${S.bot}?start=ref_${S.me}`;\n  return `<div class=\"top\"><div><span>My account</span><b>Profile</b></div></div>\n<div class=\"card\" style=\"text-align:center\"><div style=\"position:relative;width:88px;height:88px;margin:6px auto 12px;border-radius:50%;background:linear-gradient(135deg,#6c4cf1,#ff5c8a);color:#fff;display:grid;place-items:center;font-size:36px;font-weight:800;overflow:hidden\">${esc((p.name||'U').trim().charAt(0).toUpperCase())}${uu.photo_url?`<img src=\"${esc(uu.photo_url)}\" alt=\"\" style=\"position:absolute;inset:0;width:100%;height:100%;object-fit:cover\" onerror=\"this.remove()\">`:''}</div>\n<b style=\"font-size:19px\">${esc(p.name)}</b><div class=\"mut\">${p.username?'@'+esc(p.username):'No username'}</div></div>\n<div class=\"row\" style=\"gap:10px;margin-bottom:12px\">${stat(p.points,'Points','g4','star')}${stat(p.invites,'Invites','g3','users')}</div>\n<div class=\"card\" style=\"padding:4px 14px\">${row('Name',esc(p.name))}${row('Username',p.username?'@'+esc(p.username):'-')}${row('Telegram ID',esc(p.id))}${row('Joined',new Date(p.created_at).toLocaleDateString())}\n${row('Points rank','#'+p.rank_points)}${row('Invites rank',p.invites?'#'+p.rank_invites:'-')}${row('Ads today',p.ads_today+' / '+S.ad_limit)}${row('Ads watched (total)',p.ads_total)}${row('Tasks completed',p.tasks_done)}${row('Invited by',p.invited_by_name?esc(p.invited_by_name):'-')}</div>\n<div class=\"card invite\"><b>My invite link</b><div class=\"mut\" style=\"word-break:break-all;margin:6px 0 12px\">${link}</div>\n<div class=\"row\"><button class=\"w full\" onclick=\"tg.openTelegramLink('https://t.me/share/url?url='+encodeURIComponent('${link}'))\">${ic('share')} Share</button>\n<button class=\"w full\" onclick=\"navigator.clipboard.writeText('${link}').then(()=>toast('Link copied'))\">${ic('copy')} Copy</button></div></div>\n<h2>${tile('inbox','g4')} My claims</h2>${(p.claims||[]).length?p.claims.map(c=>`<div class=\"card\"><div class=\"row\"><b>${esc(c.title)}</b><span class=\"pill\">${ic('star')}${c.cost}</span></div><div class=\"row\" style=\"margin-top:8px\"><span class=\"st ${c.status}\">${c.status}</span><span class=\"mut\">${new Date(c.created_at).toLocaleDateString()}</span></div></div>`).join(''):`<div class=\"empty\">${tile('inbox','g4')}No claims yet.</div>`}`}\nasync function claim(id){await api('reward/'+id+'/claim','POST');await load();contact()}\nfunction contact(){const o=$('#ov');o.style.display='block';\n  o.innerHTML=`<div class=\"center\"><div><span class=\"ico g3\" style=\"width:64px;height:64px;margin:0 auto 16px\">${ic('gift')}</span><h2 style=\"justify-content:center;margin:0 0 8px\">Claim sent!</h2>\n<p class=\"mut\">To receive your reward, contact the admin:<br><b style=\"font-size:17px;color:var(--ink)\">@${esc(S.owner)}</b></p>\n<button class=\"full\" onclick=\"tg.openTelegramLink('https://t.me/${esc(S.owner)}')\">${ic('send')} Contact @${esc(S.owner)}</button>\n<button class=\"soft full\" style=\"margin-top:10px\" onclick=\"$('#ov').style.display='none'\">Close</button></div></div>`}\nasync function doTask(id){const r=await api('task/'+id,'POST');toast('+'+r.points+' points');await load()}\nasync function watch(){\n  const r=await api('ad/start','POST');\n  await load();\n  toast('Watch the ad in the bot, then come back and collect your point');\n  open(r.link)}\nasync function collectAd(){await api('ad/done','POST');toast('+1 point');await load()}\ndocument.addEventListener('visibilitychange',()=>{if(!document.hidden&&tab==='home')run(load)});\n\n// ---------- Admin ----------\nfunction upImg(id){const f=$('#'+id).files[0];if(!f)return null;\n  return new Promise(res=>{const im=new Image();im.onload=async()=>{const k=Math.min(1,800/Math.max(im.width,im.height)),c=document.createElement('canvas');\n    c.width=im.width*k;c.height=im.height*k;c.getContext('2d').drawImage(im,0,0,c.width,c.height);\n    res((await api('admin/image','POST',{data:c.toDataURL('image/jpeg',.8).split(',')[1]})).id)};im.src=URL.createObjectURL(f)})}\nconst v=id=>$('#'+id).value;\nconst del=(k,id)=>run(async()=>{await api('admin/'+k+'/'+id,'DELETE');await load()});\nconst add=(k,body)=>run(async()=>{await api('admin/'+k,'POST',body);toast('Saved');await load()});\nconst addReward=()=>run(async()=>add('reward',{title:v('rt'),body:v('rb'),cost:v('rc'),min_invites:v('rm'),image_id:await upImg('ri')}));\nconst addTask=()=>run(async()=>add('task',{type:v('tk'),title:v('tt'),body:v('tb'),channel:v('tch'),link:v('tl'),points:v('tp'),image_id:await upImg('ti')}));\nconst saveSet=()=>add('settings',{ad_seconds:v('s1'),invite_points:v('s2'),daily_ad_limit:v('s3'),ad_confirm:v('s4')});\nconst act=(id,st)=>run(async()=>{await api('admin/claim/'+id,'POST',{status:st});await load()});\nconst list=(k,a,g,i)=>a.map(x=>`<div class=\"card row\" style=\"padding:10px 12px\">${tile(i,g)}<span style=\"flex:1;font-weight:700\">${esc(x.title)}</span><button class=\"bad\" onclick=\"del('${k}',${x.id})\">${ic('trash')}</button></div>`).join('');\nfunction tkChange(){const j=v('tk')==='join';$('#tchw').style.display=j?'block':'none';$('#tlw').style.display=j?'none':'block'}\nconst stat=(n,l,g,i)=>`<div class=\"card head\" style=\"flex:1;margin:0\">${tile(i,g)}<div><b style=\"font-size:20px\">${n}</b><div class=\"mut\">${l}</div></div></div>`;\nfunction admin(){if(!A)return '<p class=\"mut\">Loading...</p>';const s=A.settings,pend=(A.claims||[]).filter(c=>c.status==='pending').length;return `\n<div class=\"top\"><div><span>Control center</span><b>Admin</b></div></div>\n<div class=\"row\" style=\"gap:10px\">${stat(A.users,'Users','g5','users')}${stat(pend,'Pending claims','g4','inbox')}</div>\n<h2>${tile('inbox','g4')} Reward claims</h2>${(A.claims||[]).length?(A.claims||[]).map(c=>`<div class=\"card\"><div class=\"row\"><b>${esc(c.title)}</b><span class=\"pill\">${ic('star')}${c.cost}</span></div>\n<div class=\"mut\">${esc(c.name)} ${c.username?'@'+esc(c.username):''} (ID ${c.user_id})</div>\n${c.status==='pending'?`<div class=\"row\" style=\"margin-top:10px\"><button class=\"ok full\" onclick=\"act(${c.id},'approved')\">${ic('check')} Approve</button><button class=\"bad full\" onclick=\"act(${c.id},'rejected')\">${ic('x')} Reject</button></div>`:`<div style=\"margin-top:8px\"><span class=\"st ${c.status}\">${c.status}</span></div>`}</div>`).join(''):`<div class=\"empty\">${tile('inbox','g4')}No claims yet.</div>`}\n<h2>${tile('gift','g2')} Add reward</h2><div class=\"card\"><label>Title</label><input id=\"rt\"><label>Description</label><textarea id=\"rb\" rows=\"3\"></textarea>\n<label>Points needed</label><input id=\"rc\" type=\"number\" min=\"1\"><label>Invites needed (0 = no invites needed)</label><input id=\"rm\" type=\"number\" min=\"0\" value=\"0\"><label>Photo</label><input id=\"ri\" type=\"file\" accept=\"image/*\"><button class=\"full\" onclick=\"addReward()\">${ic('plus')} Save reward</button></div>${list('reward',A.rewards||[],'g2','gift')}\n<h2>${tile('tasks','g1')} Add task</h2><div class=\"card\"><label>Task type</label><select id=\"tk\" onchange=\"tkChange()\"><option value=\"join\">Join a channel</option><option value=\"bot\">Open a bot (photo task)</option></select>\n<label>Title</label><input id=\"tt\"><label>How it works</label><textarea id=\"tb\" rows=\"3\"></textarea>\n<div id=\"tchw\"><label>Channel username (the bot must be admin there)</label><input id=\"tch\" placeholder=\"@mychannel\"></div>\n<div id=\"tlw\" style=\"display:none\"><label>Bot link</label><input id=\"tl\" placeholder=\"https://t.me/somebot\"></div>\n<label>Points</label><input id=\"tp\" type=\"number\" min=\"1\" value=\"5\"><label>Photo (optional)</label><input id=\"ti\" type=\"file\" accept=\"image/*\">\n<button class=\"full\" onclick=\"addTask()\">${ic('plus')} Save task</button></div>${list('task',A.tasks||[],'g1','tasks')}\n<h2>${tile('set','g3')} Settings</h2><div class=\"card\"><label>Seconds to watch an ad</label><input id=\"s1\" type=\"number\" value=\"${s.ad_seconds}\">\n<label>Points for each invited friend</label><input id=\"s2\" type=\"number\" value=\"${s.invite_points}\">\n<label>Max ads per user per day</label><input id=\"s3\" type=\"number\" value=\"${s.daily_ad_limit}\"><label>Require ad confirmation from the bot (1 = yes, 0 = no)</label><input id=\"s4\" type=\"number\" min=\"0\" max=\"1\" value=\"${s.ad_confirm}\"><button class=\"full ok\" onclick=\"saveSet()\">${ic('check')} Save settings</button></div>`}\nload().catch(e=>{$('#app').innerHTML=`<div class=\"center\"><div><h2 style=\"justify-content:center\">Could not load</h2><p class=\"mut\">${esc(e.message)}</p><button onclick=\"location.reload()\">Try again</button></div></div>`});\n</script></body></html>\n"; // the mini app page (same as index.html)
app.get(['/', '/index.html'], (req, res) => res.set('Cache-Control', 'no-store').type('html').send(PAGE));
module.exports = app;
if (require.main === module) app.listen(process.env.PORT || 3000);
