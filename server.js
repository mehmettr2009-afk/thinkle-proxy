// Thinkle proxy — Güvenli + Analitik edition
const express = require('express');
const app = express();
app.use(express.json({ limit: '12mb' }));

// ============ CORS ============
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

const API_KEY     = process.env.OPENROUTER_API_KEY;
const MODEL       = process.env.OR_MODEL || 'google/gemini-2.5-flash';
const OR_URL      = 'https://openrouter.ai/api/v1/chat/completions';
const FOUNDER_UID = 'l8Tih1awnjP7fRXnUsFVVAuXEZu2';

// Gemini 2.5 Flash yaklaşık fiyatlandırma (OpenRouter, $/1M token)
const PRICE_PER_M_INPUT  = 0.30;
const PRICE_PER_M_OUTPUT = 2.50;

// ============ REQUEST İMZA DOĞRULAMA ============
function isValidSignature(sig){
  if(!sig) return false;
  const hour = Math.floor(Date.now() / 3600000);
  for(const h of [hour, hour-1]){
    const secret = 'thinkle-' + h + '-space';
    const expected = Buffer.from(secret + '-' + (h % 7)).toString('base64').replace(/=/g,'');
    if(sig === expected) return true;
  }
  return false;
}

// Kurucu paneli için basit token doğrulama (UID + sabit secret)
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'thinkle-admin-' + FOUNDER_UID.slice(0,8);
function isAdminRequest(req){
  const uid = req.body?.uid || req.query?.uid;
  const token = req.headers['x-admin-token'] || req.body?.adminToken || req.query?.adminToken;
  return uid === FOUNDER_UID && token === ADMIN_SECRET;
}

// ============ RATE LİMİTER ============
const DAILY_DECK_LIMIT  = 10;
const DAILY_CHAT_LIMIT  = 30;
const HOURLY_LIMIT      = 15;
const DAILY_TOKEN_LIMIT = 60000;

const ipStore  = new Map();
const uidStore = new Map();

// Manuel banlanan / özel limitli kullanıcılar (UID bazlı)
const bannedUsers   = new Map(); // uid -> { reason, bannedAt }
const unlimitedUsers = new Set(); // beta testçiler vb — sınırsız erişim

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
    return { limited:true, reason:'Saatlik istek limitine ulaştın. Biraz bekle.' };
  if(isDeck && r.decks >= DAILY_DECK_LIMIT)
    return { limited:true, reason:`Günlük ${DAILY_DECK_LIMIT} dosya limitine ulaştın. Yarın tekrar dene.` };
  if(!isDeck && r.chats >= DAILY_CHAT_LIMIT)
    return { limited:true, reason:`Günlük ${DAILY_CHAT_LIMIT} mesaj limitine ulaştın. Yarın tekrar dene.` };
  if(r.tokens >= DAILY_TOKEN_LIMIT)
    return { limited:true, reason:'Günlük token limitine ulaştın. Yarın tekrar dene.' };
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

// ============ ANALİTİK — saatlik dağılım, hata sayacı, anomali ============
const hourlyDistribution = new Array(24).fill(0); // bugünün saatlik istek sayısı
let lastDistributionDay = new Date().toISOString().split('T')[0];

let totalRequests = 0;
let totalErrors   = 0;
let totalInputTokens  = 0;
let totalOutputTokens = 0;

const recentDecks = []; // son oluşturulan deck başlıkları (moderasyon için), max 50
const abuseReports = []; // şüpheli kullanım kayıtları, max 100

function recordHourly(){
  const today = new Date().toISOString().split('T')[0];
  if(today !== lastDistributionDay){
    hourlyDistribution.fill(0);
    lastDistributionDay = today;
  }
  const hour = new Date().getHours();
  hourlyDistribution[hour]++;
}

function recordAnomaly(ip, uid, hourly){
  if(hourly === 41){ // tam abuse eşiğini geçtiği an bir kere kaydet
    abuseReports.unshift({
      type: 'rate_spike',
      ip, uid: uid || '(anonim)',
      detail: `Saatte ${hourly}+ istek — otomatik engellendi`,
      time: new Date().toISOString()
    });
    if(abuseReports.length > 100) abuseReports.pop();
  }
}

function recordDeckTitle(title, uid){
  if(!title) return;
  recentDecks.unshift({ title: String(title).slice(0,120), uid: uid || '(anonim)', time: new Date().toISOString() });
  if(recentDecks.length > 50) recentDecks.pop();
}

// ============ INPUT TEMİZLEME ============
function sanitize(text){
  if(!text) return '';
  if(typeof text === 'string'){
    return text
      .replace(/ignore (all |previous |prior )?instructions?/gi, '[filtered]')
      .replace(/system prompt/gi, '[filtered]')
      .replace(/api.?key/gi, '[filtered]')
      .replace(/jailbreak/gi, '[filtered]')
      .slice(0, 10000);
  }
  if(Array.isArray(text)){
    return text.map(part => {
      if(part.type === 'text' && typeof part.text === 'string'){
        return { type:'text', text: sanitize(part.text) };
      }
      if(part.type === 'image_url' && part.image_url?.url){
        if(typeof part.image_url.url === 'string' && part.image_url.url.startsWith('data:image/')){
          return part;
        }
        return null;
      }
      return null;
    }).filter(Boolean);
  }
  return '';
}

// ============ HONEYPOT ============
const HONEYPOT_PATHS = ['/api/admin', '/api/secret', '/api/keys', '/admin', '/.env', '/config'];
HONEYPOT_PATHS.forEach(path => {
  app.all(path, (req, res) => {
    const ip = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.ip;
    blocked.add(ip);
    abuseReports.unshift({ type:'honeypot', ip, uid:'-', detail:`Erişmeye çalıştı: ${path}`, time:new Date().toISOString() });
    if(abuseReports.length > 100) abuseReports.pop();
    res.status(404).json({ error: 'Not found' });
  });
});

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

// ============ ADMIN ENDPOINTS — kurucu paneli ============
app.get('/api/admin/stats', (req,res) => {
  if(!isAdminRequest(req)) return res.status(403).json({error:'Unauthorized'});

  const estimatedCost = (totalInputTokens/1e6 * PRICE_PER_M_INPUT) + (totalOutputTokens/1e6 * PRICE_PER_M_OUTPUT);

  res.json({
    totalRequests,
    totalErrors,
    errorRate: totalRequests ? +(totalErrors/totalRequests*100).toFixed(1) : 0,
    hourlyDistribution,
    estimatedCostUSD: +estimatedCost.toFixed(3),
    totalInputTokens,
    totalOutputTokens,
    activeIPs: ipStore.size,
    activeUsers: uidStore.size,
    blockedIPs: Array.from(blocked),
    bannedUsers: Array.from(bannedUsers.entries()).map(([uid,v]) => ({ uid, ...v })),
    unlimitedUsers: Array.from(unlimitedUsers),
    recentDecks: recentDecks.slice(0,20),
    abuseReports: abuseReports.slice(0,20),
    dailyTokenLimitPerUser: DAILY_TOKEN_LIMIT
  });
});

app.post('/api/admin/ban', (req,res) => {
  if(!isAdminRequest(req)) return res.status(403).json({error:'Unauthorized'});
  const { targetUid, reason } = req.body;
  if(!targetUid) return res.status(400).json({error:'targetUid required'});
  if(targetUid === FOUNDER_UID) return res.status(400).json({error:'Kurucu banlanamaz'});
  bannedUsers.set(targetUid, { reason: reason || 'Belirtilmedi', bannedAt: new Date().toISOString() });
  unlimitedUsers.delete(targetUid);
  res.json({ ok:true, banned: targetUid });
});

app.post('/api/admin/unban', (req,res) => {
  if(!isAdminRequest(req)) return res.status(403).json({error:'Unauthorized'});
  const { targetUid } = req.body;
  bannedUsers.delete(targetUid);
  res.json({ ok:true, unbanned: targetUid });
});

app.post('/api/admin/grant-unlimited', (req,res) => {
  if(!isAdminRequest(req)) return res.status(403).json({error:'Unauthorized'});
  const { targetUid } = req.body;
  if(!targetUid) return res.status(400).json({error:'targetUid required'});
  unlimitedUsers.add(targetUid);
  bannedUsers.delete(targetUid);
  res.json({ ok:true, unlimited: targetUid });
});

app.post('/api/admin/revoke-unlimited', (req,res) => {
  if(!isAdminRequest(req)) return res.status(403).json({error:'Unauthorized'});
  const { targetUid } = req.body;
  unlimitedUsers.delete(targetUid);
  res.json({ ok:true, revoked: targetUid });
});

// ============ ANA MESAJ ENDPOINT'İ ============
app.post('/api/messages', async (req,res) => {
  const ip  = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.ip;
  const uid = req.body.uid || '';
  const sig = req.body.sig || '';
  const isFounder    = uid === FOUNDER_UID;
  const isUnlimited  = isFounder || unlimitedUsers.has(uid);

  totalRequests++;
  recordHourly();

  // Banlı kullanıcı kontrolü
  if(uid && bannedUsers.has(uid)){
    totalErrors++;
    return res.status(403).json({error:{message:'Hesabınız kısıtlanmıştır.'}});
  }

  if(!isFounder && !isValidSignature(sig)){
    totalErrors++;
    return res.status(403).json({error:{message:'Unauthorized request.'}});
  }

  if(!isUnlimited && checkAbuse(ip)){
    totalErrors++;
    const r = getRecord(ipStore, ip);
    recordAnomaly(ip, uid, r.hourly);
    return res.status(429).json({error:{message:'Rate limit exceeded.'}});
  }

  if(!API_KEY){
    totalErrors++;
    return res.status(500).json({error:{message:'Service unavailable.'}});
  }

  const { system, messages=[], max_tokens=4000, isDeck } = req.body;

  if(!isUnlimited){
    const ipCheck = checkLimit(ipStore, ip, isDeck);
    if(ipCheck.limited){ totalErrors++; return res.status(429).json({error:{message: ipCheck.reason}}); }
    if(uid){
      const uidCheck = checkLimit(uidStore, uid, isDeck);
      if(uidCheck.limited){ totalErrors++; return res.status(429).json({error:{message: uidCheck.reason}}); }
    }
  }

  const msgs = [];
  if(system) msgs.push({role:'system', content: sanitize(system)});
  messages.forEach(m => msgs.push({role:m.role, content: sanitize(m.content)}));

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
    if(!r.ok){
      totalErrors++;
      return res.status(r.status).json({error:{message: r.status === 429 ? 'Rate limit.' : 'Service error.'}});
    }

    const text = data.choices?.[0]?.message?.content || '';
    const inputTokens  = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    const tokensUsed = data.usage?.total_tokens || (inputTokens+outputTokens) || max_tokens;

    totalInputTokens  += inputTokens;
    totalOutputTokens += outputTokens;

    if(!isUnlimited){
      recordUsage(ipStore, ip, isDeck, tokensUsed);
      if(uid) recordUsage(uidStore, uid, isDeck, tokensUsed);
    }

    // Deck oluşturma ise başlığı moderasyon listesine kaydet (JSON içinden title yakala)
    if(isDeck){
      try{
        const parsed = JSON.parse(text);
        if(parsed?.title) recordDeckTitle(parsed.title, uid);
      }catch(e){ /* JSON değilse atla */ }
    }

    res.json({ content:[{type:'text', text}] });
  }catch(e){
    totalErrors++;
    res.status(500).json({error:{message:'Service temporarily unavailable.'}});
  }
});

// Bellek temizliği
setInterval(()=>{
  const now = Date.now();
  for(const [k,v] of ipStore.entries())
    if(now > v.dayReset + 86400000) ipStore.delete(k);
  for(const [k,v] of uidStore.entries())
    if(now > v.dayReset + 86400000) uidStore.delete(k);
}, 3600000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Thinkle proxy listening on ${PORT}`));
