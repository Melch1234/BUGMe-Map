const https = require('https');

function post(url, data, headers) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify(data);
    var u = new URL(url);
    var req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: Object.assign({'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}, headers)
    }, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve({status: res.statusCode, body: JSON.parse(d)}); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function get(url) {
  return new Promise(function(resolve, reject) {
    https.get(url, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve({status: res.statusCode, body: JSON.parse(d)}); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function cosine(a, b) {
  var dot = 0, ma = 0, mb = 0;
  for (var i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    ma += a[i] * a[i];
    mb += b[i] * b[i];
  }
  return dot / (Math.sqrt(ma) * Math.sqrt(mb));
}

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  var OPENAI = process.env.OPENAI_API_KEY;
  var ANTHROPIC = process.env.ANTHROPIC_API_KEY;
  var MAPBOX = 'pk.eyJ1Ijoicm9hZGllMTIzNCIsImEiOiJjbW0yZ25oNzEwN3k1MnNwcnN5bWxoM3ptIn0.EjJEPhnVy_-lu1FfopPctg';

  var body = req.body || {};
  var query = body.query;
  var businesses = body.businesses;
  var mode = body.mode;

  if (mode === 'embed') {
    if (!OPENAI) return res.status(500).json({error: 'OPENAI_API_KEY not set'});
    if (!businesses || !businesses.length) return res.status(400).json({error: 'No businesses'});
    var texts = businesses.map(function(b) {
      return b.name + '. ' + (b.address || '') + '. ' + (b.tags || []).join(', ') + '.';
    });
    try {
      var r = await post('https://api.openai.com/v1/embeddings',
        {model: 'text-embedding-3-small', input: texts},
        {'Authorization': 'Bearer ' + OPENAI}
      );
      if (r.status !== 200) return res.status(500).json({error: r.body.error ? r.body.error.message : 'OpenAI error'});
      var embeddings = {};
      r.body.data.forEach(function(item, idx) {
        embeddings[businesses[idx].id] = item.embedding;
      });
      return res.status(200).json({embeddings: embeddings});
    } catch(e) {
      return res.status(500).json({error: e.message});
    }
  }

  if (!query) return res.status(400).json({error: 'No query'});
  if (!businesses || !businesses.length) return res.status(400).json({error: 'No businesses'});

  try {
    var geoUrl = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' + encodeURIComponent(query) + '.json?access_token=' + MAPBOX + '&types=country,region,district,place,locality&limit=1';
    var geoResp = await get(geoUrl);
    var feature = geoResp.body.features && geoResp.body.features[0];
    var candidates = businesses.filter(function(b) { return b.lat && b.lng; });

    if (feature) {
      var searchLng = feature.center[0];
      var searchLat = feature.center[1];
      var placeType = feature.place_type && feature.place_type[0];
      var placeName = feature.place_name;
      var isLarge = placeType === 'country' || placeType === 'region';
      candidates = candidates.filter(function(b) {
        if (isLarge) {
          var addr = (b.address || '').toLowerCase();
          var words = placeName.toLowerCase().split(/[\s,]+/).filter(function(w) { return w.length > 3; });
          return words.some(function(w) { return addr.indexOf(w) !== -1; });
        }
        var R = 6371;
        var dLat = (b.lat - searchLat) * Math.PI / 180;
        var dLng = (b.lng - searchLng) * Math.PI / 180;
        var a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(searchLat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)*Math.sin(dLng/2);
        var dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return dist <= 300;
      });
    }

    if (!candidates.length) return res.status(200).json({results: [], message: 'No operators found'});

    if (OPENAI) {
      try {
        var qEmbed = await post('https://api.openai.com/v1/embeddings',
          {model: 'text-embedding-3-small', input: query},
          {'Authorization': 'Bearer ' + OPENAI}
        );
        var qVec = qEmbed.body.data && qEmbed.body.data[0] && qEmbed.body.data[0].embedding;
        if (qVec) {
          var top30 = candidates.slice(0, 30);
          var ctexts = top30.map(function(b) {
            return b.name + '. ' + (b.address || '') + '. ' + (b.tags || []).join(', ') + '.';
          });
          var cEmbed = await post('https://api.openai.com/v1/embeddings',
            {model: 'text-embedding-3-small', input: ctexts},
            {'Authorization': 'Bearer ' + OPENAI}
          );
          candidates = top30.map(function(b, i) {
            var vec = cEmbed.body.data && cEmbed.body.data[i] && cEmbed.body.data[i].embedding;
            var score = vec ? cosine(qVec, vec) : 0;
            if (b.offer) score += 0.05;
            return Object.assign({}, b, {_score: score});
          }).sort(function(a, b) { return b._score - a._score; });
        }
      } catch(e) { console.error('Embed error:', e.message); }
    }

    var top8 = candidates.slice(0, 8);
    var bizList = top8.map(function(b) {
      return 'ID:' + b.id + '|' + b.name + '|' + (b.address || '').replace(/\n/g, ' ') + '|' + (b.tags || []).slice(0,5).join(',') + (b.offer ? '|PASS_OFFER' : '');
    }).join('\n');

    if (!ANTHROPIC) return res.status(200).json({results: top8.slice(0,6).map(function(b) { return {id: b.id, reason: ''}; })});

    var claudeResp = await post('https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{role: 'user', content: 'Search: "' + query + '"\nPick TOP 6, prioritize PASS_OFFER. Return ONLY JSON array:\n[{"id":123,"reason":"one sentence"}]\n\n' + bizList}]
      },
      {'x-api-key': ANTHROPIC, 'anthropic-version': '2023-06-01'}
    );

    var text = claudeResp.body.content && claudeResp.body.content[0] && claudeResp.body.content[0].text || '[]';
    var picks = JSON.parse(text.replace(/```json|```/g, '').trim());
    return res.status(200).json({results: picks});

  } catch(err) {
    console.error('Search error:', err);
    return res.status(500).json({error: err.message});
  }
};
