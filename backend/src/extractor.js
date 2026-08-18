import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import { marked } from 'marked';
import { assertPublicHttpUrl } from './urlSafety.js';

const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const CLOUD_FIRST_DOMAINS = ['aliexpress', 'amazon', 'mercadolivre', 'mercadolibre', 'shopee', 'temu'];
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const JUNK_SELECTORS = [
  '.advertisement', '.ad', '.ads', '[class*="banner"]', '[id*="banner"]',
  '.social-share', '.share-buttons', '[class*="share"]',
  '.comments', '#comments', '.comment-section', '.disqus',
  '.newsletter', '.popup', '.modal', '[class*="cookie"]',
  'nav', 'footer', '.related-articles', '.recommended', '.sidebar',
  '[class*="paywall"]', '[class*="subscribe"]',
];

export async function extractArticle(url) {
  const fetchResult = await fetchData(url);

  if (fetchResult.source === 'cloud') {
    return extractCloudData(fetchResult.data, url);
  }

  return extractArticleFromHtml(fetchResult.html, url);
}

export function extractArticleFromHtml(html, url) {
  const raw$ = cheerio.load(html);
  const product = extractProduct(raw$, url);
  if (product) return buildProductArticle(product, url);

  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const pageTitle = cleanText(doc.title) || 'Sem título';

  JUNK_SELECTORS.forEach((selector) => {
    try {
      doc.querySelectorAll(selector).forEach((element) => element.remove());
    } catch {
      // Um seletor inválido não deve interromper a extração inteira.
    }
  });

  const article = new Readability(doc.cloneNode(true), { keepClasses: false }).parse();
  const isUsableArticle = article?.textContent?.trim().length > 180 && article?.content;

  if (isUsableArticle) {
    const $ = cheerio.load(article.content);
    $('script, style, iframe, noscript, form, button').remove();
    const content = [];
    const images = [];
    $('body').children().each((_, element) => walk($, element, content, images, url));

    if (content.length) {
      return finishArticle({
        title: article.title || pageTitle,
        byline: article.byline || null,
        siteName: article.siteName || null,
        excerpt: article.excerpt || null,
        content,
        images,
      });
    }
  }

  return extractFallback(html, url, pageTitle);
}

function extractCloudData(data, url) {
  const markdown = data?.content || '';
  if (!markdown.trim()) throw new Error('EXTRACTION_FAILED');

  const html = marked.parse(markdown);
  const $ = cheerio.load(html);
  const content = [];
  const images = [];
  $('body').children().each((_, element) => walk($, element, content, images, url));
  if (!content.length) throw new Error('EXTRACTION_FAILED');

  return finishArticle({
    title: cleanText(data?.title) || $('h1').first().text().trim() || 'Sem título',
    byline: cleanText(data?.siteName) || 'Extração alternativa',
    siteName: cleanText(data?.siteName) || new URL(url).hostname,
    excerpt: cleanText(data?.description) || null,
    content,
    images,
  });
}

function extractProduct($, baseUrl) {
  const structured = findProductJsonLd($);
  const offer = firstOffer(structured?.offers);

  const name = firstNonEmpty(
    structured?.name,
    metaContent($, 'property', 'og:title'),
    metaContent($, 'name', 'twitter:title'),
    $('[itemprop="name"]').first().text(),
    $('h1').first().text(),
  );

  const price = firstNonEmpty(
    offer?.price,
    offer?.lowPrice,
    metaContent($, 'property', 'product:price:amount'),
    metaContent($, 'itemprop', 'price'),
    $('[itemprop="price"]').first().attr('content'),
    $('[itemprop="price"]').first().text(),
    $('[data-testid*="price"], [data-test*="price"], .andes-money-amount__fraction, .price, [class*="price"], [class*="Price"]').first().text(),
  );

  const currency = firstNonEmpty(
    offer?.priceCurrency,
    metaContent($, 'property', 'product:price:currency'),
    $('[itemprop="priceCurrency"]').first().attr('content'),
  );

  const description = firstNonEmpty(
    structured?.description,
    metaContent($, 'property', 'og:description'),
    metaContent($, 'name', 'description'),
    $('[itemprop="description"]').first().text(),
  );

  const brand = firstNonEmpty(
    typeof structured?.brand === 'string' ? structured.brand : structured?.brand?.name,
    $('[itemprop="brand"]').first().attr('content'),
    $('[itemprop="brand"]').first().text(),
  );

  const availability = firstNonEmpty(
    offer?.availability,
    metaContent($, 'property', 'product:availability'),
    $('[itemprop="availability"]').first().attr('href'),
    $('[itemprop="availability"]').first().text(),
  );

  const seller = firstNonEmpty(
    typeof offer?.seller === 'string' ? offer.seller : offer?.seller?.name,
    $('[itemprop="seller"]').first().text(),
  );

  const rating = firstNonEmpty(
    structured?.aggregateRating?.ratingValue,
    $('[itemprop="ratingValue"]').first().attr('content'),
    $('[itemprop="ratingValue"]').first().text(),
  );

  const reviewCount = firstNonEmpty(
    structured?.aggregateRating?.reviewCount,
    structured?.aggregateRating?.ratingCount,
    $('[itemprop="reviewCount"]').first().attr('content'),
    $('[itemprop="reviewCount"]').first().text(),
  );

  const sku = firstNonEmpty(structured?.sku, structured?.mpn, $('[itemprop="sku"]').first().text());
  const imageCandidates = normalizeImageCandidates(structured?.image);
  imageCandidates.push(
    metaContent($, 'property', 'og:image'),
    metaContent($, 'name', 'twitter:image'),
    $('[itemprop="image"]').first().attr('src'),
  );

  const images = [...new Set(imageCandidates.filter(Boolean).map((source) => resolveUrl(source, baseUrl)))];
  const hasStrongSignal = Boolean(structured || (name && price) || ($('[itemtype*="schema.org/Product"]').length && name));
  if (!hasStrongSignal) return null;

  return {
    name: cleanText(name) || 'Produto',
    description: cleanText(description) || null,
    price: normalizePrice(price),
    currency: cleanText(currency) || null,
    availability: cleanAvailability(availability),
    brand: cleanText(brand) || null,
    seller: cleanText(seller) || null,
    rating: cleanText(rating) || null,
    reviewCount: cleanText(reviewCount) || null,
    sku: cleanText(sku) || null,
    images,
  };
}

function buildProductArticle(product, url) {
  const details = [];
  const formattedPrice = formatPrice(product.price, product.currency);
  if (formattedPrice) details.push(`Preço: ${formattedPrice}`);
  if (product.availability) details.push(`Disponibilidade: ${product.availability}`);
  if (product.brand) details.push(`Marca: ${product.brand}`);
  if (product.seller) details.push(`Vendido por: ${product.seller}`);
  if (product.rating) details.push(`Avaliação: ${product.rating}${product.reviewCount ? ` (${product.reviewCount} avaliações)` : ''}`);
  if (product.sku) details.push(`Código/SKU: ${product.sku}`);

  const content = [];
  if (details.length) content.push({ type: 'list', ordered: false, items: details });
  if (product.description) {
    content.push({ type: 'heading', level: 2, text: 'Descrição' });
    content.push({ type: 'paragraph', text: product.description });
  }
  product.images.forEach((src) => content.push({ type: 'image', src, alt: product.name }));

  if (!content.length) content.push({ type: 'paragraph', text: product.name });

  return finishArticle({
    title: product.name,
    byline: product.brand || product.seller || 'Produto',
    siteName: new URL(url).hostname,
    excerpt: product.description,
    content,
    images: product.images.map((src) => ({ src, alt: product.name })),
    type: 'product',
    product,
  });
}

function extractFallback(html, url, pageTitle) {
  const $ = cheerio.load(html);
  $('nav, footer, header, aside, .menu, script, style, form').remove();
  const content = [];
  const marketItems = new Set();

  $('[data-test="instrument-price-last"], .text-5xl.font-bold, .pid-ext-price').each((_, element) => {
    const value = cleanText($(element).text());
    const name = cleanText($('h1').first().text()) || 'Ativo';
    if (value && /^[0-9.,]+$/.test(value)) marketItems.add(`💰 ${name}: ${value}`);
  });

  if (marketItems.size) {
    content.push({ type: 'heading', level: 2, text: '📈 Cotações' });
    content.push({ type: 'list', ordered: false, items: [...marketItems] });
  }

  const headlines = new Set();
  $('h1, h2, h3, h4, .post-title, .title').each((_, element) => {
    const text = cleanText($(element).text());
    if (text.length >= 20 && text.split(/\s+/).length >= 3) headlines.add(text);
  });

  if (headlines.size) {
    content.push({ type: 'heading', level: 2, text: '📰 Conteúdo encontrado' });
    content.push({ type: 'list', ordered: false, items: [...headlines] });
  }

  if (!content.length) throw new Error('EXTRACTION_FAILED');
  return finishArticle({
    title: pageTitle,
    byline: 'Resumo automático',
    siteName: new URL(url).hostname,
    excerpt: null,
    content,
    images: [],
  });
}

function finishArticle(article) {
  const wordCount = getWordCount(article.content);
  return {
    ...article,
    wordCount,
    readingTimeMinutes: Math.max(1, Math.round(wordCount / 200)),
  };
}

function getWordCount(content) {
  return content.reduce((sum, block) => {
    if (['paragraph', 'heading', 'quote'].includes(block.type)) {
      return sum + cleanText(block.text).split(/\s+/).filter(Boolean).length;
    }
    if (block.type === 'list') {
      return sum + (block.items || []).join(' ').split(/\s+/).filter(Boolean).length;
    }
    return sum;
  }, 0);
}

function walk($, element, content, images, baseUrl) {
  const tag = element.tagName ? element.tagName.toLowerCase() : null;
  if (!tag) return;
  const node = $(element);

  if (/^h[1-6]$/.test(tag)) {
    const text = cleanText(node.text());
    if (text) content.push({ type: 'heading', level: Number(tag[1]), text });
    return;
  }

  if (tag === 'p') {
    const text = cleanText(node.text());
    if (text) content.push({ type: 'paragraph', text });
    node.find('img').each((_, image) => registerImage($, image, images, content, baseUrl));
    return;
  }

  if (tag === 'blockquote') {
    const text = cleanText(node.text());
    if (text) content.push({ type: 'quote', text });
    return;
  }

  if (tag === 'ul' || tag === 'ol') {
    const items = [];
    node.children('li').each((_, item) => {
      const text = cleanText($(item).text());
      if (text) items.push(text);
    });
    if (items.length) content.push({ type: 'list', ordered: tag === 'ol', items });
    return;
  }

  if (tag === 'img' || tag === 'figure') {
    const image = tag === 'img' ? element : node.find('img').get(0);
    if (image) registerImage($, image, images, content, baseUrl);
    return;
  }

  if (node.children().length) {
    node.children().each((_, child) => walk($, child, content, images, baseUrl));
  } else {
    const text = cleanText(node.text());
    if (text) content.push({ type: 'paragraph', text });
  }
}

function registerImage($, imageElement, images, content, baseUrl) {
  const source = $(imageElement).attr('src') || $(imageElement).attr('data-src') || $(imageElement).attr('data-lazy-src');
  if (!source) return;
  const src = resolveUrl(source, baseUrl);
  if (images.some((item) => item.src === src)) return;
  const alt = cleanText($(imageElement).attr('alt'));
  images.push({ src, alt });
  content.push({ type: 'image', src, alt });
}

function findProductJsonLd($) {
  const candidates = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const parsed = JSON.parse($(element).text().trim());
      collectJsonLd(parsed, candidates);
    } catch {
      // JSON-LD inválido é comum em páginas reais; ignoramos apenas o bloco defeituoso.
    }
  });
  return candidates.find((entry) => typeIncludes(entry?.['@type'], 'Product')) || null;
}

function collectJsonLd(value, output) {
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonLd(item, output));
    return;
  }
  if (typeof value !== 'object') return;
  output.push(value);
  if (Array.isArray(value['@graph'])) value['@graph'].forEach((item) => collectJsonLd(item, output));
}

function typeIncludes(value, expected) {
  if (Array.isArray(value)) return value.some((item) => String(item).toLowerCase() === expected.toLowerCase());
  return String(value || '').toLowerCase() === expected.toLowerCase();
}

function firstOffer(offers) {
  if (Array.isArray(offers)) return offers.find(Boolean) || null;
  return offers && typeof offers === 'object' ? offers : null;
}

function metaContent($, attribute, value) {
  return $(`meta[${attribute}="${value}"]`).first().attr('content') || '';
}

function firstNonEmpty(...values) {
  return values.find((value) => cleanText(value)) || '';
}

function normalizeImageCandidates(value) {
  if (Array.isArray(value)) return value.flatMap((item) => normalizeImageCandidates(item));
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return normalizeImageCandidates(value.url || value.contentUrl);
  return [];
}

function normalizePrice(value) {
  const cleaned = cleanText(value);
  if (!cleaned) return null;
  const match = cleaned.match(/(?:R\$|US\$|\$|€|£)?\s*([0-9][0-9.,]*)/);
  return match ? match[1] : cleaned;
}

function formatPrice(price, currency) {
  if (!price) return null;
  const symbols = { BRL: 'R$', USD: 'US$', EUR: '€', GBP: '£' };
  return `${symbols[String(currency || '').toUpperCase()] || cleanText(currency)}${currency ? ' ' : ''}${price}`.trim();
}

function cleanAvailability(value) {
  const cleaned = cleanText(value);
  if (!cleaned) return null;
  const token = cleaned.split('/').pop();
  const labels = {
    InStock: 'Em estoque',
    OutOfStock: 'Sem estoque',
    PreOrder: 'Pré-venda',
    LimitedAvailability: 'Estoque limitado',
    OnlineOnly: 'Somente online',
    SoldOut: 'Esgotado',
  };
  return labels[token] || token || cleaned;
}

function cleanText(value = '') {
  if (value == null) return '';
  if (typeof value === 'object') return '';
  return String(value).trim().replace(/\s+/g, ' ');
}

function resolveUrl(source, baseUrl) {
  try {
    return new URL(source, baseUrl).toString();
  } catch {
    return source;
  }
}

async function fetchData(url) {
  const cloudFirst = CLOUD_FIRST_DOMAINS.some((domain) => new URL(url).hostname.toLowerCase().includes(domain));
  const attempts = cloudFirst ? [fetchCloud, fetchNative] : [fetchNative, fetchCloud];
  let lastError = null;

  for (const attempt of attempts) {
    try {
      return await attempt(url);
    } catch (error) {
      lastError = error;
      if (error?.message === 'PAGE_TOO_LARGE' || error?.message === 'HTTP_404') throw error;
    }
  }

  throw lastError || new Error('EXTRACTION_FAILED');
}

async function fetchNative(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetchWithSafeRedirects(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    if (response.status === 404) throw new Error('HTTP_404');
    if (!response.ok) throw new Error(`HTTP_${response.status}`);

    const contentType = response.headers.get('content-type') || '';
    if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      throw new Error('CONTENT_TYPE_UNSUPPORTED');
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_PAGE_BYTES) throw new Error('PAGE_TOO_LARGE');

    const html = await response.text();
    if (Buffer.byteLength(html, 'utf8') > MAX_PAGE_BYTES) throw new Error('PAGE_TOO_LARGE');
    if (!html.trim() || looksLikeChallenge(html)) throw new Error('CHALLENGE_PAGE');

    return { source: 'native', html };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCloud(url) {
  const response = await fetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 404) throw new Error('HTTP_404');
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const json = await response.json();
  const data = json?.data || json;
  if (!data?.content) throw new Error('EXTRACTION_FAILED');
  return { source: 'cloud', data };
}

function looksLikeChallenge(html) {
  const value = html.toLowerCase();
  return (
    value.includes('just a moment...') ||
    value.includes('enable javascript') ||
    value.includes('cf-chl-') ||
    value.includes('captcha') ||
    value.includes('access denied')
  );
}

async function fetchWithSafeRedirects(initialUrl, options) {
  let currentUrl = initialUrl;

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    await assertPublicHttpUrl(currentUrl);
    const response = await fetch(currentUrl, { ...options, redirect: 'manual' });

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response;
    await response.body?.cancel();
    currentUrl = new URL(location, currentUrl).toString();
  }

  throw new Error('TOO_MANY_REDIRECTS');
}
