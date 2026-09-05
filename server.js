/* Sue Couser's NFL Pool — a small API in front of the static pages.
 *
 * Everything that must not be faked lives here: when picks close, and who is
 * allowed to see whose sheet before that moment. The browser only asks.
 *
 * Environment:
 *   DATABASE_URL  Postgres. Tables are prefixed nfl_pool_, so this can point at
 *                 a database you already use for something else.
 *                 Leave it unset and the pool keeps a JSON file instead, which
 *                 is fine locally but does NOT survive a restart on Render.
 *   ADMIN_KEY     Needed to mark results and to read anyone's contact details.
 *   PORT          Set by Render.
 */
'use strict';
const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT   = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const ADMIN  = process.env.ADMIN_KEY || '';

/* ------------------------------------------------------------ the calendar */
/* Picks for a week close at this moment. Change these each season. */
const DEADLINES = {
  1: '2026-09-13T13:00:00-04:00',
  2: '2026-09-20T13:00:00-04:00',
  3: '2026-09-27T13:00:00-04:00',
  4: '2026-10-04T13:00:00-04:00'
};
const TEST_WEEK = 0;          // the compressed week used for trying things out
const TEST_HOURS = 2;         // picks close two hours after the test clock starts

/* ------------------------------------------------------------ storage */
function fileStore(){
  const dir  = path.join(__dirname, 'data');
  const file = path.join(dir, 'pool.json');
  let db = {entries: [], results: {}, config: {}};
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e){}
  const flush = () => {
    try { fs.mkdirSync(dir, {recursive: true}); fs.writeFileSync(file, JSON.stringify(db, null, 2)); }
    catch(e){ console.error('could not write ' + file, e.message); }
  };
  return {
    kind: 'json file',
    async init(){},
    async entries(week){ return db.entries.filter(e => e.week === week); },
    async save(row){
      const i = db.entries.findIndex(e => e.week === row.week && e.token === row.token && e.team === row.team);
      if(i >= 0) db.entries[i] = Object.assign(db.entries[i], row, {updated_at: new Date().toISOString()});
      else db.entries.push(Object.assign({sent_at: new Date().toISOString(),
                                          updated_at: new Date().toISOString()}, row));
      flush();
    },
    async remove(week, token, team){
      db.entries = db.entries.filter(e => !(e.week === week && e.token === token && e.team === team));
      flush();
    },
    async results(week){ return db.results[week] || {winners: {}, actual: null}; },
    async setResults(week, winners, actual){ db.results[week] = {winners, actual}; flush(); },
    async config(key){ return db.config[key] || null; },
    async setConfig(key, value){ db.config[key] = value; flush(); }
  };
}

function pgStore(){
  const {Pool} = require('pg');
  /* Render gives two connection strings. The internal one has no dot in the
     host and needs no SSL; the external one does. PGSSL=on|off overrides. */
  const url = process.env.DATABASE_URL;
  const host = (url.match(/@([^/:?]+)/) || [,''])[1];
  const forced = (process.env.PGSSL || '').toLowerCase();
  const wantsSsl = forced === 'on'  ? true
                 : forced === 'off' ? false
                 : host.includes('.') && !/^(localhost|127\.0\.0\.1)/.test(host);
  const pool = new Pool({connectionString: url, ssl: wantsSsl ? {rejectUnauthorized: false} : false});
  pool.on('error', e => console.error('postgres pool error:', e.message));
  const q = (text, params) => pool.query(text, params);
  return {
    kind: 'postgres',
    async init(){
      await q(`create table if not exists nfl_pool_entries (
        week int not null, token text not null, team text not null,
        person text, email text, phone text, tiebreak int,
        picks jsonb not null default '{}'::jsonb,
        sent_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (week, token, team))`);
      await q(`create table if not exists nfl_pool_results (
        week int primary key, winners jsonb not null default '{}'::jsonb, actual int)`);
      await q(`create table if not exists nfl_pool_config (
        key text primary key, value text)`);
    },
    async entries(week){
      const r = await q('select * from nfl_pool_entries where week=$1 order by sent_at', [week]);
      return r.rows;
    },
    async save(row){
      await q(`insert into nfl_pool_entries (week,token,team,person,email,phone,tiebreak,picks)
               values ($1,$2,$3,$4,$5,$6,$7,$8)
               on conflict (week,token,team) do update set
                 person=excluded.person, email=excluded.email, phone=excluded.phone,
                 tiebreak=excluded.tiebreak, picks=excluded.picks, updated_at=now()`,
              [row.week,row.token,row.team,row.person,row.email,row.phone,row.tiebreak,
               JSON.stringify(row.picks)]);
    },
    async remove(week, token, team){
      await q('delete from nfl_pool_entries where week=$1 and token=$2 and team=$3', [week,token,team]);
    },
    async results(week){
      const r = await q('select winners, actual from nfl_pool_results where week=$1', [week]);
      return r.rows[0] || {winners: {}, actual: null};
    },
    async setResults(week, winners, actual){
      await q(`insert into nfl_pool_results (week,winners,actual) values ($1,$2,$3)
               on conflict (week) do update set winners=excluded.winners, actual=excluded.actual`,
              [week, JSON.stringify(winners), actual]);
    },
    async config(key){
      const r = await q('select value from nfl_pool_config where key=$1', [key]);
      return r.rows[0] ? r.rows[0].value : null;
    },
    async setConfig(key, value){
      await q(`insert into nfl_pool_config (key,value) values ($1,$2)
               on conflict (key) do update set value=excluded.value`, [key, value]);
    }
  };
}

const store = process.env.DATABASE_URL ? pgStore() : fileStore();

/* ------------------------------------------------------------ the rules */
async function deadlineOf(week){
  if(week === TEST_WEEK){
    let started = await store.config('test_started');
    if(!started){ started = String(Date.now()); await store.setConfig('test_started', started); }
    return new Date(Number(started) + TEST_HOURS*3600*1000);
  }
  return DEADLINES[week] ? new Date(DEADLINES[week]) : null;
}
const isOpen = d => !d || Date.now() < d.getTime();

/* ------------------------------------------------------------ helpers */
function json(res, code, body){
  const s = JSON.stringify(body);
  res.writeHead(code, {'content-type': 'application/json; charset=utf-8',
                       'cache-control': 'no-store',
                       'content-length': Buffer.byteLength(s)});
  res.end(s);
}
function readBody(req){
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if(n > 256*1024){ reject(new Error('too big')); req.destroy(); } chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
                          catch(e){ reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
const clean = (s, max) => typeof s === 'string' ? s.trim().slice(0, max) : '';
const isAdmin = req => ADMIN && req.headers['x-admin-key'] === ADMIN;

/* ------------------------------------------------------------ the API */
async function api(req, res, url){
  const parts = url.pathname.split('/').filter(Boolean);   // ['api', ...]

  if(req.method === 'GET' && parts[1] === 'week'){
    const week = Number(parts[2]);
    if(!Number.isInteger(week)) return json(res, 400, {error: 'bad week'});
    const deadline = await deadlineOf(week);
    const open = isOpen(deadline);
    const token = clean(url.searchParams.get('token'), 80);
    const rows = await store.entries(week);
    const results = await store.results(week);
    return json(res, 200, {
      week,
      deadline: deadline ? deadline.toISOString() : null,
      open,                                    // are picks still changeable
      revealed: !open,                         // can everyone see everyone
      roster: rows.map(r => ({team: r.team, person: r.person, sentAt: r.sent_at})),
      entries: rows
        .filter(r => !open || r.token === token)
        .map(r => ({team: r.team, person: r.person, tie: r.tiebreak,
                    picks: r.picks, mine: r.token === token})),
      results
    });
  }

  if(req.method === 'POST' && parts[1] === 'entry'){
    const b = await readBody(req);
    const week = Number(b.week);
    if(!Number.isInteger(week)) return json(res, 400, {error: 'bad week'});
    const deadline = await deadlineOf(week);
    if(!isOpen(deadline)) return json(res, 409, {error: 'closed', message: 'Picks for this week have closed.'});
    const token = clean(b.token, 80), team = clean(b.team, 60);
    if(!token) return json(res, 400, {error: 'no token'});
    if(!team)  return json(res, 400, {error: 'no team', message: 'Give the entry a team name.'});
    const picks = (b.picks && typeof b.picks === 'object') ? b.picks : {};
    await store.save({week, token, team,
      person: clean(b.person, 80), email: clean(b.email, 120), phone: clean(b.phone, 40),
      tiebreak: Number.isFinite(Number(b.tie)) ? Number(b.tie) : null, picks});
    return json(res, 200, {ok: true});
  }

  if(req.method === 'POST' && parts[1] === 'entry-delete'){
    const b = await readBody(req);
    const week = Number(b.week), deadline = await deadlineOf(week);
    if(!isOpen(deadline)) return json(res, 409, {error: 'closed'});
    await store.remove(week, clean(b.token, 80), clean(b.team, 60));
    return json(res, 200, {ok: true});
  }

  if(req.method === 'POST' && parts[1] === 'results'){
    if(!isAdmin(req)) return json(res, 403, {error: 'not the commissioner'});
    const b = await readBody(req);
    const week = Number(b.week);
    if(!Number.isInteger(week)) return json(res, 400, {error: 'bad week'});
    await store.setResults(week, (b.winners && typeof b.winners === 'object') ? b.winners : {},
                           Number.isFinite(Number(b.actual)) ? Number(b.actual) : null);
    return json(res, 200, {ok: true});
  }

  if(req.method === 'GET' && parts[1] === 'contacts'){
    if(!isAdmin(req)) return json(res, 403, {error: 'not the commissioner'});
    const rows = await store.entries(Number(parts[2]));
    return json(res, 200, {contacts: rows.map(r => ({team: r.team, person: r.person,
                                                     email: r.email, phone: r.phone}))});
  }

  if(req.method === 'POST' && parts[1] === 'test-reset'){
    await store.setConfig('test_started', String(Date.now()));
    for(const r of await store.entries(TEST_WEEK)) await store.remove(TEST_WEEK, r.token, r.team);
    return json(res, 200, {ok: true});
  }

  return json(res, 404, {error: 'no such endpoint'});
}

/* ------------------------------------------------------------ static files */
const TYPES = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.png':'image/png', '.json':'application/json',
  '.txt':'text/plain; charset=utf-8', '.svg':'image/svg+xml', '.ico':'image/x-icon'};
function serveFile(res, file){
  fs.readFile(file, (err, buf) => {
    if(err){ res.writeHead(404, {'content-type':'text/plain'}); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {'content-type': TYPES[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
      'x-robots-tag': 'noindex, nofollow'});
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if(url.pathname.startsWith('/api/')){
    api(req, res, url).catch(e => { console.error(e); json(res, 500, {error: 'server error'}); });
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if(rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC, rel);
  if(!file.startsWith(PUBLIC)){ res.writeHead(403); return res.end('No'); }
  serveFile(res, file);
});

store.init()
  .then(() => server.listen(PORT, () => {
    console.log('NFL pool listening on ' + PORT + ' (storage: ' + store.kind + ')');
    if(store.kind === 'json file')
      console.log('WARNING: no DATABASE_URL, so entries are kept in a file that Render wipes on restart.');
    if(!ADMIN) console.log('WARNING: ADMIN_KEY is not set, so results cannot be marked.');
  }))
  .catch(e => { console.error('could not start:', e.message); process.exit(1); });
