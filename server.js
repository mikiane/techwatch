const express = require('express');
const Parser = require('rss-parser');
const path = require('path');

const app = express();
const parser = new Parser({
  timeout: 10000,
  customFields: {
    item: [
      ['media:content', 'media:content', { keepArray: true }],
      ['media:thumbnail', 'media:thumbnail', { keepArray: true }],
    ],
  },
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const FEEDS = [
  { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', source: 'BBC Tech', cat: 'tech' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', source: 'BBC World', cat: 'geo' },
  { url: 'https://www.wired.com/feed/rss', source: 'Wired', cat: 'tech' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', source: 'Al Jazeera', cat: 'geo' },
  { url: 'https://techcrunch.com/feed/', source: 'TechCrunch', cat: 'tech' },
  { url: 'https://feeds.arstechnica.com/arstechnica/index', source: 'Ars Technica', cat: 'tech' },
  { url: 'https://www.france24.com/fr/rss', source: 'France 24', cat: 'geo' },
  { url: 'https://www.theverge.com/rss/index.xml', source: 'The Verge', cat: 'tech' },
  { url: 'https://www.theregister.com/headlines.atom', source: 'The Register', cat: 'tech' },
  { url: 'https://www.zdnet.com/news/rss.xml', source: 'ZDNet', cat: 'tech' },
];

const TECH_KW = /\bai\b|artificial|openai|gpt|llm|chip|semiconductor|quantum|cyber|hack|data|cloud|robot|automat|drone|starlink|spacex|tesla|apple|google|microsoft|meta|nvidia|crypto|blockchain|saas/i;
const GEO_KW = /sanction|war|nato|ukraine|china|taiwan|tariff|trade|regulation|eu\b|congress|pentagon|military|nuclear|sovereignty|border|diplomacy|geopolit|election|coup|embargo/i;
const generateMessageRateLimits = new Map();
const GENERATE_MESSAGE_LIMIT = 10;
const GENERATE_MESSAGE_WINDOW_MS = 60 * 1000;

function classify(title, summary, feedCat) {
  const text = `${title} ${summary}`;
  const isTech = TECH_KW.test(text) || feedCat === 'tech';
  const isGeo = GEO_KW.test(text) || feedCat === 'geo';
  if (isTech && isGeo) return 'tech-geo';
  if (isGeo) return 'geo';
  return 'tech';
}

function normalizeImageUrl(value, baseUrl) {
  if (typeof value !== 'string') return null;

  const cleanValue = value.trim().replace(/&amp;/g, '&');
  if (!cleanValue) return null;

  try {
    const imageUrl = cleanValue.startsWith('//')
      ? new URL(`https:${cleanValue}`)
      : new URL(cleanValue, baseUrl || undefined);

    return imageUrl.protocol === 'http:' || imageUrl.protocol === 'https:'
      ? imageUrl.href
      : null;
  } catch {
    return null;
  }
}

function extractMediaUrl(mediaField, baseUrl) {
  if (!mediaField) return null;

  const mediaItems = Array.isArray(mediaField) ? mediaField : [mediaField];
  for (const mediaItem of mediaItems) {
    if (!mediaItem) continue;

    if (typeof mediaItem === 'string') {
      const url = normalizeImageUrl(mediaItem, baseUrl);
      if (url) return url;
      continue;
    }

    const directUrl = normalizeImageUrl(mediaItem.url, baseUrl)
      || normalizeImageUrl(mediaItem.href, baseUrl)
      || normalizeImageUrl(mediaItem.$?.url, baseUrl)
      || normalizeImageUrl(mediaItem.$?.href, baseUrl);

    if (directUrl) return directUrl;
  }

  return null;
}

function extractImageFromContent(content, baseUrl) {
  if (typeof content !== 'string') return null;

  const match = content.match(/<img\b[^>]*\bsrc=["']?([^"'\s>]+)["']?[^>]*>/i);
  return match ? normalizeImageUrl(match[1], baseUrl) : null;
}

function extractArticleImage(item) {
  const baseUrl = item.link || item.guid || '';

  return normalizeImageUrl(item.enclosure?.url, baseUrl)
    || extractMediaUrl(item['media:content'], baseUrl)
    || extractMediaUrl(item['media:thumbnail'], baseUrl)
    || extractImageFromContent(item.content, baseUrl)
    || extractImageFromContent(item['content:encoded'], baseUrl)
    || null;
}

function stripHtmlTags(value) {
  return value.replace(/<[^>]*>/g, '');
}

function cleanText(value, maxLength) {
  return stripHtmlTags(value).trim().slice(0, maxLength);
}

function escapePromptValue(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/\r?\n/g, '\\n');
}

function getClientIp(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

function checkGenerateMessageRateLimit(req) {
  const now = Date.now();
  const ip = getClientIp(req);
  const current = generateMessageRateLimits.get(ip);

  if (!current || now - current.windowStart >= GENERATE_MESSAGE_WINDOW_MS) {
    generateMessageRateLimits.set(ip, { count: 1, windowStart: now });
    return true;
  }

  if (current.count >= GENERATE_MESSAGE_LIMIT) return false;

  current.count += 1;
  return true;
}

let cachedNews = [];
let lastFetch = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 min

async function fetchAllFeeds() {
  if (Date.now() - lastFetch < CACHE_TTL && cachedNews.length > 0) return cachedNews;

  const results = await Promise.allSettled(
    FEEDS.map(async (f) => {
      try {
        const feed = await parser.parseURL(f.url);
        return feed.items.slice(0, 15).map((item) => ({
          title: item.title || '',
          summary: (item.contentSnippet || item.content || '').slice(0, 300),
          url: item.link || '',
          image: extractArticleImage(item),
          date: item.isoDate || item.pubDate || '',
          source: f.source,
          category: classify(item.title || '', item.contentSnippet || '', f.cat),
        }));
      } catch {
        return [];
      }
    })
  );

  const articles = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  cachedNews = articles;
  lastFetch = Date.now();
  return articles;
}

// API: list news
app.get('/api/news', async (req, res) => {
  try {
    const articles = await fetchAllFeeds();
    const filter = req.query.cat;
    const filtered = filter && filter !== 'all'
      ? articles.filter((a) => a.category === filter || (filter === 'tech-geo' && a.category === 'tech-geo'))
      : articles;
    res.json({ count: filtered.length, articles: filtered });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: generate Club IA message
app.post('/api/generate-message', async (req, res) => {
  if (!checkGenerateMessageRateLimit(req)) {
    return res.status(429).json({ error: 'Rate limit exceeded: maximum 10 requests per minute' });
  }

  const { title, summary, url } = req.body || {};
  if (typeof title !== 'string' || typeof summary !== 'string' || typeof url !== 'string') {
    return res.status(400).json({ error: 'Invalid input: title, summary and url must be strings' });
  }

  const cleanTitle = cleanText(title, 500);
  const cleanSummary = cleanText(summary, 1000);
  const cleanUrl = cleanText(url, url.length);

  if (!cleanTitle || !cleanUrl) return res.status(400).json({ error: 'title and url required' });
  if (!cleanUrl.startsWith('http')) return res.status(400).json({ error: 'Invalid url: must start with http' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  const safeTitle = escapePromptValue(cleanTitle);
  const safeSummary = escapePromptValue(cleanSummary);
  const safeUrl = escapePromptValue(cleanUrl);

  const prompt = `Tu es Michel, fondateur d'un club IA. Tu partages des news tech/géopolitique avec ta communauté.

Règles STRICTES:
- Français, style direct, pas corporate
- Accroche percutante (pourquoi c'est important)  
- Donne ton opinion ou un insight, pas juste un résumé
- Le message ENTIER (texte + URL) doit faire MOINS de 400 caractères
- Termine par l'URL sur une nouvelle ligne
- Pas de hashtags, pas d'emoji excessifs (1 max au début si pertinent)

Article:
Titre: ${safeTitle}
Résumé: ${safeSummary}
URL: ${safeUrl}

Génère le message:`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0.8,
      }),
    });

    const responseText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: `OpenAI request failed (${response.status}): ${response.statusText || 'API error'}` });
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      return res.status(502).json({ error: 'OpenAI returned an invalid JSON response' });
    }

    if (data.error) return res.status(500).json({ error: data.error.message });

    const message = data.choices?.[0]?.message?.content?.trim() || '';
    res.json({ message, chars: message.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TechWatch running on port ${PORT}`));
