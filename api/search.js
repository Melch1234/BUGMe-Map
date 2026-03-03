// BUGMe Search API - Embeddings + Mapbox geocoding
// Vercel serverless function

const https = require('https');

function httpsPost(url, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    }).on('error', reject);
  });
}

// Cosine similarity between two vectors
function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Load pre-computed embeddings from file
let embeddingsCache = null;
function getEmbeddings() {
  if (embeddingsCache) return embeddingsCache;
  try {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(__dirname, '..', 'embeddings.json');
    if (fs.existsSync(filePath)) {
      embeddingsCache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return embeddingsCache;
    }
  } catch(e) {}
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const MAPBOX_TOKEN = 'pk.eyJ1Ijoicm9hZGllMTIzNCIsImEiOiJjbW0yZ25oNzEwN3k1MnNwcnN5bWxoM3ptIn0.EjJEPhnVy_-lu1FfopPctg';

  try {
    const { query, businesses } = req.body;
    if (!query) return res.status(400).json({ error: 'No query' });

    // ── Step 1: Geocode the location from the query ──────────────────────
    const geoUrl = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${MAPBOX_TOKEN}&types=country,region,district,place,locality&limit=1`;
    const geoResp = await httpsGet(geoUrl);
    const feature = geoResp.body.features?.[0];

    let searchLat = null, searchLng = null, placeType = null, placeName = null;
    if (feature) {
      [searchLng, searchLat] = feature.center;
      placeType = feature.place_type?.[0];
      placeName = feature.place_name;
    }

    // ── Step 2: Filter businesses by geography ───────────────────────────
    let candidates = businesses || [];

    if (searchLat && searchLng) {
      const isLargeArea = ['country', 'region'].includes(placeType);
      const radius = isLargeArea ? 99999 : 300; // km

      candidates = candidates.filter(b => {
        if (!b.lat || !b.lng) return false;
        if (isLargeArea) {
          // For countries/provinces match address text
          const addr = (b.address || '').toLowerCase();
          const placeWords = placeName.toLowerCase().split(/[\s,]+/).filter(w => w.length > 3);
          return placeWords.some(w => addr.includes(w));
        } else {
          // Distance filter
          const R = 6371;
          const dLat = (b.lat - searchLat) * Math.PI / 180;
          const dLng = (b.lng - searchLng) * Math.PI / 180;
          const a = Math.sin(dLat/2)**2 + Math.cos(searchLat*Math.PI/180) * Math.cos(b.lat*Math.PI/180) * Math.sin(dLng/2)**2;
          const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
          b._dist = Math.round(dist);
          return dist <= radius;
        }
      });
    }

    if (candidates.length === 0) {
      return res.status(200).json({ results: [], message: `No operators found for "${query}"` });
    }

    // ── Step 3: Embedding similarity to rank candidates ──────────────────
    let rankedCandidates = candidates;

    if (OPENAI_KEY) {
      try {
        // Embed the search query
        const embedResp = await httpsPost(
          'https://api.openai.com/v1/embeddings',
          { model: 'text-embedding-3-small', input: query },
          { 'Authorization': `Bearer ${OPENAI_KEY}` }
        );
        const queryVector = embedResp.body.data?.[0]?.embedding;

        if (queryVector) {
          // Load pre-computed business embeddings
          const storedEmbeddings = getEmbeddings();

          if (storedEmbeddings) {
            // Score each candidate by embedding similarity
            rankedCandidates = candidates.map(b => {
              const stored = storedEmbeddings[b.id];
              const sim = stored ? cosineSim(queryVector, stored) : 0;
              const offerBoost = b.offer ? 0.05 : 0;
              return { ...b, _score: sim + offerBoost };
            }).sort((a, b) => b._score - a._score);
          } else {
            // No pre-computed embeddings — embed top 20 candidates on the fly
            const top20 = candidates.slice(0, 20);
            const texts = top20.map(b =>
              `${b.name}. ${(b.address||'')}. ${(b.tags||[]).join(', ')}.`
            );
            const bulkResp = await httpsPost(
              'https://api.openai.com/v1/embeddings',
              { model: 'text-embedding-3-small', input: texts },
              { 'Authorization': `Bearer ${OPENAI_KEY}` }
            );
            const vecs = bulkResp.body.data || [];
            rankedCandidates = top20.map((b, i) => {
              const sim = vecs[i] ? cosineSim(queryVector, vecs[i].embedding) : 0;
              return { ...b, _score: sim + (b.offer ? 0.05 : 0) };
            }).sort((a, b) => b._score - a._score);
          }
        }
      } catch(embErr) {
        console.error('Embedding error:', embErr.message);
      }
    }

    // ── Step 4: Take top 8, use Claude to write reasons ──────────────────
    const top8 = rankedCandidates.slice(0, 8);

    if (!ANTHROPIC_KEY || top8.length === 0) {
      return res.status(200).json({
        results: top8.slice(0, 6).map(b => ({ id: b.id, reason: '' })),
        place: placeName
      });
    }

    const bizList = top8.map(b =>
      `ID:${b.id} | ${b.name} | ${(b.address||'').replace(/\n/g,' ')} | ${(b.tags||[]).slice(0,5).join(', ')}${b.offer?' | PASS_OFFER':''}`
    ).join('\n');

    const claudeResp = await httpsPost(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `Search: "${query}"${placeName ? ` (resolved to: ${placeName})` : ''}

These are the best matching operators. Pick the TOP 6 and write one friendly sentence explaining why each fits this search. Prioritize PASS_OFFER businesses.

Return ONLY JSON array, no markdown:
[{"id":123,"reason":"one friendly sentence"}]

Operators:
${bizList}`
        }]
      },
      { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }
    );

    const text = claudeResp.body.content?.[0]?.text || '[]';
    const picks = JSON.parse(text.replace(/```json|```/g, '').trim());

    return res.status(200).json({ results: picks, place: placeName });

  } catch(err) {
    console.error('Search error:', err);
    return res.status(500).json({ error: err.message });
  }
};
