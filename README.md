# Sue Couser's NFL Pool

A small Node server in front of a set of static pages.

    public/      the pages, built by ../build-site.py
    server.js    the API and the file server
    render.yaml  the Render blueprint

## Why there is a server at all

Two things cannot be trusted to a browser: **when picks close**, and **who may
see whose sheet**. Both live in `server.js`. A page can only ask; before a week
closes the server hands back your own sheet and nothing else, plus the list of
who has entered.

## Environment

| Variable | What it does |
|---|---|
| `DATABASE_URL` | Postgres. Every table is prefixed `nfl_pool_`, so this can point at a database already in use for something else. Leave it unset and the pool writes `data/pool.json` instead — fine on your own machine, but Render wipes it on every restart. |
| `ADMIN_KEY` | Needed to mark results and to read anyone's contact details. Without it nobody can call a game. |
| `PORT` | Render sets this. |
| `PGSSL` | `on` or `off`. Only needed if the automatic choice is wrong — Render's internal connection string wants SSL off, the external one wants it on, and the code works that out from the host. |

## Running it here

    node server.js                       # writes data/pool.json
    DATABASE_URL=postgres://... node server.js

## The API

| | |
|---|---|
| `GET /api/week/:n?token=` | deadline, whether it is open, the roster, and whatever sheets you are allowed to see |
| `POST /api/entry` | send or change a sheet — refused once the week has closed |
| `POST /api/entry-delete` | drop one of your entries |
| `POST /api/results` | mark winners, needs `x-admin-key` |
| `GET /api/contacts/:n` | names, emails and phones, needs `x-admin-key` |
| `POST /api/test-reset` | restart the test week's clock and clear its entries |

## Adding a week

Only weeks with a real schedule get a tab, so Week 2 appears when you add it.
Four places, all near the top of the relevant file:

1. `server.js` — add the week's deadline to `DEADLINES`. This is the one that
   counts; the pages only display it.
2. `../picks.src.html` — add the games to `GAMES` (each needs `k`, its kickoff)
   and set `DEADLINE` / `DEADLINE_TEXT`. Bump the storage key to `week2`.
3. `../grid.src.html` — add a `W2` list of the same games, put it in
   `GAMES_BY_WEEK`, and add the deadline to `DEADLINES` / `DEADLINE_TEXT`.
4. Run `python3 ../build-site.py`, commit, push.

## Trying things out

`public/test-picks.html` and `public/test-grid.html` are a whole week squeezed
into five hours, one hour per slot, sharing a clock the server holds. Nothing
links to them — go straight to the address. `POST /api/test-reset` restarts the
clock and clears that week.
