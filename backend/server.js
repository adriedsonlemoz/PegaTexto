import express from 'express';
import cors from 'cors';
import NodeCache from 'node-cache';
import { extractArticle } from './src/extractor.js';
import { assertPublicHttpUrl } from './src/urlSafety.js';

const app = express();
const cache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '16kb' }));

app.post('/api/extract', async (req, res) => {
  const { url } = req.body || {};

  try {
    const safeUrl = await assertPublicHttpUrl(url);
    const cachedArticle = cache.get(safeUrl);

    if (cachedArticle) {
      console.log(`✅ Retornando do cache: ${safeUrl}`);
      return res.json(cachedArticle);
    }

    console.log(`🔍 Extraindo: ${safeUrl}`);
    const article = await extractArticle(safeUrl);
    cache.set(safeUrl, article);
    return res.json(article);
  } catch (err) {
    const code = err?.message || 'EXTRACTION_FAILED';
    console.error('Erro na extração:', code);

    if (code === 'URL_INVALIDA') return res.status(400).json({ error: code });
    if (code === 'URL_BLOQUEADA') return res.status(403).json({ error: code });
    if (code === 'HOST_INACESSIVEL') return res.status(422).json({ error: code });
    return res.status(422).json({ error: code });
  }
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
