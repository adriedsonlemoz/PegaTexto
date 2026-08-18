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
