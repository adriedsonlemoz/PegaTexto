import { CapacitorHttp } from '@capacitor/core'
import { Readability } from '@mozilla/readability'
import { marked } from 'marked'
import {
  cleanText,
  getWordCount,
  isCloudFirstDomain,
  looksLikeChallenge,
  normalizeHttpUrl,
  readingTimeMinutes,
  scoreContentQuality,
} from './extractionCore'
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
} from './pageIntelligence'

const MAX_PAGE_CHARS = 8 * 1024 * 1024
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36'

const JUNK_SELECTORS = [
  '.advertisement', '.ad', '.ads', '[class*="banner"]', '[id*="banner"]',
  '.social-share', '.share-buttons', '[class*="share"]',
  '.comments', '#comments', '.comment-section', '.disqus',
  '.newsletter', '.popup', '.modal', '[class*="cookie"]',
  'nav', 'footer', '.related-articles', '.recommended', '.sidebar',
  '[class*="paywall"]', '[class*="subscribe"]',
]

const PRODUCT_IMAGE_BAD = /(?:logo|avatar|icon|sprite|payment|voucher|qr|qrcode|badge|flag|footer|header|banner|placeholder|tracking|pixel)/i

export async function extractArticleNative(rawUrl) {
  const url = normalizeHttpUrl(rawUrl)
  const attempts = isCloudFirstDomain(url) ? [extractViaJina, extractDirect] : [extractDirect, extractViaJina]
  let lastError = null
  let bestResult = null

  for (const attempt of attempts) {
    try {
      const result = await attempt(url)
      if (isLikelyProductUrl(url) && result.type !== 'product') {
        lastError = new Error('PRODUCT_NOT_RECOGNIZED')
        continue
      }
      if (!bestResult || resultQualityScore(result) > resultQualityScore(bestResult)) bestResult = result
      if (shouldAcceptResult(result)) return result
    } catch (error) {
      lastError = error
      if (error?.message === 'HTTP_404' || error?.message === 'PAGE_TOO_LARGE') throw error
    }
  }
  if (bestResult) return bestResult
  throw lastError || new Error('EXTRACTION_FAILED')
}

async function extractDirect(url) {
  const response = await CapacitorHttp.get({
    url,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    },
    connectTimeout: 12000,
    readTimeout: 18000,
    responseType: 'text',
  })

  if (response.status === 404) throw new Error('HTTP_404')
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP_${response.status}`)
  const html = typeof response.data === 'string' ? response.data : String(response.data ?? '')
  if (html.length > MAX_PAGE_CHARS) throw new Error('PAGE_TOO_LARGE')
  if (!html.trim() || looksLikeChallenge(html)) throw new Error('CHALLENGE_PAGE')
  return extractFromHtml(html, url, { source: 'direct' })
}

async function extractViaJina(url) {
  const response = await CapacitorHttp.get({
    url: `https://r.jina.ai/${url}`,
    headers: { Accept: 'application/json' },
    connectTimeout: 12000,
    readTimeout: 22000,
  })
  if (response.status === 404) throw new Error('HTTP_404')
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP_${response.status}`)

  let payload = response.data
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload) } catch { payload = null }
  }
  const data = payload?.data || payload
  const markdown = data?.content || ''
  if (!markdown.trim()) throw new Error('EXTRACTION_FAILED')

  const html = marked.parse(markdown)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const pageImages = collectDocumentImages(doc, url)
  const product = extractProductFromDocument(doc, url, {
    cloud: true,
    cloudTitle: data?.title,
    cloudDescription: data?.description,
    pageImages,
  })
  if (product) return buildProductArticle(product, url, pageImages)

  const { content, images } = blocksFromDocument(doc, url, { filterJunk: true })
  if (!content.length) throw new Error('EXTRACTION_FAILED')
  return finishArticle({
    title: cleanText(data?.title) || titleFromDocument(doc) || 'Sem título',
    byline: cleanText(data?.siteName) || 'Extração alternativa',
    siteName: cleanText(data?.siteName) || new URL(url).hostname,
    excerpt: cleanText(data?.description) || null,
    content,
    images: mergeImages(images, pageImages),
    type: classifyPage({ url, articleTextLength: getWordCount(content) * 6, headings: content.filter((b) => b.type === 'heading').length }).type,
    extraction: { source: 'jina', site: detectSite(url) },
  })
}

function extractFromHtml(html, url, { source = 'direct' } = {}) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const pageTitle = cleanText(doc.title) || 'Sem título'
  const pageImages = collectDocumentImages(doc, url)
  const product = extractProductFromDocument(doc, url, { rawHtml: html, pageImages })
  if (product) return buildProductArticle(product, url, pageImages)

  JUNK_SELECTORS.forEach((selector) => {
    try { doc.querySelectorAll(selector).forEach((element) => element.remove()) } catch { /* ignore */ }
  })

  const article = new Readability(doc.cloneNode(true), { keepClasses: false }).parse()
  const usableArticle = article?.textContent?.trim().length > 180 && article?.content
  if (usableArticle) {
    const articleDoc = new DOMParser().parseFromString(article.content, 'text/html')
    articleDoc.querySelectorAll('script, style, iframe, noscript, form, button').forEach((element) => element.remove())
    const { content, images } = blocksFromDocument(articleDoc, url)
    if (content.length) {
      return finishArticle({
        title: article.title || pageTitle,
        byline: article.byline || null,
        siteName: article.siteName || null,
        excerpt: article.excerpt || null,
        content,
        images: mergeImages(images, pageImages),
        type: 'article',
        extraction: { source, site: detectSite(url) },
      })
    }
  }
  return extractFallback(doc, url, pageTitle, pageImages)
}

function extractProductFromDocument(doc, baseUrl, context = {}) {
  const site = detectSite(baseUrl)
  const structured = findProductJsonLd(doc)
  const offer = firstOffer(structured?.offers)
  const lines = collectTextLines(doc)
  const headings = collectCandidateTitles(doc)
  const pageImages = context.pageImages || collectDocumentImages(doc, baseUrl)

  const genericName = firstNonEmpty(
    structured?.name,
    meta(doc, 'property', 'og:title'),
    meta(doc, 'name', 'twitter:title'),
    attrOrText(doc.querySelector('[itemprop="name"]')),
    doc.querySelector('h1')?.textContent,
    context.cloudTitle,
  )

  const siteData = extractSiteSpecificProduct(doc, baseUrl, site, lines, headings, pageImages, context)
  const priceText = firstNonEmpty(
    siteData.priceText,
    offer?.price,
    offer?.lowPrice,
    meta(doc, 'property', 'product:price:amount'),
    doc.querySelector('[itemprop="price"]')?.getAttribute('content'),
    doc.querySelector('[itemprop="price"]')?.textContent,
    findPriceText(lines),
  )
  const currency = firstNonEmpty(
    offer?.priceCurrency,
    meta(doc, 'property', 'product:price:currency'),
    doc.querySelector('[itemprop="priceCurrency"]')?.getAttribute('content'),
    inferCurrency(priceText, site.id === 'shopee' || site.id === 'mercadolivre' ? 'BRL' : null),
  )

  const titleCandidates = [siteData.name, genericName, ...headings]
  const name = pickBestProductTitle(titleCandidates, genericName)
  const description = cleanProductDescription(firstNonEmpty(
    siteData.description,
    structured?.description,
    meta(doc, 'property', 'og:description'),
    meta(doc, 'name', 'description'),
    attrOrText(doc.querySelector('[itemprop="description"]')),
    context.cloudDescription,
  ))
  const brand = firstNonEmpty(siteData.brand, typeof structured?.brand === 'string' ? structured.brand : structured?.brand?.name, attrOrText(doc.querySelector('[itemprop="brand"]')))
  const seller = firstNonEmpty(siteData.seller, typeof offer?.seller === 'string' ? offer.seller : offer?.seller?.name, attrOrText(doc.querySelector('[itemprop="seller"]')))
  const availability = cleanAvailability(firstNonEmpty(siteData.availability, offer?.availability, meta(doc, 'property', 'product:availability'), attrOrText(doc.querySelector('[itemprop="availability"]'))))
  const rating = cleanRating(firstNonEmpty(siteData.rating, structured?.aggregateRating?.ratingValue, attrOrText(doc.querySelector('[itemprop="ratingValue"]'))))
  const reviewCount = firstNonEmpty(siteData.reviewCount, structured?.aggregateRating?.reviewCount, structured?.aggregateRating?.ratingCount, attrOrText(doc.querySelector('[itemprop="reviewCount"]')))
  const sku = firstNonEmpty(siteData.sku, structured?.sku, structured?.mpn, attrOrText(doc.querySelector('[itemprop="sku"]')))

  const structuredImages = normalizeImageCandidates(structured?.image).map((source) => ({ src: resolveImageUrl(source, baseUrl), alt: name, role: 'structured' })).filter((i) => i.src)
  const metaImages = [meta(doc, 'property', 'og:image'), meta(doc, 'name', 'twitter:image'), doc.querySelector('[itemprop="image"]')?.getAttribute('src')]
    .map((source) => ({ src: resolveImageUrl(source, baseUrl), alt: name, role: 'meta' })).filter((i) => i.src)
  const productImages = rankProductImages(mergeImages(structuredImages, siteData.images || [], metaImages, pageImages), site, name)

  const productUrl = isLikelyProductUrl(baseUrl)
  const classification = classifyPage({ url: baseUrl, hasStructuredProduct: Boolean(structured), title: name, price: priceText })
  if (classification.type !== 'product' && !productUrl) return null

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
  }
  product.quality = scoreProductQuality(product, { siteSpecific: siteData.siteSpecific })
  return product
}

function extractSiteSpecificProduct(doc, url, site, lines, headings, pageImages, context) {
  const common = extractCommonProductSignals(doc, lines, headings)
  if (site.id === 'shopee') return { ...common, ...extractShopee(doc, lines, headings, pageImages, context), siteSpecific: true, source: 'shopee-filter' }
  if (site.id === 'mercadolivre') return { ...common, ...extractMercadoLivre(doc, lines, headings, pageImages), siteSpecific: true, source: 'mercado-livre-filter' }
  if (site.id === 'amazon') return { ...common, ...extractAmazon(doc, lines, headings, pageImages), siteSpecific: true, source: 'amazon-filter' }
  return common
}

function extractShopee(doc, lines, headings, pageImages, context) {
  const bodyText = context.cloud ? lines.join('\n') : cleanText(doc.body?.textContent)
  const name = pickBestProductTitle([
    ...textFromSelectors(doc, '[data-sqe="name"], h1, main h2, strong, b'),
    ...headings,
    ...lines.filter((line) => line.length >= 20 && line.length <= 180),
  ], context.cloudTitle)
  const description = firstNonEmpty(
    sectionText(doc, /descri(?:ç|c)[aã]o(?: do produto)?/i, /avalia|coment|denunciar|produtos relacionados|você também/i),
    findDescriptionFromLines(lines),
  )
  return {
    name,
    priceText: firstNonEmpty(textFromSelectors(doc, '[data-sqe="price"], [class*="price"], [class*="Price"]')[0], findPriceText(lines)),
    originalPriceText: findOriginalPrice(lines),
    discount: matchText(bodyText, /(?:-|economize\s*)?(\d{1,2}%\s*(?:off|de desconto)?)/i),
    seller: firstNonEmpty(textFromSelectors(doc, '[data-sqe="shop-name"], [class*="shop-name"], [class*="seller"]')[0], labeledValue(lines, /(?:vendido por|loja|vendedor)\s*:?/i)),
    rating: findRating(lines),
    reviewCount: findReviewCount(lines),
    soldCount: findSoldCount(lines),
    shipping: findShipping(lines),
    description,
    variations: extractVariations(doc, lines, /opções|variações|selecione/i),
    attributes: extractAttributes(doc),
    images: rankProductImages(pageImages, detectSite('https://shopee.com.br'), name).slice(0, 16),
  }
}

function extractMercadoLivre(doc, lines, headings, pageImages) {
  const name = pickBestProductTitle([...textFromSelectors(doc, 'h1.ui-pdp-title, h1, [class*="ui-pdp-title"]'), ...headings])
  const fraction = cleanText(doc.querySelector('.andes-money-amount__fraction')?.textContent)
  const cents = cleanText(doc.querySelector('.andes-money-amount__cents')?.textContent)
  return {
    name,
    priceText: fraction ? `${fraction}${cents ? `,${cents}` : ''}` : findPriceText(lines),
    originalPriceText: firstNonEmpty(textFromSelectors(doc, '.andes-money-amount--previous, [class*="original-price"]')[0], findOriginalPrice(lines)),
    discount: firstNonEmpty(textFromSelectors(doc, '.ui-pdp-price__second-line__label, [class*="discount"]')[0], matchText(lines.join(' '), /(\d{1,2}%\s*OFF)/i)),
    seller: firstNonEmpty(textFromSelectors(doc, '.ui-pdp-seller__header__title, [class*="seller"]')[0], labeledValue(lines, /vendido por\s*:?/i)),
    rating: firstNonEmpty(textFromSelectors(doc, '.ui-pdp-review__rating, [class*="rating"]')[0], findRating(lines)),
    reviewCount: findReviewCount(lines),
    soldCount: firstNonEmpty(textFromSelectors(doc, '.ui-pdp-subtitle, [class*="sold"]')[0]?.match(/([\d.,]+)\s+vendid/i)?.[1], findSoldCount(lines)),
    shipping: firstNonEmpty(textFromSelectors(doc, '.ui-pdp-shipping, [class*="shipping"]')[0], findShipping(lines)),
    description: firstNonEmpty(textFromSelectors(doc, '.ui-pdp-description__content, [class*="description"]')[0], sectionText(doc, /descri(?:ç|c)[aã]o/i, /perguntas|opiniões|avalia/i)),
    variations: extractVariations(doc, lines, /cor|tamanho|voltagem|modelo|opções|variações/i),
    attributes: extractAttributes(doc),
    images: rankProductImages(pageImages, detectSite('https://mercadolivre.com.br'), name).slice(0, 16),
  }
}

function extractAmazon(doc, lines, headings, pageImages) {
  const name = pickBestProductTitle([...textFromSelectors(doc, '#productTitle, h1, [data-feature-name="title"]'), ...headings])
  const priceWhole = cleanText(doc.querySelector('.a-price-whole')?.textContent)
  const priceFraction = cleanText(doc.querySelector('.a-price-fraction')?.textContent)
  return {
    name,
    priceText: priceWhole ? `${priceWhole}${priceFraction ? priceFraction : ''}` : firstNonEmpty(textFromSelectors(doc, '.a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice')[0], findPriceText(lines)),
    originalPriceText: firstNonEmpty(textFromSelectors(doc, '.a-price.a-text-price .a-offscreen, [data-a-strike="true"] .a-offscreen')[0], findOriginalPrice(lines)),
    discount: firstNonEmpty(textFromSelectors(doc, '.savingsPercentage, [class*="savings"]')[0], matchText(lines.join(' '), /-?\d{1,2}%/)),
    seller: firstNonEmpty(textFromSelectors(doc, '#sellerProfileTriggerId, #merchant-info a, [tabular-attribute-name="Vendido por"]')[0], labeledValue(lines, /vendido por\s*:?/i)),
    rating: firstNonEmpty(textFromSelectors(doc, '#acrPopover, [data-hook="rating-out-of-text"]')[0]?.match(/[0-5](?:[.,]\d)?/)?.[0], findRating(lines)),
    reviewCount: firstNonEmpty(textFromSelectors(doc, '#acrCustomerReviewText')[0]?.match(/[\d.,]+/)?.[0], findReviewCount(lines)),
    shipping: firstNonEmpty(textFromSelectors(doc, '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE, #deliveryBlockMessage, [data-csa-c-type="widget"]')[0], findShipping(lines)),
    description: firstNonEmpty(textFromSelectors(doc, '#productDescription, #feature-bullets')[0], sectionText(doc, /sobre este item|descri(?:ç|c)[aã]o/i, /avaliações|produtos relacionados/i)),
    variations: extractVariations(doc, lines, /cor|tamanho|estilo|capacidade|modelo/i),
    attributes: extractAttributes(doc),
    images: rankProductImages(pageImages, detectSite('https://amazon.com.br'), name).slice(0, 16),
  }
}

function extractCommonProductSignals(doc, lines, headings) {
  return {
    name: pickBestProductTitle(headings),
    priceText: findPriceText(lines),
    originalPriceText: findOriginalPrice(lines),
    discount: matchText(lines.join(' '), /(?:-|economize\s*)?(\d{1,2}%\s*(?:off|de desconto)?)/i),
    rating: findRating(lines),
    reviewCount: findReviewCount(lines),
    soldCount: findSoldCount(lines),
    shipping: findShipping(lines),
    variations: extractVariations(doc, lines, /opções|variações|cor|tamanho|modelo/i),
    attributes: extractAttributes(doc),
    siteSpecific: false,
  }
}

function buildProductArticle(product, url, pageImages = []) {
  const details = []
  if (product.price) details.push(`Preço: ${formatPrice(product.price, product.currency)}`)
  if (product.originalPrice) details.push(`Preço anterior: ${formatPrice(product.originalPrice, product.currency)}`)
  if (product.discount) details.push(`Desconto: ${product.discount}`)
  if (product.seller) details.push(`Vendido por: ${product.seller}`)
  if (product.rating) details.push(`Avaliação: ${product.rating}${product.reviewCount ? ` (${product.reviewCount})` : ''}`)
  if (product.soldCount) details.push(`Vendidos: ${product.soldCount}`)
  if (product.shipping) details.push(`Entrega: ${product.shipping}`)
  if (product.availability) details.push(`Disponibilidade: ${product.availability}`)
  if (product.brand) details.push(`Marca: ${product.brand}`)
  if (product.sku) details.push(`Código/SKU: ${product.sku}`)

  const content = []
  if (details.length) content.push({ type: 'list', ordered: false, items: details })
  if (product.description) {
    content.push({ type: 'heading', level: 2, text: 'Descrição' })
    product.description.split(/\n+/).filter(Boolean).forEach((text) => content.push({ type: 'paragraph', text }))
  }
  if (product.variations?.length) {
    content.push({ type: 'heading', level: 2, text: 'Opções' })
    product.variations.forEach((group) => content.push({ type: 'list', ordered: false, items: group.options.map((option) => `${group.name}: ${option}`) }))
  }

  const productImageObjects = product.images.map((src) => ({ src, alt: product.name, role: 'product' }))
  const allImages = mergeImages(productImageObjects, pageImages)
  const productSet = new Set(product.images)
  const extraImages = allImages.filter((image) => !productSet.has(image.src))

  return finishArticle({
    title: product.name,
    byline: product.seller || product.brand || product.siteLabel || 'Produto',
    siteName: product.siteLabel || new URL(url).hostname,
    excerpt: product.description,
    content: content.length ? content : [{ type: 'paragraph', text: product.name }],
    images: allImages,
    extraImages,
    type: 'product',
    product,
    quality: product.quality,
    extraction: { source: product.source, site: detectSite(url) },
  })
}

function extractFallback(doc, url, pageTitle, pageImages = []) {
  doc.querySelectorAll('nav, footer, header, aside, .menu, script, style, form').forEach((element) => element.remove())
  const content = []
  const headlines = [...doc.querySelectorAll('h1, h2, h3, h4, .post-title, .title')]
    .map((element) => cleanText(element.textContent)).filter((text) => text.length >= 20 && !isProductJunkText(text))
  if (headlines.length) content.push({ type: 'heading', level: 2, text: 'Conteúdo encontrado' }, { type: 'list', ordered: false, items: [...new Set(headlines)].slice(0, 20) })
  if (!content.length) throw new Error('EXTRACTION_FAILED')
  return finishArticle({ title: pageTitle, byline: 'Resumo automático', siteName: new URL(url).hostname, excerpt: null, content, images: pageImages, type: 'page', extraction: { source: 'fallback', site: detectSite(url) } })
}

function blocksFromDocument(doc, baseUrl, { filterJunk = false } = {}) {
  const content = []
  const images = []
  Array.from(doc.body?.children || []).forEach((element) => walkElement(element, content, images, baseUrl, filterJunk))
  return { content, images }
}

function walkElement(element, content, images, baseUrl, filterJunk = false) {
  const tag = element.tagName?.toLowerCase()
  if (!tag) return
  const addText = (block) => {
    const text = cleanText(block.text)
    if (!text || (filterJunk && isProductJunkText(text))) return
    content.push({ ...block, text })
  }
  if (/^h[1-6]$/.test(tag)) { addText({ type: 'heading', level: Number(tag[1]), text: element.textContent }); return }
  if (tag === 'p') { addText({ type: 'paragraph', text: element.textContent }); element.querySelectorAll('img').forEach((image) => registerImage(image, images, content, baseUrl)); return }
  if (tag === 'blockquote') { addText({ type: 'quote', text: element.textContent }); return }
  if (tag === 'ul' || tag === 'ol') {
    const items = Array.from(element.children).filter((child) => child.tagName?.toLowerCase() === 'li').map((child) => cleanText(child.textContent)).filter((text) => text && (!filterJunk || !isProductJunkText(text)))
    if (items.length) content.push({ type: 'list', ordered: tag === 'ol', items })
    return
  }
  if (tag === 'img') { registerImage(element, images, content, baseUrl); return }
  if (tag === 'figure') {
    const image = element.querySelector('img'); if (image) registerImage(image, images, content, baseUrl)
    addText({ type: 'paragraph', text: element.querySelector('figcaption')?.textContent }); return
  }
  if (element.children.length) Array.from(element.children).forEach((child) => walkElement(child, content, images, baseUrl, filterJunk))
  else addText({ type: 'paragraph', text: element.textContent })
}

function collectTextLines(doc) {
  const values = []
  const seen = new Set()
  const add = (value) => {
    const text = cleanText(value)
    if (!text || text.length > 700 || seen.has(text)) return
    seen.add(text); values.push(text)
  }
  doc.querySelectorAll('h1,h2,h3,h4,strong,b,p,li,dt,dd,button,[role="button"],[class*="title"],[class*="price"]').forEach((element) => add(element.textContent))
  String(doc.body?.innerText || doc.body?.textContent || '').split(/\n+/).forEach(add)
  return values.slice(0, 1200)
}

function collectCandidateTitles(doc) {
  return [...doc.querySelectorAll('h1,h2,h3,strong,b,[class*="title"],[class*="name"]')]
    .map((element) => cleanText(element.textContent)).filter((text) => text.length >= 10 && text.length <= 240 && !isProductJunkText(text)).slice(0, 120)
}

function findPriceText(lines) {
  const candidates = lines.filter((line) => /(?:R\$|US\$|\$|€|£)\s*[0-9]/i.test(line) && !/frete|cupom|cashback/i.test(line))
  return candidates.sort((a, b) => priceLineScore(b) - priceLineScore(a))[0] || ''
}

function findOriginalPrice(lines) {
  return lines.find((line) => /(?:de|preço anterior|preço original|lista)\s*:?.*(?:R\$|US\$|\$|€|£)\s*[0-9]/i.test(line)) || ''
}

function priceLineScore(line) {
  let score = 0
  if (/^\s*(?:R\$|US\$|\$|€|£)\s*[0-9.,]+\s*$/i.test(line)) score += 5
  if (line.length < 40) score += 3
  if (/por\s+(?:R\$|US\$|\$|€|£)/i.test(line)) score += 1
  return score
}

function findRating(lines) {
  for (const line of lines) {
    const labeled = line.match(/(?:avalia(?:ção|ções)?|nota|estrelas?).{0,25}?([0-5](?:[.,]\d{1,2})?)/i)
    if (labeled) return labeled[1].replace(',', '.')
    const suffix = line.match(/\b([0-5](?:[.,]\d)?)\s*(?:de\s*5|estrelas?)\b/i)
    if (suffix) return suffix[1].replace(',', '.')
  }
  return ''
}
function findReviewCount(lines) { return matchText(lines.join(' '), /([\d.,]+)\s*(?:avaliações|avaliação|opiniões|reviews?)/i, 1) }
function findSoldCount(lines) { return matchText(lines.join(' '), /([\d.,]+\s*[kKmM]?\+?)\s*(?:vendidos?|vendas)/i, 1) }
function findShipping(lines) { return lines.find((line) => /\b(frete|entrega|receba|chegará|chega entre|envio)\b/i.test(line) && line.length <= 180) || '' }
function findDescriptionFromLines(lines) {
  const marker = lines.findIndex((line) => /descri(?:ç|c)[aã]o(?: do produto)?/i.test(line))
  if (marker < 0) return ''
  const selected = []
  for (let i = marker + 1; i < lines.length && selected.length < 12; i += 1) {
    const line = lines[i]
    if (/avalia|denunciar|produtos relacionados|você também|perguntas/i.test(line)) break
    if (!isProductJunkText(line) && line.length > 10) selected.push(line)
  }
  return selected.join('\n')
}

function extractVariations(doc, lines, headingPattern) {
  const groups = []
  const buttonOptions = [...doc.querySelectorAll('button,[role="button"],[class*="variation"],[class*="variant"],[class*="option"]')]
    .map((element) => cleanText(element.textContent)).filter((text) => text.length >= 1 && text.length <= 90 && !isProductJunkText(text) && !/comprar|carrinho|adicionar/i.test(text))
  const uniqueButtons = [...new Set(buttonOptions)]
  if (uniqueButtons.length >= 2 && uniqueButtons.length <= 40) groups.push({ name: 'Opções', options: uniqueButtons })

  const marker = lines.findIndex((line) => headingPattern.test(line) && line.length <= 80)
  if (marker >= 0) {
    const following = lines.slice(marker + 1, marker + 7).find((line) => line.length > 8 && line.length <= 500 && !isProductJunkText(line))
    if (following) {
      const options = splitOptions(following)
      if (options.length >= 2) groups.push({ name: cleanVariationName(lines[marker]), options })
    }
  }
  return normalizeVariations(groups)
}

function splitOptions(text) {
  const simple = String(text).split(/\s*[|•·;]\s*|\s{2,}/).map(cleanText).filter((x) => x.length >= 2)
  if (simple.length >= 2) return [...new Set(simple)].slice(0, 30)
  const words = cleanText(text).split(' ')
  for (let size = 4; size >= 2; size -= 1) {
    const prefix = words.slice(0, size).join(' ')
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const occurrences = (cleanText(text).match(new RegExp(escaped, 'gi')) || []).length
    if (occurrences >= 2) return cleanText(text).split(new RegExp(`(?=${escaped})`, 'gi')).map(cleanText).filter(Boolean).slice(0, 30)
  }
  return []
}

function extractAttributes(doc) {
  const attributes = []
  const add = (name, value) => {
    const key = cleanText(name); const val = cleanText(value)
    if (!key || !val || key === val || key.length > 80 || val.length > 240) return
    if (!attributes.some((item) => item.name.toLowerCase() === key.toLowerCase() && item.value === val)) attributes.push({ name: key, value: val })
  }
  doc.querySelectorAll('table tr').forEach((row) => { const cells = row.querySelectorAll('th,td'); if (cells.length >= 2) add(cells[0].textContent, cells[1].textContent) })
  doc.querySelectorAll('dl').forEach((dl) => { const terms = dl.querySelectorAll('dt'); terms.forEach((dt) => add(dt.textContent, dt.nextElementSibling?.textContent)) })
  doc.querySelectorAll('[class*="spec"] li, [class*="attribute"] li, [class*="detail"] li').forEach((li) => {
    const text = cleanText(li.textContent); const split = text.split(/:\s*/, 2); if (split.length === 2) add(split[0], split[1])
  })
  return attributes.slice(0, 30)
}

function sectionText(doc, startPattern, stopPattern) {
  const candidates = [...doc.querySelectorAll('h1,h2,h3,h4,strong,b,p,div')]
  const start = candidates.find((element) => startPattern.test(cleanText(element.textContent)) && cleanText(element.textContent).length <= 100)
  if (!start) return ''
  const result = []
  let current = start.nextElementSibling
  while (current && result.length < 20) {
    const text = cleanText(current.textContent)
    if (stopPattern.test(text) && text.length <= 120) break
    if (text && text.length > 8 && !isProductJunkText(text)) result.push(text)
    current = current.nextElementSibling
  }
  return result.join('\n')
}

function textFromSelectors(doc, selectors) {
  try { return [...doc.querySelectorAll(selectors)].map((element) => cleanText(element.textContent)).filter(Boolean) } catch { return [] }
}
function labeledValue(lines, pattern) {
  const line = lines.find((value) => pattern.test(value) && value.length <= 160)
  return line ? cleanText(line.replace(pattern, '')) : ''
}
function matchText(text, regex, group = 0) { const match = String(text || '').match(regex); return cleanText(match?.[group] || '') }
function cleanRating(value) { const match = cleanText(value).match(/[0-5](?:[.,]\d{1,2})?/); return match ? match[0].replace(',', '.') : '' }
function cleanVariationName(value) { const text = cleanText(value).replace(/[:：]$/, ''); return text.length <= 40 ? text : 'Opções' }

function rankProductImages(images, site, productName) {
  const titleWords = new Set(cleanText(productName).toLowerCase().split(/\s+/).filter((w) => w.length >= 4))
  return mergeImages(images)
    .filter((image) => !PRODUCT_IMAGE_BAD.test(`${image.src} ${image.alt || ''}`))
    .map((image, index) => ({ image, score: imageScore(image, site, titleWords) - index * 0.01 }))
    .sort((a, b) => b.score - a.score)
    .map(({ image }) => image)
    .slice(0, 20)
}

function imageScore(image, site, titleWords) {
  let score = image.role === 'structured' ? 10 : image.role === 'meta' ? 7 : 0
  const value = `${image.src} ${image.alt || ''}`.toLowerCase()
  if (site.id === 'shopee' && /(shopee|shopeeusercontent|cf\.shopee)/i.test(value)) score += 7
  if (site.id === 'mercadolivre' && /(mlstatic|mlcdn)/i.test(value)) score += 7
  if (site.id === 'amazon' && /(media-amazon|ssl-images-amazon|images-amazon)/i.test(value)) score += 7
  const altWords = cleanText(image.alt).toLowerCase().split(/\s+/)
  score += altWords.filter((word) => titleWords.has(word)).length * 0.8
  return score
}

function normalizeVariations(groups = []) {
  const output = []
  for (const group of groups || []) {
    const name = cleanText(group?.name) || 'Opções'
    const options = [...new Set((group?.options || []).map(cleanText).filter((x) => x && x.length <= 120))].slice(0, 30)
    if (options.length < 2) continue
    if (!output.some((item) => item.name === name && item.options.join('|') === options.join('|'))) output.push({ name, options })
  }
  return output.slice(0, 8)
}
function normalizeAttributes(items = []) { return (items || []).filter((item) => item?.name && item?.value).slice(0, 30) }

function registerImage(image, images, content, baseUrl) {
  const src = resolveImageUrl(imageSource(image), baseUrl)
  if (!src || images.some((item) => item.src === src)) return
  const alt = cleanText(image.getAttribute('alt') || image.getAttribute('title'))
  images.push({ src, alt })
  content.push({ type: 'image', src, alt })
}

function collectDocumentImages(doc, baseUrl) {
  const images = []
  const add = (source, alt = '', role = 'page') => {
    const src = resolveImageUrl(source, baseUrl)
    if (!src || images.some((item) => item.src === src)) return
    images.push({ src, alt: cleanText(alt), role })
  }
  const title = cleanText(doc.title)
  add(meta(doc, 'property', 'og:image'), title, 'meta')
  add(meta(doc, 'property', 'og:image:url'), title, 'meta')
  add(meta(doc, 'name', 'twitter:image'), title, 'meta')
  add(doc.querySelector('link[rel="image_src"]')?.getAttribute('href'), title, 'meta')
  doc.querySelectorAll('img').forEach((image) => {
    const width = Number(image.getAttribute('width') || 0); const height = Number(image.getAttribute('height') || 0)
    if ((width > 0 && width <= 4) || (height > 0 && height <= 4)) return
    const alt = image.getAttribute('alt') || image.getAttribute('title') || ''
    add(imageSource(image), alt); add(bestSrcsetSource(image.getAttribute('srcset') || image.getAttribute('data-srcset')), alt)
  })
  doc.querySelectorAll('picture source[srcset], source[data-srcset]').forEach((source) => add(bestSrcsetSource(source.getAttribute('srcset') || source.getAttribute('data-srcset')), ''))
  return images.slice(0, 100)
}
function imageSource(image) { return image?.getAttribute('src') || image?.getAttribute('data-src') || image?.getAttribute('data-lazy-src') || image?.getAttribute('data-original') || image?.getAttribute('data-image') || bestSrcsetSource(image?.getAttribute('srcset') || image?.getAttribute('data-srcset')) || '' }
function bestSrcsetSource(value = '') { return String(value).split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => { const parts = entry.split(/\s+/); return { source: parts[0], score: Number.parseFloat(parts[1] || '') || 0 } }).sort((a, b) => b.score - a.score)[0]?.source || '' }
function resolveImageUrl(source, baseUrl) {
  if (!source || /^(data|blob|javascript):/i.test(String(source))) return ''
  try {
    const resolved = new URL(String(source).trim(), baseUrl)
    if (!['http:', 'https:'].includes(resolved.protocol) || isPrivateImageHost(resolved.hostname) || /\b(pixel|spacer|tracking)(?:[._-]|$)/i.test(resolved.pathname)) return ''
    return resolved.toString()
  } catch { return '' }
}
function isPrivateImageHost(hostname = '') { const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, ''); if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || /^127\./.test(host) || /^10\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host)) return true; const match = host.match(/^172\.(\d{1,3})\./); return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31) }
function mergeImages(...groups) {
  const merged = []
  groups.flat().forEach((image) => {
    const item = typeof image === 'string' ? { src: image, alt: '' } : image
    const src = resolveImageUrl(item?.src, item?.src)
    if (!src || merged.some((current) => current.src === src)) return
    merged.push({ ...item, src, alt: cleanText(item?.alt) })
  })
  return merged.slice(0, 100)
}

function findProductJsonLd(doc) { const candidates = []; doc.querySelectorAll('script[type="application/ld+json"]').forEach((element) => { try { collectJsonLd(JSON.parse(element.textContent.trim()), candidates) } catch { /* ignore */ } }); return candidates.find((entry) => typeIncludes(entry?.['@type'], 'Product')) || null }
function collectJsonLd(value, output) { if (!value) return; if (Array.isArray(value)) { value.forEach((item) => collectJsonLd(item, output)); return } if (typeof value !== 'object') return; output.push(value); if (Array.isArray(value['@graph'])) value['@graph'].forEach((item) => collectJsonLd(item, output)) }
function typeIncludes(value, expected) { if (Array.isArray(value)) return value.some((item) => String(item).toLowerCase() === expected.toLowerCase()); return String(value || '').toLowerCase() === expected.toLowerCase() }
function firstOffer(offers) { if (Array.isArray(offers)) return offers.find(Boolean) || null; return offers && typeof offers === 'object' ? offers : null }
function meta(doc, attribute, value) { return doc.querySelector(`meta[${attribute}="${value}"]`)?.getAttribute('content') || '' }
function attrOrText(element) { return element?.getAttribute('content') || element?.getAttribute('href') || element?.textContent || '' }
function firstNonEmpty(...values) { return values.find((value) => cleanText(value)) || '' }
function normalizeImageCandidates(value) { if (Array.isArray(value)) return value.flatMap((item) => normalizeImageCandidates(item)); if (typeof value === 'string') return [value]; if (value && typeof value === 'object') return normalizeImageCandidates(value.url || value.contentUrl); return [] }
function cleanAvailability(value) { const cleaned = cleanText(value); if (!cleaned) return null; const token = cleaned.split('/').pop(); return ({ InStock: 'Em estoque', OutOfStock: 'Sem estoque', PreOrder: 'Pré-venda', LimitedAvailability: 'Estoque limitado', OnlineOnly: 'Somente online', SoldOut: 'Esgotado' })[token] || token || cleaned }
function formatPrice(price, currency) { if (!price) return ''; const symbols = { BRL: 'R$', USD: 'US$', EUR: '€', GBP: '£' }; const prefix = symbols[String(currency || '').toUpperCase()] || cleanText(currency); return `${prefix}${prefix ? ' ' : ''}${price}`.trim() }
function titleFromDocument(doc) { return cleanText(doc.querySelector('h1')?.textContent || doc.title || '') }
function finishArticle(article) {
  const wordCount = getWordCount(article.content)
  const base = { ...article, wordCount, readingTimeMinutes: readingTimeMinutes(wordCount) }
  return base.quality ? base : { ...base, quality: scoreContentQuality(base) }
}
function resultQualityScore(result) { return Number(result?.quality?.score || result?.product?.quality?.score || 0) }
function shouldAcceptResult(result) {
  const score = resultQualityScore(result)
  if (result?.type === 'product') return score >= 60
  return score >= 55
}
