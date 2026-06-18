// Thinkle proxy — OpenRouter edition
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL   = process.env.OR_MODEL || 'meta-llama/llama-3.3-70b-instruct';
const OR_URL  = 'https://openrouter.ai/api/v1/chat/completions';

// Rate limiter
const hits = new Map();
function isLimited(ip){
  const now = Date.now();
  const e = hits.get(ip) || { n:0, reset: now+3600000 };
  if(now > e.reset){ e.n=0; e.reset=now+3600000; }
  e.n++; hits.set(ip,e);
  return e.n > 60;
}

// Keep-alive — her Her dakika kendini ping'le, uyku moduna girme
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';
if(SELF_URL){
  setInterval(async () => {
    try{
      await fetch(SELF_URL + '/ping');
      console.log('keep-alive ping OK');
    }catch(e){ console.log('keep-alive error:', e.message); }
  }, 60 * 1000);
}

app.get('/ping', (_,res) => res.send('pong'));
app.get('/',     (_,res) => res.send('Thinkle proxy (OpenRouter) is running.'));

app.post('/api/messages', async (req,res) => {
  const ip = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.ip;
  if(isLimited(ip)) return res.status(429).json({error:{message:'Rate limit. Try later.'}});
  if(!API_KEY)       return res.status(500).json({error:{message:'Missing API key.'}});

  const { system, messages=[], max_tokens=5000 } = req.body;
  const msgs = [];
  if(system) msgs.push({role:'system', content:system});
  messages.forEach(m => msgs.push({role:m.role, content:m.content}));

  try{
    const r = await fetch(OR_URL, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Authorization':`Bearer ${API_KEY}`,
        'HTTP-Referer':'https://thinkle.space',
        'X-Title':'Thinkle'
      },
      body: JSON.stringify({ model:MODEL, messages:msgs, max_tokens })
    });
    const data = await r.json();
    if(!r.ok) return res.status(r.status).json({error: data.error||{message:'OR error'}});
    const text = data.choices?.[0]?.message?.content || '';
    res.json({ content:[{type:'text', text}] });
  }catch(e){
    res.status(500).json({error:{message:'Proxy error: '+e.message}});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Thinkle proxy listening on ${PORT}`));
