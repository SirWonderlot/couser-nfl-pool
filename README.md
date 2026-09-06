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

## The schedule

`schedule.json` holds the whole season — all 18 weeks, every kickoff, and which
game is the Game of the Week. Both pages and the server read that one file, so
they cannot disagree with each other. Rebuild it with `../make-schedule.py`.

The pick sheet always shows the first week whose deadline has not passed, so it
moves on by itself.

Two things need a human before the end of the season:

* Weeks 16 to 18 have Sunday kickoff times that the NFL has not fixed yet. They
  are held at 1:00 PM, which is also the deadline, so nothing locks wrongly —
  but re-run `make-schedule.py` once the real times are published.
* Week 18 has no Monday night game, so its Game of the Week is a guess. Pick the
  real one by hand once the Sunday night game is announced.

## Trying things out

`public/test-picks.html` and `public/test-grid.html` are a whole week squeezed
into five hours, one hour per slot, sharing a clock the server holds. Nothing
links to them — go straight to the address. `POST /api/test-reset` restarts the
clock and clears that week.
