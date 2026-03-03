const https = require('https');

function post(url, data, headers) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify(data);
    var u = new URL(url);
    var req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers}
    }, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve({status: res.statusCode, body: JSON.parse(d)}); }
        catch(e) { reject(new Error('Parse error: ' + d.slice(0,100))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({error: 'Method not allowed'});

  var OPENAI = process.env.OPENAI_API_KEY;
  if (!OPENAI) return res.status(500).json({error: 'OPENAI_API_KEY not set'});

  var query = (req.body || {}).query || '';
  var businesses = (req.body || {}).businesses || '';

  if (!query) return res.status(400).json({error: 'No query'});

  try {
    var r = await post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      max_tokens: 500,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'You are a search assistant for BUGMe.Travel, a road trip adventure platform covering Canada and USA. Given a traveler search query and a list of operators, pick the TOP 6 most relevant. Always prioritize operators marked PASS_OFFER if they are relevant. Return ONLY a valid JSON array with no extra text: [{"id": 123, "reason": "one friendly sentence explaining why this matches"}]'
        },
        {
          role: 'user',
          content: 'Search: "' + query + '"\n\nOperators:\n' + businesses
        }
      ]
    }, {'Authorization': 'Bearer ' + OPENAI});

    if (r.status !== 200) {
      return res.status(500).json({error: r.body.error ? r.body.error.message : 'OpenAI error'});
    }

    var text = r.body.choices && r.body.choices[0] && r.body.choices[0].message && r.body.choices[0].message.content || '[]';
    text = text.replace(/```json|```/g, '').trim();
    var picks = JSON.parse(text);
    return res.status(200).json({text: JSON.stringify(picks)});

  } catch(e) {
    return res.status(500).json({error: e.message});
  }
};
