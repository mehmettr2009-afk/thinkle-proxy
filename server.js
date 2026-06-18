// Thinkle proxy — OpenRouter edition
const express = require('express');
const app = express();
app.use(express.json({ limit: '2mb' }));

// ============ CORS — sadece thinkle.space konuşabilir ============
const ALLOWED_ORIGINS = [
  'https://thinkle.space',
  'https://www.thinkle.space',
  'https://mehmettr2009-afk.github.io',
  'http://localhost:3000',
  'http://localhost:5500'
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if(ALLOWED_ORIGINS.includes(origin)){
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL   = process.env.OR_MODEL || 'google/gemini-2.5-flash';
const OR_URL  = 'https://openrouter.ai/api/v1/chat/completions';

const FOUNDER_UID = 'l8Tih1awnjP7fRXnUsFVVAuXEZu2';

// ============ RATE LİMİTER ============
// IP bazlı + UID bazlı çift koruma
const DAILY_DECK_LIMIT  = 10;
const DAILY_CHAT_LIMIT  = 30;
const HOURLY_LIMIT      = 15;
const DAILY_TOKEN_LIMIT = 60000;

const ipStore  = new Map(); // IP bazlı
const uidStore = new Map(); // UID bazlı

function getRecord(store, key){
  const now = Date.now();
  const HOUR = 3600000, DAY = 86400000;
  let r = store.get(key);
  if(!r) r = { hourly:0, decks:0, chats:0, tokens:0, hourReset:now+HOUR, dayReset:now+DAY };
  if(now > r.hourReset){ r.hourly=0; r.hourReset=now+HOUR; }
  if(now > r.dayReset) { r.decks=0; r.chats=0; r.tokens=0; r.dayReset=now+DAY; }
  store.set(key, r);
  return r;
}

function checkLimit(store, key, isDeck){
  const r = getRecord(store, key);
  if(r.hourly >= HOURLY_LIMIT)
    return { limited:true, reason: 'Saatlik istek limitine ulaştın. Biraz bekle.' };
  if(isDeck && r.decks >= DAILY_DECK_LIMIT)
    return { limited:true, reason: `Günlük ${DAILY_DECK_LIMIT} dosya limitine ulaştın. Yarın tekrar dene.` };
  if(!isDeck && r.chats >= DAILY_CHAT_LIMIT)
    return { limited:true, reason: `Günlük ${DAILY_CHAT_LIMIT} mesaj limitine ulaştın. Yarın tekrar dene.` };
  if(r.tokens >= DAILY_TOKEN_LIMIT)
    return { limited:true, reason: 'Günlük token limitine ulaştın. Yarın tekrar dene.' };
  return { limited:false };
}

function recordUsage(store, key, isDeck, tokens){
  const r = getRecord(store, key);
  r.hourly++; r.tokens += tokens;
  if(isDeck) r.decks++; else r.chats++;
  store.set(key, r);
}

// ============ ABUSE KORUMASI ============
const blocked = new Set();
function checkAbuse(ip){
  const r = getRecord(ipStore, ip);
  if(r.hourly > 40){ blocked.add(ip); return true; }
  return blocked.has(ip);
}

// ============ INPUT TEMİZLEME ============
function sanitizeText(text){
  if(!text || typeof text !== 'string') return '';
  return text
    // Prompt injection denemelerini temizle
    .replace(/ignore (all |previous |prior )?instructions?/gi, '[filtered]')
    .replace(/system prompt/gi, '[filtered]')
    .replace(/api.?key/gi, '[filtered]')
    .replace(/jailbreak/gi, '[filtered]')
    // Aşırı uzun tekrarları kırp
    .slice(0, 10000);
}

function sanitizeMessages(messages){
  return messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? sanitizeText(m.content) : m.content
  }));
}

// Keep-alive
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';
if(SELF_URL) setInterval(async()=>{ try{ await fetch(SELF_URL+'/ping'); }catch(e){} }, 60000);

app.get('/ping', (_,res) => res.send('pong'));
app.get('/', (_,res) => res.send('Thinkle proxy is running.'));

app.get('/api/limit', (req,res) => {
  const ip = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.ip;
  const r = getRecord(ipStore, ip);
  res.json({
    decks:  { used: r.decks,  limit: DAILY_DECK_LIMIT },
    chats:  { used: r.chats,  limit: DAILY_CHAT_LIMIT },
    tokens: { used: r.tokens, limit: DAILY_TOKEN_LIMIT }
  });
});

app.post('/api/messages', async (req,res) => {
  const ip  = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.ip;
  const uid = req.body.uid || '';
  const isFounder = uid === FOUNDER_UID;

  // Abuse kontrolü
  if(!isFounder && checkAbuse(ip))
    return res.status(429).json({error:{message:'Erişim engellendi.'}});

  if(!API_KEY)
    return res.status(500).json({error:{message:'Missing API key.'}});

  const { system, messages=[], max_tokens=4000, isDeck } = req.body;

  // Rate limit — hem IP hem UID kontrol et
  if(!isFounder){
    const ipCheck = checkLimit(ipStore, ip, isDeck);
    if(ipCheck.limited) return res.status(429).json({error:{message: ipCheck.reason}});

    if(uid){
      const uidCheck = checkLimit(uidStore, uid, isDeck);
      if(uidCheck.limited) return res.status(429).json({error:{message: uidCheck.reason}});
    }
  }

  // Input temizle
  const cleanSystem = sanitizeText(system || '');
  const cleanMessages = sanitizeMessages(messages);

  const msgs = [];
  if(cleanSystem) msgs.push({role:'system', content:cleanSystem});
  cleanMessages.forEach(m => msgs.push({role:m.role, content:m.content}));

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

    // Kullanımı kaydet — hem IP hem UID
    if(!isFounder){
      recordUsage(ipStore, ip, isDeck, tokensUsed);
      if(uid) recordUsage(uidStore, uid, isDeck, tokensUsed);
    }

    res.json({ content:[{type:'text', text}] });
  }catch(e){
    res.status(500).json({error:{message:'Proxy error: '+e.message}});
  }
});

// Bellek temizliği — eski kayıtları sil
setInterval(()=>{
  const now = Date.now();
  for(const [k,v] of ipStore.entries())
    if(now > v.dayReset + 86400000) ipStore.delete(k);
  for(const [k,v] of uidStore.entries())
    if(now > v.dayReset + 86400000) uidStore.delete(k);
}, 3600000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Thinkle proxy listening on ${PORT}`));
