// Thinkle proxy — OpenRouter edition
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL   = process.env.OR_MODEL || 'google/gemini-2.5-flash';
const OR_URL  = 'https://openrouter.ai/api/v1/chat/completions';

// ============ LİMİTLER ============
const DAILY_DECK_LIMIT   = 10;    // günde max 10 dosya/deck
const DAILY_CHAT_LIMIT   = 30;    // günde max 30 AI chat mesajı
const HOURLY_LIMIT       = 15;    // saatte max 15 istek (ani spike önleme)
const DAILY_TOKEN_LIMIT  = 60000; // günde max 60K token

const users = new Map();

function getUser(ip){
  const now = Date.now();
  const HOUR = 3600000, DAY = 86400000;
  let u = users.get(ip);
  if(!u) u = { hourly:0, decks:0, chats:0, tokens:0, hourReset:now+HOUR, dayReset:now+DAY };
  if(now > u.hourReset){ u.hourly=0; u.hourReset=now+HOUR; }
  if(now > u.dayReset) { u.decks=0; u.chats=0; u.tokens=0; u.dayReset=now+DAY; }
  users.set(ip, u);
  return u;
}

function checkLimit(ip, isDeck){
  const u = getUser(ip);
  if(u.hourly >= HOURLY_LIMIT)
    return { limited:true, reason: isDeck
      ? 'Saatlik istek limitine ulaştın. Biraz bekle.'
      : 'Saatlik istek limitine ulaştın. Biraz bekle.' };
  if(isDeck && u.decks >= DAILY_DECK_LIMIT)
    return { limited:true, reason: `Günlük ${DAILY_DECK_LIMIT} dosya limitine ulaştın. Yarın tekrar dene.` };
  if(!isDeck && u.chats >= DAILY_CHAT_LIMIT)
    return { limited:true, reason: `Günlük ${DAILY_CHAT_LIMIT} mesaj limitine ulaştın. Yarın tekrar dene.` };
  if(u.tokens >= DAILY_TOKEN_LIMIT)
    return { limited:true, reason: 'Günlük token limitine ulaştın. Yarın tekrar dene.' };
  return { limited:false };
}

function recordUsage(ip, isDeck, tokensUsed){
  const u = getUser(ip);
  u.hourly++;
  if(isDeck) u.decks++; else u.chats++;
  u.tokens += tokensUsed;
  users.set(ip, u);
}

// Abuse koruması
const blocked = new Set();
function checkAbuse(ip){
  const u = getUser(ip);
  if(u.hourly > 40){ blocked.add(ip); return true; }
  return blocked.has(ip);
}

// Bellek temizliği
setInterval(()=>{
  const now = Date.now();
  for(const [ip, u] of users.entries())
    if(now > u.dayReset + 86400000) users.delete(ip);
}, 3600000);

// Keep-alive
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';
if(SELF_URL) setInterval(async()=>{ try{ await fetch(SELF_URL+'/ping'); }catch(e){} }, 60000);

app.get('/ping', (_,res) => res.send('pong'));
app.get('/', (_,res) => res.send('Thinkle proxy is running.'));

app.get('/api/limit', (req,res) => {
  const ip = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.ip;
  const u = getUser(ip);
  res.json({
    decks:  { used: u.decks,  limit: DAILY_DECK_LIMIT },
    chats:  { used: u.chats,  limit: DAILY_CHAT_LIMIT },
    tokens: { used: u.tokens, limit: DAILY_TOKEN_LIMIT }
  });
});

app.post('/api/messages', async (req,res) => {
  const ip = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.ip;
  if(checkAbuse(ip)) return res.status(429).json({error:{message:'Erişim engellendi.'}});
  if(!API_KEY)       return res.status(500).json({error:{message:'Missing API key.'}});

  const { system, messages=[], max_tokens=4000, isDeck } = req.body;

  const limitCheck = checkLimit(ip, isDeck);
  if(limitCheck.limited) return res.status(429).json({error:{message: limitCheck.reason}});

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
    const tokensUsed = data.usage?.total_tokens || max_tokens;
    recordUsage(ip, isDeck, tokensUsed);
    res.json({ content:[{type:'text', text}] });
  }catch(e){
    res.status(500).json({error:{message:'Proxy error: '+e.message}});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Thinkle proxy listening on ${PORT}`));
