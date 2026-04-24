const express = require('express');
const Parser = require('rss-parser');
const path = require('path');

const app = express();
const parser = new Parser({ timeout: 10000 });
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

function classify(title, summary, feedCat) {
  const text = `${title} ${summary}`;
  const isTech = TECH_KW.test(text) || feedCat === 'tech';
  const isGeo = GEO_KW.test(text) || feedCat === 'geo';
  if (isTech && isGeo) return 'tech-geo';
  if (isGeo) return 'geo';
  return 'tech';
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
  const { title, summary, url } = req.body;
  if (!title || !url) return res.status(400).json({ error: 'title and url required' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  const prompt = `Tu es Michel, fondateur d'un club IA. Tu partages des news tech/géopolitique avec ta communauté.

Règles STRICTES:
- Français, style direct, pas corporate
- Accroche percutante (pourquoi c'est important)  
- Donne ton opinion ou un insight, pas juste un résumé
- Le message ENTIER (texte + URL) doit faire MOINS de 400 caractères
- Termine par l'URL sur une nouvelle ligne
- Pas de hashtags, pas d'emoji excessifs (1 max au début si pertinent)

Article:
Titre: ${title}
Résumé: ${summary}
URL: ${url}

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

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const message = data.choices?.[0]?.message?.content?.trim() || '';
    res.json({ message, chars: message.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TechWatch running on port ${PORT}`));
