const SITE_RULES = [
  { id: 'shopee', label: 'Shopee', domains: ['shopee.com.br', 'shopee.com'], productPaths: [/\/product\/\d+\/\d+/i, /-i\.\d+\.\d+/i] },
  { id: 'mercadolivre', label: 'Mercado Livre', domains: ['mercadolivre.com.br', 'mercadolibre.com'], productPaths: [/\/MLB-?\d+/i, /\/p\/MLB/i, /produto\.mercadolivre/i] },
  { id: 'amazon', label: 'Amazon', domains: ['amazon.com.br', 'amazon.com'], productPaths: [/\/dp\/[A-Z0-9]{8,}/i, /\/gp\/product\/[A-Z0-9]{8,}/i] },
]

const PRODUCT_JUNK = [
  /^ir para o conteúdo principal$/i,
  /^central do vendedor/i,
  /^vender na/i,
  /^baixe o app$/i,
  /^siga-nos/i,
  /^ajuda$/i,
  /^português\s*\(br\)$/i,
  /^cadastrar\s*entre$/i,
  /^compartilhar:?$/i,
  /^denunciar$/i,
  /^enviado de$/i,
  /^você também pode gostar/i,
  /^produtos relacionados/i,
  /^quem viu também/i,
  /^ofertas incríveis/i,
  /^melhores preços do mercado/i,
  /^shopee brasil/i,
  /^mercado livre brasil/i,
  /^amazon\.com/i,
]

export function detectSite(rawUrl) {
  let parsed
  try { parsed = new URL(rawUrl) } catch { return { id: 'generic', label: 'Site', hostname: '' } }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '')
  const found = SITE_RULES.find((site) => site.domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`)))
  return found ? { ...found, hostname } : { id: 'generic', label: hostname || 'Site', hostname, productPaths: [] }
}

export function isLikelyProductUrl(rawUrl) {
  const site = detectSite(rawUrl)
  if (site.id === 'generic') return /\/(product|produto|item|p)\//i.test(String(rawUrl || ''))
  const pathname = safePathname(rawUrl)
  return site.productPaths.some((pattern) => pattern.test(pathname)) || (site.id === 'mercadolivre' && /MLB-?\d+/i.test(String(rawUrl || '')))
}

export function classifyPage({ url, hasStructuredProduct = false, title = '', price = '', articleTextLength = 0, headings = 0 } = {}) {
  const site = detectSite(url)
  const productUrl = isLikelyProductUrl(url)
  const productSignal = Number(hasStructuredProduct) * 4 + Number(productUrl) * 3 + Number(Boolean(cleanText(price))) * 2 + Number(isProductLikeTitle(title))
  if (productSignal >= 4) return { type: 'product', site, score: productSignal }
  if (articleTextLength >= 500 || (articleTextLength >= 260 && headings >= 2)) return { type: 'article', site, score: Math.min(10, Math.round(articleTextLength / 250)) }
  return { type: 'page', site, score: 1 }
}

export function isProductJunkText(value) {
  const text = cleanText(value)
  if (!text || text.length <= 1) return true
  return PRODUCT_JUNK.some((pattern) => pattern.test(text))
}

export function pickBestProductTitle(candidates = [], fallback = '') {
  const normalized = [...new Set(candidates.map((value) => cleanText(value)).filter(Boolean))]
  const scored = normalized
    .filter((value) => !isProductJunkText(value))
    .filter((value) => value.length >= 10 && value.length <= 240)
    .map((value, index) => ({ value, score: titleScore(value) - index * 0.03 }))
    .sort((a, b) => b.score - a.score)
  return scored[0]?.value || cleanText(fallback) || 'Produto'
}

export function cleanProductDescription(value = '') {
  const raw = String(value || '').replace(/\r/g, '\n')
  const lines = raw.split(/\n+/).map((line) => cleanText(line)).filter(Boolean)
  const kept = []
  for (const line of lines) {
    if (isProductJunkText(line)) continue
    if (line.length < 3) continue
    if (kept.at(-1) === line) continue
    kept.push(line)
  }
  return kept.join('\n').trim()
}

export function normalizeProductPrice(value) {
  const text = cleanText(value)
  if (!text) return null
  const match = text.match(/(?:R\$|US\$|\$|€|£)?\s*([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{1,2})?|[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]+(?:[.,][0-9]{1,2})?)/)
  return match?.[1]?.replace(/\s/g, '') || null
}

export function inferCurrency(value, fallback = null) {
  const text = String(value || '')
  if (/R\$/i.test(text)) return 'BRL'
  if (/US\$/i.test(text)) return 'USD'
  if (/€/.test(text)) return 'EUR'
  if (/£/.test(text)) return 'GBP'
  return fallback
}

export function scoreProductQuality(product = {}, { siteSpecific = false } = {}) {
  let score = 0
  const signals = []
  const add = (ok, points, label) => { if (ok) { score += points; signals.push(label) } }
  add(Boolean(cleanText(product.name) && cleanText(product.name) !== 'Produto'), 20, 'título')
  add(Boolean(product.price), 20, 'preço')
  add(Boolean(cleanText(product.description) && cleanText(product.description).length >= 30), 15, 'descrição')
  add(Array.isArray(product.images) && product.images.length >= 1, 15, 'imagens')
  add(Boolean(product.seller), 5, 'vendedor')
  add(Boolean(product.rating), 5, 'avaliação')
  add(Boolean(product.reviewCount || product.soldCount), 4, 'popularidade')
  add(Array.isArray(product.variations) && product.variations.some((group) => group.options?.length), 5, 'variações')
  add(Array.isArray(product.attributes) && product.attributes.length, 5, 'atributos')
  add(Boolean(product.shipping || product.availability), 3, 'entrega/estoque')
  add(siteSpecific, 8, 'filtro específico')
  score = Math.min(100, score)
  const level = score >= 75 ? 'high' : score >= 50 ? 'medium' : 'partial'
  const label = level === 'high' ? 'extração completa' : level === 'medium' ? 'extração boa' : 'extração parcial'
  const warnings = []
  if (!product.price) warnings.push('preço não identificado')
  if (!product.description) warnings.push('descrição não identificada')
  if (!product.images?.length) warnings.push('imagens do produto não identificadas')
  return { score, level, label, signals, warnings }
}

export function siteLabel(rawUrl) {
  return detectSite(rawUrl).label
}

function safePathname(rawUrl) {
  try { return new URL(rawUrl).pathname } catch { return String(rawUrl || '') }
}

function isProductLikeTitle(value) {
  const text = cleanText(value)
  if (text.length < 18) return false
  return /\b(kit|tela|display|lcd|smartphone|celular|fone|notebook|camiseta|vestido|tênis|produto|modelo|compatível|original|aro|memória|gb|ml|unidade)\b/i.test(text)
}

function titleScore(value) {
  let score = Math.min(10, value.split(/\s+/).length * 0.45)
  if (value.length >= 25 && value.length <= 150) score += 3
  if (/\b(compatível|original|kit|modelo|tela|display|lcd|gb|ml|cm|mm|pro|max|plus)\b/i.test(value)) score += 2
  if (/\b(shopee|mercado livre|amazon|ofertas|preços do mercado)\b/i.test(value)) score -= 8
  if (/[|]/.test(value)) score -= 1
  return score
}

function cleanText(value = '') { return String(value ?? '').trim().replace(/\s+/g, ' ') }
