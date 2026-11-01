# Budget Utilization Monitor

Angular, Express and MongoDB app that tracks budget allocation against spending and flags what is off pace. Requirements live in the [PRD](https://claude.ai/artifact/VD9GBWmrNzNfG3n1h9524r).

## Run locally

Needs Node 22 or later. No MongoDB install is needed: dev uses an in-memory database that is wiped on restart.

```bash
npm ci --prefix server
npm ci --prefix client
npm run build --prefix client
npm run dev --prefix server
```

Open http://localhost:3000 and sign in with the dev-only admin in `server/.env.example`.

For live reload while working on the UI, also run `npm start --prefix client` and use http://localhost:4200.

## Test

```bash
npm test --prefix server
```

## Deploy on Render

1. Create a MongoDB Atlas cluster and copy its connection string.
2. Create a Render Blueprint from this repo; it reads `render.yaml` and asks for `MONGODB_URI`.
3. Create the first Admin once, from your own machine, using a strong password of your own:

```bash
MONGODB_URI="..." SEED_ADMIN_EMAIL="..." SEED_ADMIN_PASSWORD="..." npm run seed:admin --prefix server
```
