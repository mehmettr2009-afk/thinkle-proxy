# Thinkle Proxy (Gemini edition)

A tiny Express server that keeps your Gemini API key secret. The Thinkle
frontend sends requests here instead of calling Google directly, so the key
never appears in the browser.

## 1. Get a Gemini API key (free)

1. Go to https://aistudio.google.com/apikey
2. Sign in with a Google account
3. Click "Create API key" — copy it (starts like `AIza...`)

The free tier has rate limits (requests per minute/day) but no cost.

## 2. Deploy this proxy (free, on Render.com)

1. Push this folder to a new GitHub repo
2. Go to https://render.com, sign in with GitHub
3. "New +" → "Web Service" → pick this repo
4. Build command: `npm install`
5. Start command: `npm start`
6. Under "Environment", add a variable:
   - Key: `GEMINI_API_KEY`
   - Value: your key from step 1
7. Deploy. Render gives you a URL like `https://thinkle-proxy-xxxx.onrender.com`

## 3. Point the frontend at your proxy

In `index.html`, find this line near the top of the `<script>`:

```js
const PROXY_URL = "https://YOUR-PROXY-URL.onrender.com/api/messages";
```

Replace it with your actual Render URL + `/api/messages`, e.g.:

```js
const PROXY_URL = "https://thinkle-proxy-xxxx.onrender.com/api/messages";
```

## 4. Host the frontend (free, on GitHub Pages)

1. Push `index.html` to another GitHub repo (or the same one, different folder)
2. Repo Settings → Pages → "Deploy from branch" → select `main` / root
3. Your site will be live at `https://yourusername.github.io/repo-name/`

## Notes

- The proxy includes a simple per-IP rate limit (20 requests/hour by default).
  Adjust `RATE_LIMIT` in `server.js` if needed.
- Render's free tier "spins down" after inactivity — the first request after
  idle time may take ~30-60 seconds while it wakes up. This is normal.
- To change the Gemini model, set a `GEMINI_MODEL` environment variable
  (defaults to `gemini-2.5-flash`).
