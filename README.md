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

## Setting up a new week

`DEADLINES` at the top of `server.js` must match the deadline in
`public/picks.html`, and the `GAMES` list in `picks.html` must match the one in
`grid.html`. The server is the one that counts — the pages only display it.
