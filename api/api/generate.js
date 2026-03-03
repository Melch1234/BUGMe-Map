// api/generate.js
// Called in chunks of 50 businesses at a time to avoid timeout
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({error: 'OPENAI_API_KEY not set in Vercel environment variables'});

  const { businesses } = req.body || {};
  if (!businesses?.length) return res.status(400).json({error: 'No businesses sent'});

  // Process just this chunk (should be ~50 businesses)
  const texts = businesses.map(b => `${b.name}. ${(b.address||'')}. ${(b.tags||[]).join(', ')}.`);

  try {
    const r = await httpsPost(
      'https://api.openai.com/v1/embeddings',
      {model: 'text-embedding-3-small', input: texts},
      {'Authorization': `Bearer ${OPENAI_KEY}`}
    );

    if (r.status !== 200) {
      return res.status(500).json({error: r.body?.error?.message || 'OpenAI error'});
    }

    const embeddings = {};
    r.body.data.forEach((item, idx) => {
      embeddings[businesses[idx].id] = item.embedding;
    });

    return res.status(200).json({embeddings, count: Object.keys(embeddings).length});

  } catch(e) {
    return res.status(500).json({error: e.message});
  }
};
