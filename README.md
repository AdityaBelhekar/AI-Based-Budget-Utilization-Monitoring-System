# Budget Utilization Monitor

A MEAN stack app (Angular, Express, MongoDB) that tracks budget allocation against spending, flags money that is off pace, and keeps an audit trail of every change. Requirements and design are in the [PRD](https://claude.ai/artifact/VD9GBWmrNzNfG3n1h9524r).

The data is real: 90 months of Union Government figures (April 2019 to September 2026) from the Controller General of Accounts, in [`data/cga-monthly.csv`](data/cga-monthly.csv). Each row links to its source page, and `node data/extract-cga.mjs <cache folder>` rebuilds the file from cga.gov.in.

## Run locally

Needs Node 22 or later. No MongoDB install is needed: development uses an in-memory database that is seeded on start and wiped on restart.

```bash
npm ci --prefix server
npm ci --prefix client
npm run build --prefix client
npm run dev --prefix server
```

Open http://localhost:3000. The dev-only accounts are in [`server/.env.example`](server/.env.example): one Admin, one Finance Officer, and one Department Head for Petroleum Subsidy.

For live reload while working on the UI, also run `npm start --prefix client` and open http://localhost:4200.

## Test

```bash
npm test --prefix server
```

The suite covers every role on every route, each detection rule at and around its threshold, the PRD's worked example, reconciliation of the seeded data to the paisa, and the report files.

## Deploy: MongoDB Atlas

1. Sign in at [cloud.mongodb.com](https://cloud.mongodb.com) and create a project.
2. **Create a cluster:** choose the free tier, AWS, and the Mumbai region (ap-south-1). That puts the database next to the Vercel functions, which run in Mumbai (`bom1`).
3. **Database Access:** add a database user with a generated password and the role "Read and write to any database". Keep the password.
4. **Network Access:** add `0.0.0.0/0` (allow from anywhere). Vercel functions have no fixed IP address, so this is required on Vercel's free plan. The database is still protected by the user's password and TLS.
5. **Connect, then Drivers:** copy the connection string and add the database name `budget` after `.net/`:
   `mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/budget?retryWrites=true&w=majority`
   If the password contains `@ : / ? # [ ]` or `%`, URL-encode it, or generate one without them.
6. **Load the data and create accounts** from your own machine, in PowerShell from this folder:

```powershell
npm ci --prefix server
$env:MONGODB_URI = "mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/budget?retryWrites=true&w=majority"
npm run seed:data --prefix server
$env:SEED_ADMIN_EMAIL = "you@example.com"; $env:SEED_ADMIN_PASSWORD = "a password of 12 or more characters"
$env:DEMO_FINANCE_EMAIL = "finance@example.com"; $env:DEMO_FINANCE_PASSWORD = "another strong password"
$env:DEMO_HEAD_EMAIL = "head@example.com"; $env:DEMO_HEAD_PASSWORD = "another strong password"
npm run seed:users --prefix server
```

`seed:data` loads the CGA figures in one database transaction, checks that every total reconciles, then replays the history to raise alerts. It prints `Seeded 90 months; totals reconcile`. If it fails with an error about transactions, the cluster does not support them; tell me before going further. Both seed commands are safe to run again. The demo accounts are optional, but reviewers need one per role to see the role rules at work.

## Deploy: Vercel

1. Push this repository to GitHub.
2. At [vercel.com/new](https://vercel.com/new), import the repository. Leave the framework preset as "Other" and the root directory as it is; `vercel.json` sets the build.
3. Under **Environment Variables**, add these three:

| Name | Value |
| --- | --- |
| `MONGODB_URI` | The Atlas connection string from step 5 above |
| `SESSION_SECRET` | A long random value, made with the command below |
| `CRON_SECRET` | Another long random value, made the same way |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

4. Deploy, then open `https://YOUR-PROJECT.vercel.app/api/health`. It should show `{"status":"ok"}`.
5. Sign in with the Admin account from the seed step.

Vercel runs the daily detection scan at 06:00 India time from the `crons` entry in `vercel.json`, sending `CRON_SECRET` with each call. Uploaded documents are limited to 4 MB, because Vercel rejects request bodies over 4.5 MB.

## How it is put together

| Folder | Holds |
| --- | --- |
| `client/` | Angular app: seven pages plus sign-in, hand-drawn SVG charts, and light and dark themes |
| `server/src/` | Express API, detection rules (`detection.js`), scanning (`monitor.js`) and seed scripts |
| `api/index.js` | Vercel's entry point; it runs the same Express app as a serverless function |
| `data/` | The CGA extract and the script that builds it |
