# Mandala Cloud Server

A minimal proxy that sits between the Mandala app and the Anthropic API.
Users download the app and use it instantly — no API key, no setup.

## Deploy to Railway (recommended — free tier available)

1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Add environment variable: ANTHROPIC_API_KEY = your key from console.anthropic.com
4. Railway gives you a URL like: https://mandala-cloud-production.up.railway.app
5. Paste that URL into the Mandala app as MANDALA_CLOUD_URL

## Deploy to Fly.io (alternative)

    fly launch
    fly secrets set ANTHROPIC_API_KEY=sk-ant-...
    fly deploy

## Deploy locally (for testing)

    npm install
    cp .env.example .env
    # edit .env with your key
    npm start

## Cost estimate

Each dream cycle (Analyze + Integrate + Individuate + Symbol) uses roughly:
- ~2000 input tokens + ~1000 output tokens per stage
- Total per full cycle: ~$0.015–0.03

10 active friends × 3 cycles/week = ~$1–2/month
