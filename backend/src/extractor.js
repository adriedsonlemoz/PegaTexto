import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import { marked } from 'marked';
import { assertPublicHttpUrl } from './urlSafety.js';
import {
  classifyPage,
  cleanProductDescription,
  detectSite,
  inferCurrency,
  isLikelyProductUrl,
  isProductJunkText,
  normalizeProductPrice,
  pickBestProductTitle,
  scoreProductQuality,
} from './pageIntelligence.js';

const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const CLOUD_FIRST_DOMAINS = ['aliexpress', 'amazon', 'mercadolivre', 'mercadolibre', 'shopee', 'temu'];
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const PRODUCT_IMAGE_BAD = /(?:logo|avatar|icon|sprite|payment|voucher|qr|qrcode|badge|flag|footer|header|banner|placeholder|tracking|pixel)/i;
const JUNK_SELECTORS = [
  '.advertisement', '.ad', '.ads', '[class*="banner"]', '[id*="banner"]',
  '.social-share', '.share-buttons', '[class*="share"]',
  '.comments', '#comments', '.comment-section', '.disqus',
  '.newsletter', '.popup', '.modal', '[class*="cookie"]',
  'nav', 'footer', '.related-articles', '.recommended', '.sidebar',
  '[class*="paywall"]', '[class*="subscribe"]',
];

export async function extractArticle(url) {
  const cloudFirst = CLOUD_FIRST_DOMAINS.some((domain) => new URL(url).hostname.toLowerCase().includes(domain));
  const attempts = cloudFirst
    ? [async () => extractCloudData((await fetchCloud(url)).data, url), async () => extractArticleFromHtml((await fetchNative(url)).html, url)]
    : [async () => extractArticleFromHtml((await fetchNative(url)).html, url), async () => extractCloudData((await fetchCloud(url)).data, url)];
  let bestResult = null;
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (isLikelyProductUrl(url) && result.type !== 'product') { lastError = new Error('PRODUCT_NOT_RECOGNIZED'); continue; }
      if (!bestResult || resultQualityScore(result) > resultQualityScore(bestResult)) bestResult = result;
      if (shouldAcceptResult(result)) return result;
    } catch (error) {
      lastError = error;
      if (error?.message === 'PAGE_TOO_LARGE' || error?.message === 'HTTP_404') throw error;
    }
  }
  if (bestResult) return bestResult;
  throw lastError || new Error('EXTRACTION_FAILED');
}

export function extractArticleFromHtml(html, url) {
  const raw$ = cheerio.load(html);
  const pageImages = collectPageImages(raw$, url);
  const product = extractProduct(raw$, url, { pageImages, rawHtml: html });
  if (product) return buildProductArticle(product, url, pageImages);

  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const pageTitle = cleanText(doc.title) || 'Sem título';
  JUNK_SELECTORS.forEach((selector) => { try { doc.querySelectorAll(selector).forEach((element) => element.remove()); } catch {} });
  const article = new Readability(doc.cloneNode(true), { keepClasses: false }).parse();
  const usable = article?.textContent?.trim().length > 180 && article?.content;
  if (usable) {
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
        images: mergeImages(images, pageImages),
        type: 'article',
        extraction: { source: 'direct', site: detectSite(url) },
      });
    }
  }
  return extractFallback(html, url, pageTitle, pageImages);
}

function extractCloudData(data, url) {
  const markdown = data?.content || '';
  if (!markdown.trim()) throw new Error('EXTRACTION_FAILED');
  const html = marked.parse(markdown);
  const $ = cheerio.load(html);
  const pageImages = collectPageImages($, url);
  const product = extractProduct($, url, {
    pageImages,
    cloud: true,
    cloudTitle: data?.title,
    cloudDescription: data?.description,
  });
  if (product) return buildProductArticle(product, url, pageImages);

  const content = [];
  const images = [];
  $('body').children().each((_, element) => walk($, element, content, images, url, true));
  if (!content.length) throw new Error('EXTRACTION_FAILED');
  return finishArticle({
    title: cleanText(data?.title) || $('h1').first().text().trim() || 'Sem título',
    byline: cleanText(data?.siteName) || 'Extração alternativa',
    siteName: cleanText(data?.siteName) || new URL(url).hostname,
    excerpt: cleanText(data?.description) || null,
    content,
    images: mergeImages(images, pageImages),
    type: classifyPage({ url, articleTextLength: getWordCount(content) * 6, headings: content.filter((b) => b.type === 'heading').length }).type,
    extraction: { source: 'jina', site: detectSite(url) },
  });
}

function extractProduct($, baseUrl, context = {}) {
  const site = detectSite(baseUrl);
  const structured = findProductJsonLd($);
  const offer = firstOffer(structured?.offers);
  const lines = collectTextLines($);
  const headings = collectCandidateTitles($);
  const pageImages = context.pageImages || collectPageImages($, baseUrl);
  const genericName = firstNonEmpty(
    structured?.name,
    metaContent($, 'property', 'og:title'),
    metaContent($, 'name', 'twitter:title'),
    $('[itemprop="name"]').first().text(),
    $('h1').first().text(),
    context.cloudTitle,
  );
  const siteData = extractSiteSpecificProduct($, baseUrl, site, lines, headings, pageImages, context);
  const priceText = firstNonEmpty(
    siteData.priceText,
    offer?.price,
    offer?.lowPrice,
    metaContent($, 'property', 'product:price:amount'),
    $('[itemprop="price"]').first().attr('content'),
    $('[itemprop="price"]').first().text(),
    findPriceText(lines),
  );
  const currency = firstNonEmpty(
    offer?.priceCurrency,
    metaContent($, 'property', 'product:price:currency'),
    $('[itemprop="priceCurrency"]').first().attr('content'),
    inferCurrency(priceText, ['shopee', 'mercadolivre'].includes(site.id) ? 'BRL' : null),
  );
  const name = pickBestProductTitle([siteData.name, genericName, ...headings], genericName);
  const description = cleanProductDescription(firstNonEmpty(
    siteData.description,
    structured?.description,
    metaContent($, 'property', 'og:description'),
    metaContent($, 'name', 'description'),
    $('[itemprop="description"]').first().text(),
    context.cloudDescription,
  ));
  const brand = firstNonEmpty(siteData.brand, typeof structured?.brand === 'string' ? structured.brand : structured?.brand?.name, $('[itemprop="brand"]').first().attr('content'), $('[itemprop="brand"]').first().text());
  const seller = firstNonEmpty(siteData.seller, typeof offer?.seller === 'string' ? offer.seller : offer?.seller?.name, $('[itemprop="seller"]').first().text());
  const availability = cleanAvailability(firstNonEmpty(siteData.availability, offer?.availability, metaContent($, 'property', 'product:availability'), $('[itemprop="availability"]').first().attr('href'), $('[itemprop="availability"]').first().text()));
  const rating = cleanRating(firstNonEmpty(siteData.rating, structured?.aggregateRating?.ratingValue, $('[itemprop="ratingValue"]').first().attr('content'), $('[itemprop="ratingValue"]').first().text()));
  const reviewCount = firstNonEmpty(siteData.reviewCount, structured?.aggregateRating?.reviewCount, structured?.aggregateRating?.ratingCount, $('[itemprop="reviewCount"]').first().attr('content'), $('[itemprop="reviewCount"]').first().text());
  const sku = firstNonEmpty(siteData.sku, structured?.sku, structured?.mpn, $('[itemprop="sku"]').first().text());

  const structuredImages = normalizeImageCandidates(structured?.image).map((src) => ({ src: resolveImageUrl(src, baseUrl), alt: name, role: 'structured' })).filter((item) => item.src);
  const metaImages = [metaContent($, 'property', 'og:image'), metaContent($, 'name', 'twitter:image'), $('[itemprop="image"]').first().attr('src')]
    .map((src) => ({ src: resolveImageUrl(src, baseUrl), alt: name, role: 'meta' })).filter((item) => item.src);
  const productImages = rankProductImages(mergeImages(structuredImages, siteData.images || [], metaImages, pageImages), site, name);
  const classification = classifyPage({ url: baseUrl, hasStructuredProduct: Boolean(structured), title: name, price: priceText });
  if (classification.type !== 'product' && !isLikelyProductUrl(baseUrl)) return null;

  const product = {
    name,
    description: description || null,
    price: normalizeProductPrice(priceText),
    currency: cleanText(currency) || null,
    originalPrice: normalizeProductPrice(siteData.originalPriceText),
    discount: cleanText(siteData.discount) || null,
    installment: cleanText(siteData.installment) || null,
    availability,
    brand: cleanText(brand) || null,
    seller: cleanText(seller) || null,
    rating: rating || null,
    reviewCount: cleanText(reviewCount) || null,
    soldCount: cleanText(siteData.soldCount) || null,
    sku: cleanText(sku) || null,
    shipping: cleanText(siteData.shipping) || null,
    variations: normalizeVariations(siteData.variations),
    attributes: normalizeAttributes(siteData.attributes),
    images: productImages.map((image) => image.src),
    site: site.id,
    siteLabel: site.label,
    source: siteData.source || (structured ? 'structured-data' : context.cloud ? 'jina-heuristic' : 'page-heuristic'),
  };
  product.quality = scoreProductQuality(product, { siteSpecific: siteData.siteSpecific });
  return product;
}

function extractSiteSpecificProduct($, url, site, lines, headings, pageImages, context) {
  const common = extractCommonProductSignals($, lines, headings);
  if (site.id === 'shopee') return { ...common, ...extractShopee($, lines, headings, pageImages, context), siteSpecific: true, source: 'shopee-filter' };
  if (site.id === 'mercadolivre') return { ...common, ...extractMercadoLivre($, lines, headings, pageImages), siteSpecific: true, source: 'mercado-livre-filter' };
  if (site.id === 'amazon') return { ...common, ...extractAmazon($, lines, headings, pageImages), siteSpecific: true, source: 'amazon-filter' };
  return common;
}

function extractShopee($, lines, headings, pageImages, context) {
  const bodyText = lines.join(' ');
  const name = pickBestProductTitle([
    ...textFromSelectors($, '[data-sqe="name"], h1, main h2, strong, b'),
    ...headings,
    ...lines.filter((line) => line.length >= 20 && line.length <= 180),
  ], context.cloudTitle);
  return {
    name,
    priceText: firstNonEmpty(textFromSelectors($, '[data-sqe="price"], [class*="price"], [class*="Price"]')[0], findPriceText(lines)),
    originalPriceText: findOriginalPrice(lines),
    discount: matchText(bodyText, /(?:-|economize\s*)?(\d{1,2}%\s*(?:off|de desconto)?)/i),
    seller: firstNonEmpty(textFromSelectors($, '[data-sqe="shop-name"], [class*="shop-name"], [class*="seller"]')[0], labeledValue(lines, /(?:vendido por|loja|vendedor)\s*:?/i)),
    rating: findRating(lines), reviewCount: findReviewCount(lines), soldCount: findSoldCount(lines), shipping: findShipping(lines),
    description: firstNonEmpty(sectionText($, /descri(?:ç|c)[aã]o(?: do produto)?/i, /avalia|coment|denunciar|produtos relacionados|você também/i), findDescriptionFromLines(lines)),
    variations: extractVariations($, lines, /opções|variações|selecione/i),
    attributes: extractAttributes($),
    images: rankProductImages(pageImages, detectSite('https://shopee.com.br'), name).slice(0, 16),
  };
}

function extractMercadoLivre($, lines, headings, pageImages) {
  const name = pickBestProductTitle([...textFromSelectors($, 'h1.ui-pdp-title, h1, [class*="ui-pdp-title"]'), ...headings]);
  const fraction = cleanText($('.andes-money-amount__fraction').first().text());
  const cents = cleanText($('.andes-money-amount__cents').first().text());
  return {
    name,
    priceText: fraction ? `${fraction}${cents ? `,${cents}` : ''}` : findPriceText(lines),
    originalPriceText: firstNonEmpty(textFromSelectors($, '.andes-money-amount--previous, [class*="original-price"]')[0], findOriginalPrice(lines)),
    discount: firstNonEmpty(textFromSelectors($, '.ui-pdp-price__second-line__label, [class*="discount"]')[0], matchText(lines.join(' '), /(\d{1,2}%\s*OFF)/i)),
    seller: firstNonEmpty(textFromSelectors($, '.ui-pdp-seller__header__title, [class*="seller"]')[0], labeledValue(lines, /vendido por\s*:?/i)),
    rating: firstNonEmpty(textFromSelectors($, '.ui-pdp-review__rating, [class*="rating"]')[0], findRating(lines)),
    reviewCount: findReviewCount(lines), soldCount: firstNonEmpty(matchText(textFromSelectors($, '.ui-pdp-subtitle, [class*="sold"]')[0], /([\d.,]+)\s+vendid/i, 1), findSoldCount(lines)),
    shipping: firstNonEmpty(textFromSelectors($, '.ui-pdp-shipping, [class*="shipping"]')[0], findShipping(lines)),
    description: firstNonEmpty(textFromSelectors($, '.ui-pdp-description__content, [class*="description"]')[0], sectionText($, /descri(?:ç|c)[aã]o/i, /perguntas|opiniões|avalia/i)),
    variations: extractVariations($, lines, /cor|tamanho|voltagem|modelo|opções|variações/i), attributes: extractAttributes($),
    images: rankProductImages(pageImages, detectSite('https://mercadolivre.com.br'), name).slice(0, 16),
  };
}

function extractAmazon($, lines, headings, pageImages) {
  const name = pickBestProductTitle([...textFromSelectors($, '#productTitle, h1, [data-feature-name="title"]'), ...headings]);
  const whole = cleanText($('.a-price-whole').first().text());
  const fraction = cleanText($('.a-price-fraction').first().text());
  return {
    name,
    priceText: whole ? `${whole}${fraction || ''}` : firstNonEmpty(textFromSelectors($, '.a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice')[0], findPriceText(lines)),
    originalPriceText: firstNonEmpty(textFromSelectors($, '.a-price.a-text-price .a-offscreen, [data-a-strike="true"] .a-offscreen')[0], findOriginalPrice(lines)),
    discount: firstNonEmpty(textFromSelectors($, '.savingsPercentage, [class*="savings"]')[0], matchText(lines.join(' '), /-?\d{1,2}%/)),
    seller: firstNonEmpty(textFromSelectors($, '#sellerProfileTriggerId, #merchant-info a, [tabular-attribute-name="Vendido por"]')[0], labeledValue(lines, /vendido por\s*:?/i)),
    rating: firstNonEmpty(matchText(textFromSelectors($, '#acrPopover, [data-hook="rating-out-of-text"]')[0], /([0-5](?:[.,]\d)?)/, 1), findRating(lines)),
    reviewCount: firstNonEmpty(matchText(textFromSelectors($, '#acrCustomerReviewText')[0], /([\d.,]+)/, 1), findReviewCount(lines)),
    shipping: firstNonEmpty(textFromSelectors($, '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE, #deliveryBlockMessage')[0], findShipping(lines)),
    description: firstNonEmpty(textFromSelectors($, '#productDescription, #feature-bullets')[0], sectionText($, /sobre este item|descri(?:ç|c)[aã]o/i, /avaliações|produtos relacionados/i)),
    variations: extractVariations($, lines, /cor|tamanho|estilo|capacidade|modelo/i), attributes: extractAttributes($),
    images: rankProductImages(pageImages, detectSite('https://amazon.com.br'), name).slice(0, 16),
  };
}

function extractCommonProductSignals($, lines, headings) {
  return {
    name: pickBestProductTitle(headings), priceText: findPriceText(lines), originalPriceText: findOriginalPrice(lines),
    discount: matchText(lines.join(' '), /(?:-|economize\s*)?(\d{1,2}%\s*(?:off|de desconto)?)/i),
    rating: findRating(lines), reviewCount: findReviewCount(lines), soldCount: findSoldCount(lines), shipping: findShipping(lines),
    variations: extractVariations($, lines, /opções|variações|cor|tamanho|modelo/i), attributes: extractAttributes($), siteSpecific: false,
  };
}

function buildProductArticle(product, url, pageImages = []) {
  const details = [];
  if (product.price) details.push(`Preço: ${formatPrice(product.price, product.currency)}`);
  if (product.originalPrice) details.push(`Preço anterior: ${formatPrice(product.originalPrice, product.currency)}`);
  if (product.discount) details.push(`Desconto: ${product.discount}`);
  if (product.seller) details.push(`Vendido por: ${product.seller}`);
  if (product.rating) details.push(`Avaliação: ${product.rating}${product.reviewCount ? ` (${product.reviewCount})` : ''}`);
  if (product.soldCount) details.push(`Vendidos: ${product.soldCount}`);
  if (product.shipping) details.push(`Entrega: ${product.shipping}`);
  if (product.availability) details.push(`Disponibilidade: ${product.availability}`);
  if (product.brand) details.push(`Marca: ${product.brand}`);
  if (product.sku) details.push(`Código/SKU: ${product.sku}`);
  const content = [];
  if (details.length) content.push({ type: 'list', ordered: false, items: details });
  if (product.description) {
    content.push({ type: 'heading', level: 2, text: 'Descrição' });
    product.description.split(/\n+/).filter(Boolean).forEach((text) => content.push({ type: 'paragraph', text }));
  }
  if (product.variations?.length) {
    content.push({ type: 'heading', level: 2, text: 'Opções' });
    product.variations.forEach((group) => content.push({ type: 'list', ordered: false, items: group.options.map((option) => `${group.name}: ${option}`) }));
  }
  const productImageObjects = product.images.map((src) => ({ src, alt: product.name, role: 'product' }));
  const allImages = mergeImages(productImageObjects, pageImages);
  const productSet = new Set(product.images);
  return finishArticle({
    title: product.name, byline: product.seller || product.brand || product.siteLabel || 'Produto', siteName: product.siteLabel || new URL(url).hostname,
    excerpt: product.description, content: content.length ? content : [{ type: 'paragraph', text: product.name }], images: allImages,
    extraImages: allImages.filter((image) => !productSet.has(image.src)), type: 'product', product, quality: product.quality,
    extraction: { source: product.source, site: detectSite(url) },
  });
}

function collectTextLines($) {
  const values = [], seen = new Set();
  const add = (value) => { const text = cleanText(value); if (!text || text.length > 700 || seen.has(text)) return; seen.add(text); values.push(text); };
  $('h1,h2,h3,h4,strong,b,p,li,dt,dd,button,[role="button"],[class*="title"],[class*="price"]').each((_, el) => add($(el).text()));
  String($('body').text() || '').split(/\n+/).forEach(add);
  return values.slice(0, 1200);
}
function collectCandidateTitles($) { return $('h1,h2,h3,strong,b,[class*="title"],[class*="name"]').map((_, el) => cleanText($(el).text())).get().filter((text) => text.length >= 10 && text.length <= 240 && !isProductJunkText(text)).slice(0, 120); }
function findPriceText(lines) { return lines.filter((line) => /(?:R\$|US\$|\$|€|£)\s*[0-9]/i.test(line) && !/frete|cupom|cashback/i.test(line)).sort((a, b) => priceLineScore(b) - priceLineScore(a))[0] || ''; }
function findOriginalPrice(lines) { return lines.find((line) => /(?:de|preço anterior|preço original|lista)\s*:?.*(?:R\$|US\$|\$|€|£)\s*[0-9]/i.test(line)) || ''; }
function priceLineScore(line) { let score = 0; if (/^\s*(?:R\$|US\$|\$|€|£)\s*[0-9.,]+\s*$/i.test(line)) score += 5; if (line.length < 40) score += 3; return score; }
function findRating(lines) { for (const line of lines) { const a = line.match(/(?:avalia(?:ção|ções)?|nota|estrelas?).{0,25}?([0-5](?:[.,]\d{1,2})?)/i); if (a) return a[1].replace(',', '.'); const b = line.match(/\b([0-5](?:[.,]\d)?)\s*(?:de\s*5|estrelas?)\b/i); if (b) return b[1].replace(',', '.'); } return ''; }
function findReviewCount(lines) { return matchText(lines.join(' '), /([\d.,]+)\s*(?:avaliações|avaliação|opiniões|reviews?)/i, 1); }
function findSoldCount(lines) { return matchText(lines.join(' '), /([\d.,]+\s*[kKmM]?\+?)\s*(?:vendidos?|vendas)/i, 1); }
function findShipping(lines) { return lines.find((line) => /\b(frete|entrega|receba|chegará|chega entre|envio)\b/i.test(line) && line.length <= 180) || ''; }
function findDescriptionFromLines(lines) { const marker = lines.findIndex((line) => /descri(?:ç|c)[aã]o(?: do produto)?/i.test(line)); if (marker < 0) return ''; const out = []; for (let i = marker + 1; i < lines.length && out.length < 12; i += 1) { const line = lines[i]; if (/avalia|denunciar|produtos relacionados|você também|perguntas/i.test(line)) break; if (!isProductJunkText(line) && line.length > 10) out.push(line); } return out.join('\n'); }
function textFromSelectors($, selectors) { try { return $(selectors).map((_, el) => cleanText($(el).text())).get().filter(Boolean); } catch { return []; } }
function labeledValue(lines, pattern) { const line = lines.find((value) => pattern.test(value) && value.length <= 160); return line ? cleanText(line.replace(pattern, '')) : ''; }
function matchText(text, regex, group = 0) { const match = String(text || '').match(regex); return cleanText(match?.[group] || ''); }
function cleanRating(value) { const match = cleanText(value).match(/[0-5](?:[.,]\d{1,2})?/); return match ? match[0].replace(',', '.') : ''; }
function cleanVariationName(value) { const text = cleanText(value).replace(/[:：]$/, ''); return text.length <= 40 ? text : 'Opções'; }

function extractVariations($, lines, headingPattern) {
  const groups = [];
  const options = $('button,[role="button"],[class*="variation"],[class*="variant"],[class*="option"]').map((_, el) => cleanText($(el).text())).get().filter((text) => text.length >= 1 && text.length <= 90 && !isProductJunkText(text) && !/comprar|carrinho|adicionar/i.test(text));
  const unique = [...new Set(options)]; if (unique.length >= 2 && unique.length <= 40) groups.push({ name: 'Opções', options: unique });
  const marker = lines.findIndex((line) => headingPattern.test(line) && line.length <= 80);
  if (marker >= 0) { const following = lines.slice(marker + 1, marker + 7).find((line) => line.length > 8 && line.length <= 500 && !isProductJunkText(line)); if (following) { const split = splitOptions(following); if (split.length >= 2) groups.push({ name: cleanVariationName(lines[marker]), options: split }); } }
  return normalizeVariations(groups);
}
function splitOptions(text) { const simple = String(text).split(/\s*[|•·;]\s*|\s{2,}/).map(cleanText).filter((x) => x.length >= 2); if (simple.length >= 2) return [...new Set(simple)].slice(0, 30); const words = cleanText(text).split(' '); for (let size = 4; size >= 2; size -= 1) { const prefix = words.slice(0, size).join(' '); const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); if ((cleanText(text).match(new RegExp(escaped, 'gi')) || []).length >= 2) return cleanText(text).split(new RegExp(`(?=${escaped})`, 'gi')).map(cleanText).filter(Boolean).slice(0, 30); } return []; }
function extractAttributes($) { const output = []; const add = (name, value) => { const key = cleanText(name), val = cleanText(value); if (!key || !val || key === val || key.length > 80 || val.length > 240) return; if (!output.some((x) => x.name.toLowerCase() === key.toLowerCase() && x.value === val)) output.push({ name: key, value: val }); }; $('table tr').each((_, row) => { const cells = $(row).find('th,td'); if (cells.length >= 2) add($(cells[0]).text(), $(cells[1]).text()); }); $('dl dt').each((_, dt) => add($(dt).text(), $(dt).next('dd').text())); $('[class*="spec"] li, [class*="attribute"] li, [class*="detail"] li').each((_, li) => { const parts = cleanText($(li).text()).split(/:\s*/, 2); if (parts.length === 2) add(parts[0], parts[1]); }); return output.slice(0, 30); }
function sectionText($, startPattern, stopPattern) { const candidates = $('h1,h2,h3,h4,strong,b,p,div').toArray(); const index = candidates.findIndex((el) => { const text = cleanText($(el).text()); return text.length <= 100 && startPattern.test(text); }); if (index < 0) return ''; const start = $(candidates[index]); const result = []; let current = start.next(); while (current.length && result.length < 20) { const text = cleanText(current.text()); if (stopPattern.test(text) && text.length <= 120) break; if (text && text.length > 8 && !isProductJunkText(text)) result.push(text); current = current.next(); } return result.join('\n'); }

function rankProductImages(images, site, productName) { const words = new Set(cleanText(productName).toLowerCase().split(/\s+/).filter((w) => w.length >= 4)); return mergeImages(images).filter((image) => !PRODUCT_IMAGE_BAD.test(`${image.src} ${image.alt || ''}`)).map((image, index) => ({ image, score: imageScore(image, site, words) - index * .01 })).sort((a, b) => b.score - a.score).map((x) => x.image).slice(0, 20); }
function imageScore(image, site, words) { let score = image.role === 'structured' ? 10 : image.role === 'meta' ? 7 : 0; const value = `${image.src} ${image.alt || ''}`.toLowerCase(); if (site.id === 'shopee' && /(shopee|shopeeusercontent|cf\.shopee)/i.test(value)) score += 7; if (site.id === 'mercadolivre' && /(mlstatic|mlcdn)/i.test(value)) score += 7; if (site.id === 'amazon' && /(media-amazon|ssl-images-amazon|images-amazon)/i.test(value)) score += 7; score += cleanText(image.alt).toLowerCase().split(/\s+/).filter((w) => words.has(w)).length * .8; return score; }
function normalizeVariations(groups = []) { const out = []; for (const group of groups || []) { const name = cleanText(group?.name) || 'Opções'; const options = [...new Set((group?.options || []).map(cleanText).filter((x) => x && x.length <= 120))].slice(0, 30); if (options.length < 2) continue; if (!out.some((x) => x.name === name && x.options.join('|') === options.join('|'))) out.push({ name, options }); } return out.slice(0, 8); }
function normalizeAttributes(items = []) { return (items || []).filter((item) => item?.name && item?.value).slice(0, 30); }

function extractFallback(html, url, pageTitle, pageImages = []) { const $ = cheerio.load(html); $('nav, footer, header, aside, .menu, script, style, form').remove(); const headlines = new Set(); $('h1,h2,h3,h4,.post-title,.title').each((_, el) => { const text = cleanText($(el).text()); if (text.length >= 20 && !isProductJunkText(text)) headlines.add(text); }); if (!headlines.size) throw new Error('EXTRACTION_FAILED'); return finishArticle({ title: pageTitle, byline: 'Resumo automático', siteName: new URL(url).hostname, excerpt: null, content: [{ type: 'heading', level: 2, text: 'Conteúdo encontrado' }, { type: 'list', ordered: false, items: [...headlines].slice(0, 20) }], images: pageImages, type: 'page', extraction: { source: 'fallback', site: detectSite(url) } }); }
function finishArticle(article) {
  const wordCount = getWordCount(article.content);
  const base = { ...article, wordCount, readingTimeMinutes: Math.max(1, Math.round(wordCount / 200)) };
  return base.quality ? base : { ...base, quality: scoreContentQuality(base) };
}
function scoreContentQuality(article = {}) {
  const content = Array.isArray(article.content) ? article.content : [];
  const wordCount = getWordCount(content);
  const paragraphs = content.filter((block) => block?.type === 'paragraph' && cleanText(block.text).length >= 40).length;
  const headings = content.filter((block) => block?.type === 'heading').length;
  let score = 0; const signals = [];
  const add = (ok, points, label) => { if (ok) { score += points; signals.push(label); } };
  add(Boolean(cleanText(article.title) && !/^sem título$/i.test(cleanText(article.title))), 20, 'título');
  add(wordCount >= 80, 15, 'texto'); add(wordCount >= 250, 15, 'conteúdo suficiente'); add(wordCount >= 600, 10, 'conteúdo extenso');
  add(paragraphs >= 3, 15, 'parágrafos'); add(headings >= 1, 8, 'estrutura'); add(Boolean(article.excerpt), 5, 'resumo');
  add(Boolean(article.byline || article.siteName), 5, 'origem'); add(Array.isArray(article.images) && article.images.length > 0, 7, 'imagens');
  score = Math.min(100, score);
  const level = score >= 70 ? 'high' : score >= 45 ? 'medium' : 'partial';
  return { score, level, label: level === 'high' ? 'extração completa' : level === 'medium' ? 'extração boa' : 'extração parcial', signals, warnings: level === 'partial' ? ['conteúdo pode estar incompleto'] : [] };
}
function resultQualityScore(result) { return Number(result?.quality?.score || result?.product?.quality?.score || 0); }
function shouldAcceptResult(result) { const score = resultQualityScore(result); return result?.type === 'product' ? score >= 60 : score >= 55; }
function getWordCount(content) { return content.reduce((sum, block) => { if (['paragraph', 'heading', 'quote'].includes(block.type)) return sum + cleanText(block.text).split(/\s+/).filter(Boolean).length; if (block.type === 'list') return sum + (block.items || []).join(' ').split(/\s+/).filter(Boolean).length; return sum; }, 0); }
function walk($, element, content, images, baseUrl, filterJunk = false) { const tag = element.tagName?.toLowerCase(); if (!tag) return; const node = $(element); const add = (block) => { const text = cleanText(block.text); if (!text || (filterJunk && isProductJunkText(text))) return; content.push({ ...block, text }); }; if (/^h[1-6]$/.test(tag)) { add({ type: 'heading', level: Number(tag[1]), text: node.text() }); return; } if (tag === 'p') { add({ type: 'paragraph', text: node.text() }); node.find('img').each((_, image) => registerImage($, image, images, content, baseUrl)); return; } if (tag === 'blockquote') { add({ type: 'quote', text: node.text() }); return; } if (tag === 'ul' || tag === 'ol') { const items = node.children('li').map((_, li) => cleanText($(li).text())).get().filter((text) => text && (!filterJunk || !isProductJunkText(text))); if (items.length) content.push({ type: 'list', ordered: tag === 'ol', items }); return; } if (tag === 'img' || tag === 'figure') { const image = tag === 'img' ? element : node.find('img').get(0); if (image) registerImage($, image, images, content, baseUrl); return; } if (node.children().length) node.children().each((_, child) => walk($, child, content, images, baseUrl, filterJunk)); else add({ type: 'paragraph', text: node.text() }); }
function registerImage($, imageElement, images, content, baseUrl) { const node = $(imageElement); const src = resolveImageUrl(imageSourceFromNode(node), baseUrl); if (!src || images.some((item) => item.src === src)) return; const alt = cleanText(node.attr('alt') || node.attr('title')); images.push({ src, alt }); content.push({ type: 'image', src, alt }); }
function collectPageImages($, baseUrl) { const images = []; const add = (source, alt = '', role = 'page') => { const src = resolveImageUrl(source, baseUrl); if (!src || images.some((item) => item.src === src)) return; images.push({ src, alt: cleanText(alt), role }); }; const title = cleanText($('title').first().text()); add(metaContent($, 'property', 'og:image'), title, 'meta'); add(metaContent($, 'property', 'og:image:url'), title, 'meta'); add(metaContent($, 'name', 'twitter:image'), title, 'meta'); add($('link[rel="image_src"]').first().attr('href'), title, 'meta'); $('img').each((_, element) => { const node = $(element); const width = Number(node.attr('width') || 0), height = Number(node.attr('height') || 0); if ((width > 0 && width <= 4) || (height > 0 && height <= 4)) return; const alt = node.attr('alt') || node.attr('title') || ''; add(imageSourceFromNode(node), alt); add(bestSrcsetSource(node.attr('srcset') || node.attr('data-srcset')), alt); }); $('picture source[srcset], source[data-srcset]').each((_, el) => add(bestSrcsetSource($(el).attr('srcset') || $(el).attr('data-srcset')), '')); return images.slice(0, 100); }
function imageSourceFromNode(node) { return node.attr('src') || node.attr('data-src') || node.attr('data-lazy-src') || node.attr('data-original') || node.attr('data-image') || bestSrcsetSource(node.attr('srcset') || node.attr('data-srcset')) || ''; }
function bestSrcsetSource(value = '') { return String(value).split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => { const parts = entry.split(/\s+/); return { source: parts[0], score: Number.parseFloat(parts[1] || '') || 0 }; }).sort((a, b) => b.score - a.score)[0]?.source || ''; }
function resolveImageUrl(source, baseUrl) { if (!source || /^(data|blob|javascript):/i.test(String(source))) return ''; try { const resolved = new URL(String(source).trim(), baseUrl); if (!['http:', 'https:'].includes(resolved.protocol) || isPrivateImageHost(resolved.hostname) || /\b(pixel|spacer|tracking)(?:[._-]|$)/i.test(resolved.pathname)) return ''; return resolved.toString(); } catch { return ''; } }
function isPrivateImageHost(hostname = '') { const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, ''); if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || /^127\./.test(host) || /^10\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host)) return true; const match = host.match(/^172\.(\d{1,3})\./); return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31); }
function mergeImages(...groups) { const merged = []; groups.flat().forEach((image) => { const item = typeof image === 'string' ? { src: image, alt: '' } : image; const src = resolveImageUrl(item?.src, item?.src); if (!src || merged.some((x) => x.src === src)) return; merged.push({ ...item, src, alt: cleanText(item?.alt) }); }); return merged.slice(0, 100); }
function findProductJsonLd($) { const candidates = []; $('script[type="application/ld+json"]').each((_, el) => { try { collectJsonLd(JSON.parse($(el).text().trim()), candidates); } catch {} }); return candidates.find((entry) => typeIncludes(entry?.['@type'], 'Product')) || null; }
function collectJsonLd(value, output) { if (!value) return; if (Array.isArray(value)) { value.forEach((item) => collectJsonLd(item, output)); return; } if (typeof value !== 'object') return; output.push(value); if (Array.isArray(value['@graph'])) value['@graph'].forEach((item) => collectJsonLd(item, output)); }
function typeIncludes(value, expected) { if (Array.isArray(value)) return value.some((item) => String(item).toLowerCase() === expected.toLowerCase()); return String(value || '').toLowerCase() === expected.toLowerCase(); }
function firstOffer(offers) { if (Array.isArray(offers)) return offers.find(Boolean) || null; return offers && typeof offers === 'object' ? offers : null; }
function metaContent($, attribute, value) { return $(`meta[${attribute}="${value}"]`).first().attr('content') || ''; }
function firstNonEmpty(...values) { return values.find((value) => cleanText(value)) || ''; }
function normalizeImageCandidates(value) { if (Array.isArray(value)) return value.flatMap((item) => normalizeImageCandidates(item)); if (typeof value === 'string') return [value]; if (value && typeof value === 'object') return normalizeImageCandidates(value.url || value.contentUrl); return []; }
function cleanAvailability(value) { const cleaned = cleanText(value); if (!cleaned) return null; const token = cleaned.split('/').pop(); return ({ InStock: 'Em estoque', OutOfStock: 'Sem estoque', PreOrder: 'Pré-venda', LimitedAvailability: 'Estoque limitado', OnlineOnly: 'Somente online', SoldOut: 'Esgotado' })[token] || token || cleaned; }
function formatPrice(price, currency) { if (!price) return ''; const symbols = { BRL: 'R$', USD: 'US$', EUR: '€', GBP: '£' }; const prefix = symbols[String(currency || '').toUpperCase()] || cleanText(currency); return `${prefix}${prefix ? ' ' : ''}${price}`.trim(); }
function cleanText(value = '') { if (value == null || typeof value === 'object') return ''; return String(value).trim().replace(/\s+/g, ' '); }

async function fetchData(url) { const cloudFirst = CLOUD_FIRST_DOMAINS.some((domain) => new URL(url).hostname.toLowerCase().includes(domain)); const attempts = cloudFirst ? [fetchCloud, fetchNative] : [fetchNative, fetchCloud]; let lastError = null; for (const attempt of attempts) { try { return await attempt(url); } catch (error) { lastError = error; if (error?.message === 'PAGE_TOO_LARGE' || error?.message === 'HTTP_404') throw error; } } throw lastError || new Error('EXTRACTION_FAILED'); }
async function fetchNative(url) { const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12000); try { const response = await fetchWithSafeRedirects(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7' } }); if (response.status === 404) throw new Error('HTTP_404'); if (!response.ok) throw new Error(`HTTP_${response.status}`); const contentType = response.headers.get('content-type') || ''; if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) throw new Error('CONTENT_TYPE_UNSUPPORTED'); const len = Number(response.headers.get('content-length') || 0); if (len > MAX_PAGE_BYTES) throw new Error('PAGE_TOO_LARGE'); const html = await response.text(); if (Buffer.byteLength(html, 'utf8') > MAX_PAGE_BYTES) throw new Error('PAGE_TOO_LARGE'); if (!html.trim() || looksLikeChallenge(html)) throw new Error('CHALLENGE_PAGE'); return { source: 'native', html }; } finally { clearTimeout(timeout); } }
async function fetchCloud(url) { const response = await fetch(`https://r.jina.ai/${url}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) }); if (response.status === 404) throw new Error('HTTP_404'); if (!response.ok) throw new Error(`HTTP_${response.status}`); const json = await response.json(); const data = json?.data || json; if (!data?.content) throw new Error('EXTRACTION_FAILED'); return { source: 'cloud', data }; }
function looksLikeChallenge(html) { const value = html.toLowerCase(); return value.includes('just a moment...') || value.includes('enable javascript') || value.includes('cf-chl-') || value.includes('captcha') || value.includes('access denied'); }
async function fetchWithSafeRedirects(initialUrl, options) { let currentUrl = initialUrl; for (let redirects = 0; redirects <= 5; redirects += 1) { await assertPublicHttpUrl(currentUrl); const response = await fetch(currentUrl, { ...options, redirect: 'manual' }); if (![301, 302, 303, 307, 308].includes(response.status)) return response; const location = response.headers.get('location'); if (!location) return response; await response.body?.cancel(); currentUrl = new URL(location, currentUrl).toString(); } throw new Error('TOO_MANY_REDIRECTS'); }
