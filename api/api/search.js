// api/generate.js
// Hit this URL ONCE to generate all embeddings:
// https://bug-me-map.vercel.app/api/generate
// It will return the embeddings.json content — copy and save as embeddings.json in your repo

const https = require('https');

function httpsPost(url, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers
      }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e) { reject(new Error('Parse error: ' + d.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set in Vercel environment variables' });

  // Businesses are sent in the request body to keep this file small
  const { businesses } = req.body || {};
  if (!businesses || !businesses.length) {
    return res.status(400).json({ error: 'Send businesses array in request body' });
  }

  const embeddings = {};
  const BATCH_SIZE = 100;
  const batches = [];
  for (let i = 0; i < businesses.length; i += BATCH_SIZE) {
    batches.push(businesses.slice(i, i + BATCH_SIZE));
  }

  console.log(`Generating embeddings for ${businesses.length} businesses in ${batches.length} batches`);

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const texts = batch.map(b =>
      `${b.name}. ${(b.address||'').replace(/\n/g,' ')}. Activities: ${(b.tags||[]).join(', ')}.`
    );

    try {
      const resp = await httpsPost(
        'https://api.openai.com/v1/embeddings',
        { model: 'text-embedding-3-small', input: texts },
        { 'Authorization': `Bearer ${OPENAI_KEY}` }
      );

      if (resp.status !== 200) {
        console.error(`Batch ${bi+1} failed:`, resp.body);
        continue;
      }

      resp.body.data.forEach((item, idx) => {
        embeddings[batch[idx].id] = item.embedding;
      });

      console.log(`Batch ${bi+1}/${batches.length} done`);

      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 100));

    } catch(err) {
      console.error(`Batch ${bi+1} error:`, err.message);
    }
  }

  console.log(`Done: ${Object.keys(embeddings).length} embeddings generated`);

  // Return as downloadable JSON
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="embeddings.json"');
  res.status(200).send(JSON.stringify(embeddings));
};
