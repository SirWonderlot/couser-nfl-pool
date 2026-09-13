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
 *   SCORES        'off' to stop the scoreboard being read at all, so the week
 *                 is marked only by hand. Anything else leaves it on.
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
/* Picks close when schedule.json says they do. The pages read the same file,
   so the server and the browser can never disagree about the deadline. */
const SCHEDULE = JSON.parse(fs.readFileSync(path.join(__dirname, 'schedule.json'), 'utf8'));
const DEADLINES = Object.fromEntries(
  Object.values(SCHEDULE).map(w => [w.n, w.deadline]));

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
    async tables(){
      const t = await q(`select tablename from pg_tables where schemaname='public' order by tablename`);
      const all = t.rows.map(r => r.tablename);
      return {mine: all.filter(n => n.startsWith('nfl_pool_')),
              others: all.filter(n => !n.startsWith('nfl_pool_'))};
    },
    async init(){
      /* Say plainly what is already in here, so nobody has to guess whether a
         database is spare or is carrying another project. */
      try{
        const t = await q(`select tablename from pg_tables where schemaname='public' order by tablename`);
        const all = t.rows.map(r => r.tablename);
        const others = all.filter(n => !n.startsWith('nfl_pool_'));
        const mine   = all.filter(n =>  n.startsWith('nfl_pool_'));
        console.log('--- database check ---');
        console.log(others.length === 0
          ? 'This database is EMPTY apart from the pool. Nothing else is using it.'
          : 'This database already holds ' + others.length + ' table(s) belonging to something else:');
        if(others.length) console.log('  ' + others.slice(0, 40).join(', ') + (others.length > 40 ? ' ...' : ''));
        console.log(mine.length ? 'Pool tables already present: ' + mine.join(', ')
                                : 'Pool tables not there yet, creating them now.');
        console.log('The pool only ever touches tables named nfl_pool_*.');
        console.log('----------------------');
      }catch(e){ console.log('could not list tables:', e.message); }

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

/* --------------------------------------------------- calling the games
   ESPN publish a public scoreboard. We read it, and for any game that has
   actually finished we set the winner -- but never over the top of one Sue has
   marked herself. Her tap is deliberate; a scoreboard we do not control is
   not, so hers wins and stays won.

   Which games she has touched is kept in the config table under manual:<week>,
   which means no change to the results table and the same behaviour whether
   the pool is on Postgres or the local JSON file. */
const SCORES_ON = (process.env.SCORES || '').toLowerCase() !== 'off';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=';

/* ESPN spell four of the teams differently from the schedule. */
const ESPN_FIX = {WSH:'WAS', JAC:'JAX', LVR:'LV', LA:'LAR'};
const fixAb = s => { const a = String(s||'').toUpperCase(); return ESPN_FIX[a] || a; };

/* the calendar days a week's games fall on, in US Eastern, as YYYYMMDD */
function daysOf(week){
  const w = SCHEDULE[week]; if(!w) return [];
  const out = new Set();
  for(const g of w.games){
    const d = new Date(g.k);
    out.add(new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York',
      year:'numeric', month:'2-digit', day:'2-digit'}).format(d).replace(/-/g, ''));
  }
  return [...out].sort();
}

async function espnDay(day){
  const r = await fetch(ESPN + day, {headers:{'accept':'application/json'}});
  if(!r.ok) throw new Error('scoreboard ' + day + ' returned ' + r.status);
  return r.json();
}

/* every finished game on those days, as away/home/scores */
async function finalsFor(week){
  const out = [];
  for(const day of daysOf(week)){
    let data;
    try { data = await espnDay(day); }
    catch(e){ console.log('scores: ' + e.message); continue; }
    for(const ev of (data.events || [])){
      const c = (ev.competitions || [])[0]; if(!c) continue;
      const st = (c.status || {}).type || {};
      if(!st.completed) continue;                       /* still being played */
      const side = {};
      for(const t of (c.competitors || [])) side[t.homeAway] = t;
      if(!side.home || !side.away) continue;
      out.push({
        home: fixAb(side.home.team && side.home.team.abbreviation),
        away: fixAb(side.away.team && side.away.team.abbreviation),
        homeScore: Number(side.home.score), awayScore: Number(side.away.score),
        winner: side.home.winner ? fixAb(side.home.team.abbreviation)
              : side.away.winner ? fixAb(side.away.team.abbreviation)
              : null                                    /* a tie has no winner */
      });
    }
  }
  return out;
}

const lastLook = {};        /* week -> when the scoreboard was last read */
const LOOK_EVERY = 60*1000;

async function readScores(week, force){
  if(!SCORES_ON || !SCHEDULE[week]) return false;
  if(!force && lastLook[week] && Date.now() - lastLook[week] < LOOK_EVERY) return false;
  lastLook[week] = Date.now();

  const finals = await finalsFor(week);
  if(!finals.length) return false;

  const cur = await store.results(week);
  const winners = Object.assign({}, cur.winners || {});
  let actual = cur.actual, changed = false;

  let manual = {};
  try { manual = JSON.parse(await store.config('manual:' + week) || '{}'); } catch(e){}

  /* Games she settled herself that the final score disagrees with. Her mark
     stands -- but saying nothing would let a wrong result ride, so the page is
     told and she can decide. */
  const argue = [];
  for(const g of SCHEDULE[week].games){
    const f = finals.find(x => x.home === g.h && x.away === g.a);
    if(!f) continue;
    if(manual[g.id] && f.winner && winners[g.id] && winners[g.id] !== f.winner){
      argue.push({game:g.id, yours:winners[g.id], scoreboard:f.winner,
                  score: g.a + ' ' + f.awayScore + ' at ' + g.h + ' ' + f.homeScore});
    }
    if(!manual[g.id] && f.winner && winners[g.id] !== f.winner){
      winners[g.id] = f.winner; changed = true;
    }
    /* the tiebreak is both scores added, so the Game of the Week gives it */
    if(g.gotw && !manual.__actual && Number.isFinite(f.homeScore + f.awayScore)){
      const total = f.homeScore + f.awayScore;
      if(actual !== total){ actual = total; changed = true; }
    }
  }
  /* If the Game of the Week has not finished, nobody can be a distance from a
     total that does not exist yet. A leftover value here counts as everyone
     being that far out and would settle a level week on nothing. */
  const gotw = SCHEDULE[week].games.find(g => g.gotw);
  const gotwDone = gotw && finals.some(x => x.home === gotw.h && x.away === gotw.a);
  if(!gotwDone && !manual.__actual && actual != null){ actual = null; changed = true; }

  await store.setConfig('argue:' + week, JSON.stringify(argue));
  if(argue.length) console.log('scores: week ' + week + ' -- ' + argue.length
    + ' game(s) marked by hand disagree with the final score: '
    + argue.map(a => a.game + ' (' + a.yours + ' vs ' + a.scoreboard + ')').join(', '));
  if(changed){
    await store.setResults(week, winners, actual);
    console.log('scores: week ' + week + ' now has ' + Object.keys(winners).length
                + ' of ' + SCHEDULE[week].games.length + ' games called'
                + (actual == null ? '' : ', Game of the Week total ' + actual));
  }
  return changed;
}

/* the week whose games are being played now, give or take */
function liveWeek(){
  const now = Date.now();
  const weeks = Object.values(SCHEDULE).map(w => w.n).sort((a,b)=>a-b);
  for(const n of weeks){
    const end = new Date(DEADLINES[n]).getTime() + 40*3600*1000;   /* through Monday night */
    if(now < end) return n;
  }
  return weeks[weeks.length - 1];
}

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
    /* a closed week may have finished games the scoreboard can call for us */
    if(!open){ try { await readScores(week); } catch(e){ console.log('scores:', e.message); } }
    const token = clean(url.searchParams.get('token'), 80);
    const rows = await store.entries(week);
    const results = await store.results(week);
    return json(res, 200, {
      week,
      deadline: deadline ? deadline.toISOString() : null,
      open,                                    // are picks still changeable
      revealed: !open,                         // can everyone see everyone
      disputed: await (async () => {
        try { return JSON.parse(await store.config('argue:' + week) || '[]'); }
        catch(e){ return []; }
      })(),
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
    if(!isAdmin(req)) return json(res, 403, {error: 'wrong password', message: 'That password is not right.'});
    const b = await readBody(req);
    const week = Number(b.week);
    if(!Number.isInteger(week)) return json(res, 400, {error: 'bad week'});
    /* Number(null) is 0, so an unset total used to be stored as a real zero --
       which then counted as everyone's tiebreak being that far out. */
    const actual = (b.actual === null || b.actual === undefined || b.actual === '' ||
                    !Number.isFinite(Number(b.actual))) ? null : Number(b.actual);
    await store.setResults(week, (b.winners && typeof b.winners === 'object') ? b.winners : {}, actual);

    /* Remember what she settled by hand, so the scoreboard leaves it alone.
       Clearing the week forgets all of it and hands the week back to the
       scoreboard. */
    let manual = {};
    try { manual = JSON.parse(await store.config('manual:' + week) || '{}'); } catch(e){}
    if(b.manualClear) manual = {};
    if(b.manualGame)  manual[clean(b.manualGame, 20)] = true;
    if(b.manualActual) manual.__actual = true;
    await store.setConfig('manual:' + week, JSON.stringify(manual));
    return json(res, 200, {ok: true});
  }

  if(req.method === 'GET' && parts[1] === 'contacts'){
    if(!isAdmin(req)) return json(res, 403, {error: 'wrong password', message: 'That password is not right.'});
    const rows = await store.entries(Number(parts[2]));
    return json(res, 200, {contacts: rows.map(r => ({team: r.team, person: r.person,
                                                     email: r.email, phone: r.phone}))});
  }

  if(req.method === 'GET' && parts[1] === 'health'){
    if(!isAdmin(req)) return json(res, 403, {error: 'wrong password', message: 'That password is not right.'});
    let tables = null;
    if(store.tables){ try { tables = await store.tables(); } catch(e){ tables = 'unavailable'; } }
    return json(res, 200, {storage: store.kind, adminKeySet: !!ADMIN, tables});
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
  if(rel === '/') rel = '/picks.html';        /* the front door is the pick sheet */
  else if(rel.endsWith('/')) rel += 'index.html';
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
    if(!SCORES_ON) console.log('Scoreboard reading is off; the week is marked only by hand.');
    else {
      /* This machine stays awake, so the games can be called as they finish
         rather than waiting for somebody to open the page. Every five minutes
         is far more often than games actually end. */
      const look = () => readScores(liveWeek()).catch(e => console.log('scores:', e.message));
      setTimeout(look, 10*1000);
      setInterval(look, 5*60*1000);
      console.log('Watching the scoreboard for week ' + liveWeek() + ', every 5 minutes.');
    }
  }))
  .catch(e => { console.error('could not start:', e.message); process.exit(1); });
