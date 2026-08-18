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
} from './extractionCore'

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

export async function extractArticleNative(rawUrl) {
  const url = normalizeHttpUrl(rawUrl)
  const attempts = isCloudFirstDomain(url)
    ? [extractViaJina, extractDirect]
    : [extractDirect, extractViaJina]

  let lastError = null
  for (const attempt of attempts) {
    try {
      return await attempt(url)
    } catch (error) {
      lastError = error
      if (error?.message === 'HTTP_404' || error?.message === 'PAGE_TOO_LARGE') throw error
    }
  }

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

  return extractFromHtml(html, url)
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
    try {
      payload = JSON.parse(payload)
    } catch {
      payload = null
    }
  }

  const data = payload?.data || payload
  const markdown = data?.content || ''
  if (!markdown.trim()) throw new Error('EXTRACTION_FAILED')

  const html = marked.parse(markdown)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const { content, images } = blocksFromDocument(doc, url)
  if (!content.length) throw new Error('EXTRACTION_FAILED')

  return finishArticle({
    title: cleanText(data?.title) || titleFromDocument(doc) || 'Sem título',
    byline: cleanText(data?.siteName) || 'Extração alternativa',
    siteName: cleanText(data?.siteName) || new URL(url).hostname,
    excerpt: cleanText(data?.description) || null,
    content,
    images,
  })
}

function extractFromHtml(html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const pageTitle = cleanText(doc.title) || 'Sem título'
  const product = extractProductFromDocument(doc, url)
  if (product) return buildProductArticle(product, url)

  JUNK_SELECTORS.forEach((selector) => {
    try {
      doc.querySelectorAll(selector).forEach((element) => element.remove())
    } catch {
      // Um seletor inválido nunca deve impedir a extração inteira.
    }
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
        images,
      })
    }
  }

  return extractFallback(doc, url, pageTitle)
}

function extractProductFromDocument(doc, baseUrl) {
  const structured = findProductJsonLd(doc)
  const offer = firstOffer(structured?.offers)

  const name = firstNonEmpty(
    structured?.name,
    meta(doc, 'property', 'og:title'),
    meta(doc, 'name', 'twitter:title'),
    attrOrText(doc.querySelector('[itemprop="name"]')),
    doc.querySelector('h1')?.textContent,
  )

  const price = firstNonEmpty(
    offer?.price,
    offer?.lowPrice,
    meta(doc, 'property', 'product:price:amount'),
    meta(doc, 'itemprop', 'price'),
    doc.querySelector('[itemprop="price"]')?.getAttribute('content'),
    doc.querySelector('[itemprop="price"]')?.textContent,
    doc.querySelector('[data-testid*="price"], [data-test*="price"], .andes-money-amount__fraction, .price, [class*="price"], [class*="Price"]')?.textContent,
  )

  const currency = firstNonEmpty(
    offer?.priceCurrency,
    meta(doc, 'property', 'product:price:currency'),
    doc.querySelector('[itemprop="priceCurrency"]')?.getAttribute('content'),
  )

  const description = firstNonEmpty(
    structured?.description,
    meta(doc, 'property', 'og:description'),
    meta(doc, 'name', 'description'),
    doc.querySelector('[itemprop="description"]')?.textContent,
  )

  const brand = firstNonEmpty(
    typeof structured?.brand === 'string' ? structured.brand : structured?.brand?.name,
    attrOrText(doc.querySelector('[itemprop="brand"]')),
  )

  const availability = firstNonEmpty(
    offer?.availability,
    meta(doc, 'property', 'product:availability'),
    doc.querySelector('[itemprop="availability"]')?.getAttribute('href'),
    doc.querySelector('[itemprop="availability"]')?.textContent,
  )

  const seller = firstNonEmpty(
    typeof offer?.seller === 'string' ? offer.seller : offer?.seller?.name,
    doc.querySelector('[itemprop="seller"]')?.textContent,
  )

  const rating = firstNonEmpty(
    structured?.aggregateRating?.ratingValue,
    doc.querySelector('[itemprop="ratingValue"]')?.getAttribute('content'),
    doc.querySelector('[itemprop="ratingValue"]')?.textContent,
  )

  const reviewCount = firstNonEmpty(
    structured?.aggregateRating?.reviewCount,
    structured?.aggregateRating?.ratingCount,
    doc.querySelector('[itemprop="reviewCount"]')?.getAttribute('content'),
    doc.querySelector('[itemprop="reviewCount"]')?.textContent,
  )

  const sku = firstNonEmpty(structured?.sku, structured?.mpn, doc.querySelector('[itemprop="sku"]')?.textContent)
  const imageCandidates = normalizeImageCandidates(structured?.image)
  imageCandidates.push(
    meta(doc, 'property', 'og:image'),
    meta(doc, 'name', 'twitter:image'),
    doc.querySelector('[itemprop="image"]')?.getAttribute('src'),
  )
  const images = [...new Set(imageCandidates.filter(Boolean).map((source) => resolveUrl(source, baseUrl)))]

  const hasStrongSignal = Boolean(
    structured ||
    (cleanText(name) && cleanText(price)) ||
    (doc.querySelector('[itemtype*="schema.org/Product"]') && cleanText(name))
  )
  if (!hasStrongSignal) return null

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
  }
}

function buildProductArticle(product, url) {
  const details = []
  const formattedPrice = formatPrice(product.price, product.currency)
  if (formattedPrice) details.push(`Preço: ${formattedPrice}`)
  if (product.availability) details.push(`Disponibilidade: ${product.availability}`)
  if (product.brand) details.push(`Marca: ${product.brand}`)
  if (product.seller) details.push(`Vendido por: ${product.seller}`)
  if (product.rating) details.push(`Avaliação: ${product.rating}${product.reviewCount ? ` (${product.reviewCount} avaliações)` : ''}`)
  if (product.sku) details.push(`Código/SKU: ${product.sku}`)

  const content = []
  if (details.length) content.push({ type: 'list', ordered: false, items: details })
  if (product.description) {
    content.push({ type: 'heading', level: 2, text: 'Descrição' })
    content.push({ type: 'paragraph', text: product.description })
  }
  product.images.forEach((src) => content.push({ type: 'image', src, alt: product.name }))
  if (!content.length) content.push({ type: 'paragraph', text: product.name })

  return finishArticle({
    title: product.name,
    byline: product.brand || product.seller || 'Produto',
    siteName: new URL(url).hostname,
    excerpt: product.description,
    content,
    images: product.images.map((src) => ({ src, alt: product.name })),
    type: 'product',
    product,
  })
}

function extractFallback(doc, url, pageTitle) {
  doc.querySelectorAll('nav, footer, header, aside, .menu, script, style, form').forEach((element) => element.remove())
  const content = []
  const marketItems = new Set()

  doc.querySelectorAll('[data-test="instrument-price-last"], .text-5xl.font-bold, .pid-ext-price').forEach((element) => {
    const value = cleanText(element.textContent)
    const name = cleanText(doc.querySelector('h1')?.textContent) || 'Ativo'
    if (value && /^[0-9.,]+$/.test(value)) marketItems.add(`💰 ${name}: ${value}`)
  })

  if (marketItems.size) {
    content.push({ type: 'heading', level: 2, text: '📈 Cotações' })
    content.push({ type: 'list', ordered: false, items: [...marketItems] })
  }

  const headlines = new Set()
  doc.querySelectorAll('h1, h2, h3, h4, .post-title, .title').forEach((element) => {
    const text = cleanText(element.textContent)
    if (text.length >= 20 && text.split(/\s+/).length >= 3) headlines.add(text)
  })

  if (headlines.size) {
    content.push({ type: 'heading', level: 2, text: '📰 Conteúdo encontrado' })
    content.push({ type: 'list', ordered: false, items: [...headlines] })
  }

  if (!content.length) throw new Error('EXTRACTION_FAILED')
  return finishArticle({
    title: pageTitle,
    byline: 'Resumo automático',
    siteName: new URL(url).hostname,
    excerpt: null,
    content,
    images: [],
  })
}

function finishArticle(article) {
  const wordCount = getWordCount(article.content)
  return {
    ...article,
    wordCount,
    readingTimeMinutes: readingTimeMinutes(wordCount),
  }
}

function blocksFromDocument(doc, baseUrl) {
  const content = []
  const images = []
  const root = doc.body || doc.documentElement
  Array.from(root.children).forEach((element) => walkElement(element, content, images, baseUrl))
  return { content, images }
}

function walkElement(element, content, images, baseUrl) {
  const tag = element.tagName?.toLowerCase()
  if (!tag) return

  if (/^h[1-6]$/.test(tag)) {
    const text = cleanText(element.textContent)
    if (text) content.push({ type: 'heading', level: Number(tag[1]), text })
    return
  }

  if (tag === 'p') {
    const text = cleanText(element.textContent)
    if (text) content.push({ type: 'paragraph', text })
    element.querySelectorAll('img').forEach((image) => registerImage(image, images, content, baseUrl))
    return
  }

  if (tag === 'blockquote') {
    const text = cleanText(element.textContent)
    if (text) content.push({ type: 'quote', text })
    return
  }

  if (tag === 'ul' || tag === 'ol') {
    const items = Array.from(element.children)
      .filter((child) => child.tagName?.toLowerCase() === 'li')
      .map((child) => cleanText(child.textContent))
      .filter(Boolean)
    if (items.length) content.push({ type: 'list', ordered: tag === 'ol', items })
    return
  }

  if (tag === 'img') {
    registerImage(element, images, content, baseUrl)
    return
  }

  if (tag === 'figure') {
    const image = element.querySelector('img')
    if (image) registerImage(image, images, content, baseUrl)
    const caption = cleanText(element.querySelector('figcaption')?.textContent)
    if (caption) content.push({ type: 'paragraph', text: caption })
    return
  }

  if (element.children.length) {
    Array.from(element.children).forEach((child) => walkElement(child, content, images, baseUrl))
  } else {
    const text = cleanText(element.textContent)
    if (text) content.push({ type: 'paragraph', text })
  }
}

function registerImage(image, images, content, baseUrl) {
  const source = image.getAttribute('src') || image.getAttribute('data-src') || image.getAttribute('data-lazy-src')
  if (!source) return
  const src = resolveUrl(source, baseUrl)
  const alt = cleanText(image.getAttribute('alt'))
  if (images.some((item) => item.src === src)) return
  images.push({ src, alt })
  content.push({ type: 'image', src, alt })
}

function findProductJsonLd(doc) {
  const candidates = []
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((element) => {
    try {
      collectJsonLd(JSON.parse(element.textContent.trim()), candidates)
    } catch {
      // Blocos JSON-LD inválidos são ignorados individualmente.
    }
  })
  return candidates.find((entry) => typeIncludes(entry?.['@type'], 'Product')) || null
}

function collectJsonLd(value, output) {
  if (!value) return
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonLd(item, output))
    return
  }
  if (typeof value !== 'object') return
  output.push(value)
  if (Array.isArray(value['@graph'])) value['@graph'].forEach((item) => collectJsonLd(item, output))
}

function typeIncludes(value, expected) {
  if (Array.isArray(value)) return value.some((item) => String(item).toLowerCase() === expected.toLowerCase())
  return String(value || '').toLowerCase() === expected.toLowerCase()
}

function firstOffer(offers) {
  if (Array.isArray(offers)) return offers.find(Boolean) || null
  return offers && typeof offers === 'object' ? offers : null
}

function meta(doc, attribute, value) {
  return doc.querySelector(`meta[${attribute}="${value}"]`)?.getAttribute('content') || ''
}

function attrOrText(element) {
  return element?.getAttribute('content') || element?.textContent || ''
}

function firstNonEmpty(...values) {
  return values.find((value) => cleanText(value)) || ''
}

function normalizeImageCandidates(value) {
  if (Array.isArray(value)) return value.flatMap((item) => normalizeImageCandidates(item))
  if (typeof value === 'string') return [value]
  if (value && typeof value === 'object') return normalizeImageCandidates(value.url || value.contentUrl)
  return []
}

function normalizePrice(value) {
  const cleaned = cleanText(value)
  if (!cleaned) return null
  const match = cleaned.match(/(?:R\$|US\$|\$|€|£)?\s*([0-9][0-9.,]*)/)
  return match ? match[1] : cleaned
}

function formatPrice(price, currency) {
  if (!price) return null
  const symbols = { BRL: 'R$', USD: 'US$', EUR: '€', GBP: '£' }
  const prefix = symbols[String(currency || '').toUpperCase()] || cleanText(currency)
  return `${prefix}${prefix ? ' ' : ''}${price}`.trim()
}

function cleanAvailability(value) {
  const cleaned = cleanText(value)
  if (!cleaned) return null
  const token = cleaned.split('/').pop()
  const labels = {
    InStock: 'Em estoque',
    OutOfStock: 'Sem estoque',
    PreOrder: 'Pré-venda',
    LimitedAvailability: 'Estoque limitado',
    OnlineOnly: 'Somente online',
    SoldOut: 'Esgotado',
  }
  return labels[token] || token || cleaned
}

function resolveUrl(source, baseUrl) {
  try {
    return new URL(source, baseUrl).toString()
  } catch {
    return source
  }
}

function titleFromDocument(doc) {
  return cleanText(doc.querySelector('h1')?.textContent || doc.title || '')
}
