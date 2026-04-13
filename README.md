# cfpages-note-search

Cloudflare-hosted note search frontend.

Current scope:

- Google OAuth login
- Resolve or create `namespaceId` from D1 table `google_account_bindings`
- Search note recall through `cfworker-vecdocsrv`

Bindings:

- D1:
  - `DB`
  - database id `fbab57bc-cbdf-4e8a-bdba-4665bbe265c8`
- Static assets:
  - `ASSETS`

Required secrets:

```bash
cd apps/cfpages-note-search
npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
```

Recommended `SESSION_SECRET`:

- random high-entropy string, at least 32 bytes

Local commands:

```bash
cd apps/cfpages-note-search
npm install
npx wrangler types
npm run typecheck
npm run dev
```
