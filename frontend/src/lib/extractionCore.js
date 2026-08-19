export const CLOUD_FIRST_DOMAINS = [
  'aliexpress',
  'amazon',
  'mercadolivre',
  'mercadolibre',
  'shopee',
  'temu',
]

export function normalizeHttpUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim())
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('URL_INVALIDA')
    if (parsed.username || parsed.password) throw new Error('URL_INVALIDA')
    return parsed.toString()
  } catch {
    throw new Error('URL_INVALIDA')
  }
}

export function isCloudFirstDomain(url) {
  const hostname = new URL(url).hostname.toLowerCase()
  return CLOUD_FIRST_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`) || hostname.includes(domain))
}

export function looksLikeChallenge(html = '') {
  const value = String(html).toLowerCase()
  return (
    value.includes('just a moment...') ||
    value.includes('enable javascript') ||
    value.includes('cf-chl-') ||
    value.includes('captcha') ||
    value.includes('access denied')
  )
}

export function cleanText(value = '') {
  return String(value).trim().replace(/\s+/g, ' ')
}

export function getWordCount(content = []) {
  return content.reduce((sum, block) => {
    if (['paragraph', 'heading', 'quote'].includes(block?.type)) {
      return sum + cleanText(block.text).split(/\s+/).filter(Boolean).length
    }
    if (block?.type === 'list' && Array.isArray(block.items)) {
      return sum + block.items.join(' ').split(/\s+/).filter(Boolean).length
    }
    return sum
  }, 0)
}

export function readingTimeMinutes(wordCount) {
  return Math.max(1, Math.round(Number(wordCount || 0) / 200))
}

export function scoreContentQuality(article = {}) {
  const content = Array.isArray(article.content) ? article.content : []
  const wordCount = getWordCount(content)
  const paragraphs = content.filter((block) => block?.type === 'paragraph' && cleanText(block.text).length >= 40).length
  const headings = content.filter((block) => block?.type === 'heading').length
  let score = 0
  const signals = []
  const add = (ok, points, label) => { if (ok) { score += points; signals.push(label) } }
  add(Boolean(cleanText(article.title) && !/^sem título$/i.test(cleanText(article.title))), 20, 'título')
  add(wordCount >= 80, 15, 'texto')
  add(wordCount >= 250, 15, 'conteúdo suficiente')
  add(wordCount >= 600, 10, 'conteúdo extenso')
  add(paragraphs >= 3, 15, 'parágrafos')
  add(headings >= 1, 8, 'estrutura')
  add(Boolean(article.excerpt), 5, 'resumo')
  add(Boolean(article.byline || article.siteName), 5, 'origem')
  add(Array.isArray(article.images) && article.images.length > 0, 7, 'imagens')
  score = Math.min(100, score)
  const level = score >= 70 ? 'high' : score >= 45 ? 'medium' : 'partial'
  const label = level === 'high' ? 'extração completa' : level === 'medium' ? 'extração boa' : 'extração parcial'
  return { score, level, label, signals, warnings: level === 'partial' ? ['conteúdo pode estar incompleto'] : [] }
}
