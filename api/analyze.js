// Vercel serverless function — Anthropic API proxy
// API key stays server-side; never exposed to the browser.

module.exports = async function handler(req, res) {
  // Handle CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server' });
  }

  const { content } = req.body ?? {};
  if (!Array.isArray(content) || content.length === 0) {
    return res.status(400).json({ error: '`content` array is required' });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages:   [{ role: 'user', content }],
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      // Anthropic error: { "error": { "type": "...", "message": "..." } }
      const msg = data?.error?.message || JSON.stringify(data?.error) || `Anthropic error ${upstream.status}`;
      return res.status(upstream.status).json({ error: msg });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// Allow up to 6 MB body (6 frames × base64-encoded JPEG)
module.exports.config = {
  api: { bodyParser: { sizeLimit: '6mb' } },
};
