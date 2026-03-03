// api/generate.js - Run once to generate embeddings
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
  if (!OPENAI_KEY) return res.status(500).json({error: 'OPENAI_API_KEY not set'});

  const { businesses } = req.body || {};
  if (!businesses?.length) return res.status(400).json({error: 'No businesses sent'});

  const embeddings = {};
  for (let i = 0; i < businesses.length; i += 100) {
    const batch = businesses.slice(i, i + 100);
    const texts = batch.map(b => `${b.name}. ${(b.address||'')}. ${(b.tags||[]).join(', ')}.`);
    try {
      const r = await httpsPost('https://api.openai.com/v1/embeddings',
        {model:'text-embedding-3-small', input:texts},
        {'Authorization':`Bearer ${OPENAI_KEY}`}
      );
      if (r.status === 200) r.body.data.forEach((item,idx) => { embeddings[batch[idx].id] = item.embedding; });
      else console.error('Batch failed:', r.body?.error?.message);
    } catch(e) { console.error('Batch error:', e.message); }
  }

  res.status(200).json({embeddings, count: Object.keys(embeddings).length});
};
