const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'] }));
app.options('*', cors());

const apiLimiter = rateLimit({ windowMs: 60*1000, max: 30 });

app.get('/health', (req, res) => {
  res.json({
    status: 'alive',
    hasKey: !!process.env.ANTHROPIC_API_KEY,
    time: new Date().toISOString()
  });
});

app.post('/api/dream', apiLimiter, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server not configured — API key missing.' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'API error' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Proxy error: ' + e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Mandala Cloud running on port ' + PORT + ' — key present: ' + !!process.env.ANTHROPIC_API_KEY));
