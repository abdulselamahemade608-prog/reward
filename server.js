// Rewards Bot: Express API + Telegram webhook. Deploy on Vercel, DB on Neon.
// ENV: DATABASE_URL, BOT_TOKEN, BOT_USERNAME (without @), APP_URL (https://your-app.vercel.app), ADMIN_IDS (comma separated Telegram IDs)
const express = require('express'), crypto = require('crypto'), path = require('path'), { Pool } = require('pg');
const app = express();
app.use(express.json({ limit: '6mb' }));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
const q = (t, p) => pool.query(t, p);
const BOT = process.env.BOT_TOKEN;
const ADMINS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const tg = (m, b) => fetch(`https://api.telegram.org/bot${BOT}/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()).catch(() => ({}));
const wrap = f => (req, res) => f(req, res).catch(e => res.status(500).json({ error: e.message }));
const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id BIGINT PRIMARY KEY, name TEXT, username TEXT, points INT NOT NULL DEFAULT 0, invited_by BIGINT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS images(id SERIAL PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ads(id SERIAL PRIMARY KEY, title TEXT, body TEXT, image_id INT, link TEXT, active BOOL DEFAULT true);
CREATE TABLE IF NOT EXISTS ad_views(token TEXT PRIMARY KEY, user_id BIGINT, ad_id INT, started TIMESTAMPTZ DEFAULT now(), done BOOL DEFAULT false);
CREATE TABLE IF NOT EXISTS rewards(id SERIAL PRIMARY KEY, title TEXT, body TEXT, image_id INT, cost INT, active BOOL DEFAULT true);
CREATE TABLE IF NOT EXISTS claims(id SERIAL PRIMARY KEY, user_id BIGINT, reward_id INT, title TEXT, cost INT, status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS tasks(id SERIAL PRIMARY KEY, type TEXT, title TEXT, body TEXT, image_id INT, channel TEXT, link TEXT, points INT, active BOOL DEFAULT true);
CREATE TABLE IF NOT EXISTS task_done(user_id BIGINT, task_id INT, PRIMARY KEY(user_id, task_id));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);`;
let ready; const init = () => ready || (ready = q(SCHEMA));
app.use((req, res, next) => init().then(() => next(), next));

const DEF = { ad_seconds: 5, invite_points: 5, daily_ad_limit: 100 };
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
const auth = async (req, res, next) => {
  try {
    const u = verify(req.headers['x-init']);
    if (!u) return fail(res, 'Open this app from Telegram', 401);
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
    const ins = await q('INSERT INTO users(id,name,username) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=$2, username=$3 RETURNING (xmax=0) AS fresh', [u.id, name, u.username || null]);
    const ref = Number(req.headers['x-ref']);
    if (ins.rows[0].fresh && ref && ref !== u.id) {
      const inv = await q('SELECT 1 FROM users WHERE id=$1', [ref]);
      if (inv.rowCount) {
        await q('UPDATE users SET invited_by=$1 WHERE id=$2', [ref, u.id]);
        const s = await settings();
        await q('UPDATE users SET points=points+$1 WHERE id=$2', [s.invite_points, ref]);
        tg('sendMessage', { chat_id: ref, text: `${name} joined with your link. +${s.invite_points} points!` });
      }
    }
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

app.post('/api/webhook', wrap(async (req, res) => {
  const m = req.body.message;
  if (m && m.text && m.text.startsWith('/start')) {
    const ref = (m.text.split(' ')[1] || '').replace('ref_', '');
    await tg('sendMessage', { chat_id: m.chat.id, text: 'Welcome! Watch ads, finish tasks and earn points. Trade points for rewards.',
      reply_markup: { inline_keyboard: [[{ text: 'Open app', web_app: { url: process.env.APP_URL + (ref ? '/?ref=' + ref : '') } }]] } });
  }
  res.json({ ok: true });
}));

// ---- User API ----
app.get('/api/home', auth, wrap(async (req, res) => {
  const [me, rewards, tasks, s] = await Promise.all([
    q('SELECT points FROM users WHERE id=$1', [req.u.id]),
    q('SELECT id,title,body,image_id,cost FROM rewards WHERE active ORDER BY cost'),
    q('SELECT t.id,t.type,t.title,t.body,t.image_id,t.channel,t.link,t.points,(d.user_id IS NOT NULL) AS done FROM tasks t LEFT JOIN task_done d ON d.task_id=t.id AND d.user_id=$1 WHERE t.active ORDER BY t.id DESC', [req.u.id]),
    settings()]);
  res.json({ me: req.u.id, admin: req.admin, bot: process.env.BOT_USERNAME, points: me.rows[0].points, rewards: rewards.rows, tasks: tasks.rows, invite_points: s.invite_points });
}));

app.get('/api/ad/next', auth, wrap(async (req, res) => {
  const s = await settings();
  const c = await q("SELECT count(*) FROM ad_views WHERE user_id=$1 AND done AND started>now()-interval '24 hours'", [req.u.id]);
  if (Number(c.rows[0].count) >= s.daily_ad_limit) return fail(res, 'Daily ad limit reached. Come back tomorrow.');
  const a = (await q('SELECT * FROM ads WHERE active ORDER BY random() LIMIT 1')).rows[0];
  if (!a) return fail(res, 'No ads right now. Check back soon.');
  const token = crypto.randomBytes(12).toString('hex');
  await q('INSERT INTO ad_views(token,user_id,ad_id) VALUES($1,$2,$3)', [token, req.u.id, a.id]);
  res.json({ ad: a, token, seconds: s.ad_seconds });
}));

app.post('/api/ad/done', auth, wrap(async (req, res) => {
  const s = await settings();
  const r = await q("UPDATE ad_views SET done=true WHERE token=$1 AND user_id=$2 AND NOT done AND started<now()-($3||' seconds')::interval RETURNING 1", [req.body.token, req.u.id, String(s.ad_seconds)]);
  if (!r.rowCount) return fail(res, 'Watch the full ad to earn the point.');
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

app.post('/api/reward/:id/claim', auth, wrap(async (req, res) => {
  const r = (await q('SELECT * FROM rewards WHERE id=$1 AND active', [Number(req.params.id)])).rows[0];
  if (!r) return fail(res, 'Reward not found', 404);
  const u = await q('UPDATE users SET points=points-$1 WHERE id=$2 AND points>=$1 RETURNING points', [r.cost, req.u.id]);
  if (!u.rowCount) return fail(res, 'Not enough points yet.');
  await q('INSERT INTO claims(user_id,reward_id,title,cost) VALUES($1,$2,$3,$4)', [req.u.id, r.id, r.title, r.cost]);
  const who = req.u.username ? '@' + req.u.username : req.u.first_name;
  ADMINS.forEach(a => tg('sendMessage', { chat_id: a, text: `New claim: ${r.title} (${r.cost} pts) by ${who} (ID ${req.u.id}). Open the admin tab to approve.` }));
  res.json({ ok: true });
}));

// ---- Admin API ----
const ad = [auth, adminOnly];
app.post('/api/admin/image', ad, wrap(async (req, res) => {
  const r = await q('INSERT INTO images(data) VALUES($1) RETURNING id', [String(req.body.data || '')]);
  res.json({ id: r.rows[0].id });
}));
app.get('/api/admin/data', ad, wrap(async (req, res) => {
  const [ads, rewards, tasks, claims, users, s] = await Promise.all([
    q('SELECT * FROM ads WHERE active ORDER BY id DESC'), q('SELECT * FROM rewards WHERE active ORDER BY id DESC'),
    q('SELECT * FROM tasks WHERE active ORDER BY id DESC'),
    q("SELECT c.*,u.name,u.username FROM claims c JOIN users u ON u.id=c.user_id ORDER BY (c.status='pending') DESC, c.id DESC LIMIT 50"),
    q('SELECT count(*) FROM users'), settings()]);
  res.json({ ads: ads.rows, rewards: rewards.rows, tasks: tasks.rows, claims: claims.rows, users: Number(users.rows[0].count), settings: s });
}));
app.post('/api/admin/reward', ad, wrap(async (req, res) => {
  const b = req.body; await q('INSERT INTO rewards(title,body,image_id,cost) VALUES($1,$2,$3,$4)', [b.title, b.body, b.image_id || null, Number(b.cost) || 1]); res.json({ ok: true });
}));
app.post('/api/admin/ad', ad, wrap(async (req, res) => {
  const b = req.body; await q('INSERT INTO ads(title,body,image_id,link) VALUES($1,$2,$3,$4)', [b.title, b.body, b.image_id || null, b.link || null]); res.json({ ok: true });
}));
app.post('/api/admin/task', ad, wrap(async (req, res) => {
  const b = req.body; let ch = (b.channel || '').trim(), link = (b.link || '').trim();
  if (b.type === 'join') { if (!ch) return fail(res, 'Channel username is required'); ch = '@' + ch.replace(/^@|^https?:\/\/t\.me\//, ''); link = 'https://t.me/' + ch.slice(1); }
  await q('INSERT INTO tasks(type,title,body,image_id,channel,link,points) VALUES($1,$2,$3,$4,$5,$6,$7)', [b.type, b.title, b.body, b.image_id || null, ch || null, link || null, Number(b.points) || 1]);
  res.json({ ok: true });
}));
app.delete('/api/admin/:kind/:id', ad, wrap(async (req, res) => {
  const t = { ad: 'ads', reward: 'rewards', task: 'tasks' }[req.params.kind];
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

app.use(express.static(path.join(__dirname, 'public')));
module.exports = app;
if (require.main === module) app.listen(process.env.PORT || 3000);
