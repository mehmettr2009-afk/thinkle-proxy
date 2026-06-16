// Thinkle API proxy (Groq edition)
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Rate limiter
const RATE_LIMIT = 20;
const WINDOW_MS = 60 * 60 * 1000;
const hits = new Map();

function isRateLimited(ip){
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, reset: now + WINDOW_MS };
  if(now > entry.reset){ entry.count = 0; entry.reset = now + WINDOW_MS; }
  entry.count++;
  hits.set(ip, entry);
  return entry.count > RATE_LIMIT;
}

app.post('/api/messages', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;

  if(isRateLimited(ip)){
    return res.status(429).json({ error: { message: 'Rate limit exceeded. Try again later.' } });
  }

  if(!GROQ_API_KEY){
    return res.status(500).json({ error: { message: 'Server misconfigured: missing API key.' } });
  }

  try{
    const { system, messages = [], max_tokens } = req.body;

    // Groq uses OpenAI format
    const groqMessages = [];
    if(system) groqMessages.push({ role: 'system', content: system });
    messages.forEach(m => groqMessages.push({ role: m.role, content: m.content }));

    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: groqMessages,
        max_tokens: max_tokens || 2048,
        temperature: 0.7
      })
    });

    const data = await response.json();

    if(!response.ok){
      return res.status(response.status).json({ error: data.error || { message: 'Groq API error' } });
    }

    const text = data.choices?.[0]?.message?.content || '';

    // Anthropic-shape response (frontend expects this)
    res.json({ content: [{ type: 'text', text }] });

  } catch(err){
    console.error('Proxy error:', err);
    res.status(500).json({ error: { message: 'Proxy request failed.' } });
  }
});

app.get('/', (req, res) => res.send('Thinkle proxy (Groq) is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Thinkle proxy listening on port ${PORT}`));
