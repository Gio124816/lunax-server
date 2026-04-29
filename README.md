# Luna X — Backend API

The server that powers Luna X for every user. Handles all Meta API calls, AI generation, post scheduling, and OAuth — so users just click "Connect Meta" and everything works. 

---

## Deploy in 10 minutes

### Step 1 — Push to GitHub

1. Go to github.com → New repository → name it `lunax-server`
2. Upload all these files (or use git push)

### Step 2 — Deploy to Railway

1. Go to **railway.app** → New Project → Deploy from GitHub repo
2. Select `lunax-server`
3. Railway auto-detects Node.js and deploys

### Step 3 — Add environment variables in Railway

In your Railway project → Variables tab, add:

| Variable | Value |
|---|---|
| `META_APP_ID` | `4130512623865738` |
| `META_APP_SECRET` | Your app secret from Meta Developer Portal |
| `META_REDIRECT_URI` | `https://YOUR-RAILWAY-URL.up.railway.app/auth/meta/callback` |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `SESSION_SECRET` | Any long random string |
| `FRONTEND_URL` | URL where lunax.html is hosted |
| `NODE_ENV` | `production` |

### Step 4 — Update Meta App settings

1. Go to developers.facebook.com → Luna X app
2. Facebook Login → Settings → Valid OAuth Redirect URIs
3. Add: `https://YOUR-RAILWAY-URL.up.railway.app/auth/meta/callback`

### Step 5 — Update lunax.html

In lunax.html, set the API URL at the top of the script:
```js
const LUNAX_API = 'https://YOUR-RAILWAY-URL.up.railway.app';
```

### Step 6 — Test

Open your Luna X frontend URL → click "Connect Meta" → OAuth flow runs → you're in.

---

## API Endpoints

### Auth
| Method | Path | Description |
|---|---|---|
| GET | `/auth/meta` | Start Meta OAuth flow |
| GET | `/auth/meta/callback` | OAuth callback (Meta redirects here) |
| GET | `/auth/me` | Get current user + accounts |
| POST | `/auth/disconnect` | Disconnect Meta account |

### Meta API Proxy
| Method | Path | Description |
|---|---|---|
| GET | `/meta/accounts` | Get user's pages + ad accounts |
| GET | `/meta/pages/:pageId/leadgen_forms` | Get lead forms with real lead counts |
| GET | `/meta/ads/campaigns` | Get campaigns with insights |
| GET | `/meta/ads/adsets` | Get ad sets with insights |
| GET | `/meta/ads/creatives` | Get ad creatives |
| GET | `/meta/ads/insights` | Daily insights for chart |
| POST | `/meta/ads/adsets/create` | Create new ad set |
| POST | `/meta/ads/creatives/create` | Create ad creative |
| POST | `/meta/ads/ads/create` | Create ad |
| POST | `/meta/post` | Publish/schedule post to Meta |

### AI
| Method | Path | Description |
|---|---|---|
| POST | `/ai/caption` | Generate post caption |
| POST | `/ai/bulk-captions` | Generate captions for multiple files |
| POST | `/ai/edit-plan` | Generate video edit plan |
| POST | `/ai/ads-insights` | Analyze campaign data |
| POST | `/ai/ads-feedback` | Diagnose ad problems |
| POST | `/ai/build-ad` | Build ad set from diagnosis |
| POST | `/ai/refine-ad` | Apply command to modify ad plan |

### Posts
| Method | Path | Description |
|---|---|---|
| GET | `/posts` | Get all scheduled posts |
| POST | `/posts` | Create scheduled post |
| PATCH | `/posts/:id` | Update post |
| DELETE | `/posts/:id` | Delete post |

### Utility
| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |

---

## How authentication works for users

1. User visits app.lunaxmedia.com
2. Clicks "Connect Meta Account"
3. Redirected to `/auth/meta` → Meta OAuth popup
4. User clicks Allow on Meta
5. Meta redirects to `/auth/meta/callback`
6. Server exchanges code for long-lived token (60 days)
7. Token stored securely in database — user never sees it
8. Frontend receives a session token (UUID)
9. All subsequent API calls use `x-session-token` header
10. User's pages, Instagram accounts, and ad accounts auto-loaded

No copy-pasting tokens. No App IDs. No CORS. Just click Allow.

---

## Scaling

- **0-100 users**: Railway free/hobby tier (~$5/mo), SQLite database
- **100-1000 users**: Railway Pro (~$20/mo), migrate to Supabase Postgres
- **1000+ users**: Add Redis for session caching, horizontal scaling on Railway

---

## Local development

```bash
# Install dependencies
npm install

# Copy env file
cp .env.example .env
# Fill in your values in .env

# Run locally
npm run dev

# Test health
curl http://localhost:3000/health
```
