// Thinkle API proxy (Gemini edition)
// Keeps the Gemini API key secret on the server, and forwards
// chat-completion requests from the Thinkle frontend in Anthropic-like
// shape, translating them to/from Gemini's request/response format.

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors()); // allow requests from your GitHub Pages site
app.use(express.json({ limit: '2mb' }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Simple in-memory rate limiter: max N requests per IP per hour.
const RATE_LIMIT = 20; // requests per hour per IP
const WINDOW_MS = 60 * 60 * 1000;
const hits = new Map();

function isRateLimited(ip){
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, reset: now + WINDOW_MS };
  if(now > entry.reset){
    entry.count = 0;
    entry.reset = now + WINDOW_MS;
  }
  entry.count++;
  hits.set(ip, entry);
  return entry.count > RATE_LIMIT;
}

// The Thinkle frontend sends requests shaped like Anthropic's /v1/messages:
//   { model, max_tokens, system, messages: [{role:'user'|'assistant', content:'...'}] }
// This endpoint translates that into a Gemini generateContent call and
// translates the response back into Anthropic's shape:
//   { content: [{ type: 'text', text: '...' }] }
app.post('/api/messages', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;

  if(isRateLimited(ip)){
    return res.status(429).json({ error: { message: 'Rate limit exceeded. Try again later.' } });
  }

  if(!GEMINI_API_KEY){
    return res.status(500).json({ error: { message: 'Server misconfigured: missing API key.' } });
  }

  try{
    const { system, messages = [], max_tokens, expectJson } = req.body;

    // Translate messages: Anthropic uses 'assistant', Gemini uses 'model'
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
    }));

    const geminiBody = {
      contents,
      generationConfig: {
        maxOutputTokens: max_tokens || 2048
      }
    };

    if(system){
      geminiBody.systemInstruction = { parts: [{ text: system }] };
    }

    // If the caller wants strict JSON back (e.g. the deck generator),
    // it can set expectJson: true in the request body.
    if(expectJson){
      geminiBody.generationConfig.responseMimeType = 'application/json';
    }

    const url = `${GEMINI_URL}?key=${GEMINI_API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody)
    });

    const data = await response.json();

    if(!response.ok){
      return res.status(response.status).json({ error: data.error || { message: 'Gemini API error' } });
    }

    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';

    // Respond in the shape the frontend already expects (Anthropic-like)
    res.json({ content: [{ type: 'text', text }] });
  }catch(err){
    console.error('Proxy error:', err);
    res.status(500).json({ error: { message: 'Proxy request failed.' } });
  }
});

app.get('/', (req, res) => {
  res.send('Thinkle proxy (Gemini) is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Thinkle proxy listening on port ${PORT}`));
