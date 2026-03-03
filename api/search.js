Search · JS
Copy

// api/search.js - BUGMe Search + Embedding Generator
const https = require('https');

function httpsPost(url, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST',
      headers: {'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),...headers}
    }, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => { try { resolve({status:res.statusCode,body:JSON.parse(d)}); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => { try { resolve({status:res.statusCode,body:JSON.parse(d)}); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function cosineSim(a, b) {
  let dot=0, magA=0, magB=0;
  for (let i=0; i<a.length; i++) { dot+=a[i]*b[i]; magA+=a[i]*a[i]; magB+=b[i]*b[i]; }
  return dot/(Math.sqrt(magA)*Math.sqrt(magB));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const MAPBOX_TOKEN = 'pk.eyJ1Ijoicm9hZGllMTIzNCIsImEiOiJjbW0yZ25oNzEwN3k1MnNwcnN5bWxoM3ptIn0.EjJEPhnVy_-lu1FfopPctg';

  const { query, businesses, mode } = req.body || {};

  // ── EMBED MODE: generate embeddings for a chunk of businesses ────────────
  if (mode === 'embed') {
    if (!OPENAI_KEY) return res.status(500).json({error: 'OPENAI_API_KEY not set'});
    if (!businesses?.length) return res.status(400).json({error: 'No businesses'});
    const texts = businesses.map(b => `${b.name}. ${(b.address||'')}. ${(b.tags||[]).join(', ')}.`);
    try {
      const r = await httpsPost('https://api.openai.com/v1/embeddings',
        {model:'text-embedding-3-small', input:texts},
        {'Authorization':`Bearer ${OPENAI_KEY}`}
      );
      if (r.status !== 200) return res.status(500).json({error: r.body?.error?.message});
      const embeddings = {};
      r.body.data.forEach((item,idx) => { embeddings[businesses[idx].id] = item.embedding; });
      return res.status(200).json({embeddings});
    } catch(e) {
      return res.status(500).json({error: e.message});
    }
  }

  // ── SEARCH MODE ──────────────────────────────────────────────────────────
  if (!query) return res.status(400).json({error: 'No query'});
  if (!businesses?.length) return res.status(400).json({error: 'No businesses'});

  try {
    // Step 1: Geocode
    const geoUrl = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${MAPBOX_TOKEN}&types=country,region,district,place,locality&limit=1`;
    const geoResp = await httpsGet(geoUrl);
    const feature = geoResp.body.features?.[0];

    let candidates = businesses.filter(b => b.lat && b.lng);

    if (feature) {
      const [searchLng, searchLat] = feature.center;
      const placeType = feature.place_type?.[0];
      const placeName = feature.place_name;
      const isLargeArea = ['country','region'].includes(placeType);

      candidates = candidates.filter(b => {
        if (isLargeArea) {
          const addr = (b.address||'').toLowerCase();
          const words = placeName.toLowerCase().split(/[\s,]+/).filter(w=>w.length>3);
          return words.some(w => addr.includes(w));
        }
        const R=6371, dLat=(b.lat-searchLat)*Math.PI/180, dLng=(b.lng-searchLng)*Math.PI/180;
        const a=Math.sin(dLat/2)**2+Math.cos(searchLat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
        return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)) <= 300;
      });
    }

    if (!candidates.length) return res.status(200).json({results:[], message:'No operators found'});

    // Step 2: Embed query and rank by similarity
    if (OPENAI_KEY) {
      try {
        const embedResp = await httpsPost('https://api.openai.com/v1/embeddings',
          {model:'text-embedding-3-small', input: query},
          {'Authorization':`Bearer ${OPENAI_KEY}`}
        );
        const qVec = embedResp.body.data?.[0]?.embedding;
        if (qVec) {
          // Embed top 30 candidates on the fly
          const top30 = candidates.slice(0,30);
          const texts = top30.map(b=>`${b.name}. ${b.address||''}. ${(b.tags||[]).join(', ')}.`);
          const bizEmbed = await httpsPost('https://api.openai.com/v1/embeddings',
            {model:'text-embedding-3-small', input:texts},
            {'Authorization':`Bearer ${OPENAI_KEY}`}
          );
          candidates = top30.map((b,i) => ({
            ...b,
            _score: (bizEmbed.body.data?.[i] ? cosineSim(qVec, bizEmbed.body.data[i].embedding) : 0) + (b.offer ? 0.05 : 0)
          })).sort((a,b)=>b._score-a._score);
        }
      } catch(e) { console.error('Embed error:', e.message); }
    }

    // Step 3: Claude picks top 6 with reasons
    const top8 = candidates.slice(0,8);
    const bizList = top8.map(b=>`ID:${b.id}|${b.name}|${(b.address||'').replace(/\n/g,' ')}|${(b.tags||[]).slice(0,5).join(',')}${b.offer?'|PASS_OFFER':''}`).join('\n');

    if (!ANTHROPIC_KEY) return res.status(200).json({results: top8.slice(0,6).map(b=>({id:b.id,reason:''}))});

    const claudeResp = await httpsPost('https://api.anthropic.com/v1/messages',
      {
        model:'claude-haiku-4-5-20251001', max_tokens:400,
        messages:[{role:'user',content:`Search: "${query}"\nPick TOP 6, prioritize PASS_OFFER. Return ONLY JSON array:\n[{"id":123,"reason":"one sentence"}]\n\n${bizList}`}]
      },
      {'x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'}
    );

    const text = claudeResp.body.content?.[0]?.text || '[]';
    const picks = JSON.parse(text.replace(/```json|```/g,'').trim());
    return res.status(200).json({results: picks});

  } catch(err) {
    console.error('Search error:', err);
    return res.status(500).json({error: err.message});
  }
};
