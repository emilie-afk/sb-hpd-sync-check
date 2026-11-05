# Security and configuration

The dashboard compares the HPD catalog and inventory with the Products Master
sheet and the Succulents Box storefront. All data access happens in Netlify
Functions, after a server-verified session.

## How access works

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/login` | POST `{ "password": "…" }` | Checks the shared password on the server and sets the session cookie |
| `/api/session` | GET | Tells the page whether the cookie is still valid (page reloads) |
| `/api/check` | POST `{}` | Runs the comparison. Requires a valid session; nothing is fetched otherwise |
| `/api/logout` | POST | Revokes the session on the server and clears the cookie |

- The password is sent once, at login. The browser keeps only an
  `HttpOnly; Secure; SameSite=Strict` cookie (`__Host-hpd_session`) that page
  scripts cannot read.
- The cookie is HMAC-signed with `SESSION_SECRET` and carries an expiry
  (`SESSION_TTL_HOURS`, default 12) that the server enforces.
- POST endpoints require the `X-HPD-Request: 1` header and a same-origin
  `Origin`/`Sec-Fetch-Site`, in addition to the SameSite cookie (CSRF).
- Login failures are limited per client IP and globally
  (`LOGIN_MAX_FAILURES_*` per `LOGIN_WINDOW_MINUTES`). Checks are limited per
  session and globally, only one check runs at a time, and a complete result
  is reused for `CHECK_CACHE_SECONDS`. These limits, revoked sessions and the
  cached result live in a private Netlify Blobs store
  (`hpd-sync-check-security`), so they hold across function invocations.
- Missing or invalid authentication settings deny every request. Missing
  source settings return a configuration error to signed-in users; there is no
  built-in fallback sheet.
- Sheet locations and the API key exist only in server environment variables.
  They are never sent to the browser or written to logs.

## Environment variables

Set these in Netlify → Site configuration → Environment variables, with
scope **Functions** only, and mark them as secret. Do not put real values in
`netlify.toml`, the repository or any `.env` file that is committed. There is
no build step, so nothing is written into the published files.

| Name | Required | Notes |
| --- | --- | --- |
| `SITE_PASSWORD` | yes | Shared team password |
| `SESSION_SECRET` | yes | Random, at least 32 characters, different from the password |
| `GOOGLE_SHEETS_API_KEY` | yes | Google Sheets API key (restrict it to the Sheets API in Google Cloud) |
| `HPD_INVENTORY_SHEET_ID` | yes | Spreadsheet ID of the HPD inventory sheet (tab `Inventory`, columns A:C) |
| `PRODUCTS_MASTER_SHEET_ID` | yes | Spreadsheet ID of the Products Master sheet |
| `PRODUCTS_MASTER_TAB_GID` | yes | Numeric `gid` of the Products Master tab. Its first row must contain the headers `HD SKU` and `Shopify Uploaded Listing` (each exactly once, any position) |
| `SESSION_EPOCH` | no | Any string; change it to sign everyone out |
| `SESSION_TTL_HOURS` | no | 1–168, default 12 |
| `LOGIN_MAX_FAILURES_PER_IP` / `LOGIN_MAX_FAILURES_GLOBAL` / `LOGIN_WINDOW_MINUTES` | no | Defaults 10 / 100 / 15 |
| `CHECK_BUDGET_MS` | no | Total time for one check, including every upstream response. Default 9000. Keep it below the function timeout set in the Netlify UI |
| `CHECK_CACHE_SECONDS` | no | Default 30; 0 disables reuse |
| `CHECK_MAX_PER_SESSION` / `CHECK_MAX_GLOBAL` / `CHECK_WINDOW_MINUTES` | no | Defaults 10 / 40 / 10 |

See `.env.example` for a placeholder template.

## Signing people out

- **One person:** "Sign out" revokes that session on the server; a copied
  cookie stops working. The page only returns to the login screen after the
  server confirms the sign-out; if it fails, the page says so and the person
  can try again. A check still in progress is cancelled and its result is
  discarded.
- **Everyone:** change `SESSION_EPOCH` (or `SESSION_SECRET`) and redeploy.
- **Password change:** set a new `SITE_PASSWORD` and redeploy. Every session
  issued under the old password is rejected, because each session is bound to
  a keyed fingerprint of the password that issued it.

Environment-variable changes take effect on the next deploy.

**Do not delete the `hpd-sync-check-security` Blobs store (or its `revoked/`
entries) while sessions may still be valid.** It holds the sign-out
revocations; deleting it makes copied, unexpired cookies work again. To clear
it safely: first change `SESSION_EPOCH` or rotate `SESSION_SECRET`, deploy,
make sure no other deploy that accepts the old sessions can still be served
(for example an older deploy you could roll back to, or a branch deploy using
the same variables), and only then delete the store.

## Outbound requests

Only HTTPS requests to `houseplantdropship.com`, `sheets.googleapis.com` and
`succulentsbox.com` (and their `www.` hosts) are made, including after
redirects. One overall time budget covers every request and response body;
bodies are size-capped; transient failures are retried once. If the HPD
catalog, inventory sheet or Products Master sheet cannot be read completely,
or the configured Products Master tab (`PRODUCTS_MASTER_TAB_GID`) is not found,
no comparison is returned; another tab is never used instead. A storefront
page whose data is malformed (no variants, or a variant without a true/false
`available`) is treated as "Could not verify", never as out of stock. Storefront checks that fail are listed as
"Could not verify" and the result is marked incomplete rather than counting
those products as missing.

## Published files

Only `public/` is published (`index.html`, `app.js`, `robots.txt`). Server
code, tests and configuration are not served.

## Tests

```
npm install
npm test               # unit + integration tests (synthetic data, mocked services)
npm run test:browser   # Playwright/Chromium checks against a local stand-in server
```

Tests use fictional sheet IDs and keys and never contact real services.
