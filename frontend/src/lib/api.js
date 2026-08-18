import { Capacitor } from '@capacitor/core'
import { extractArticleNative } from './nativeExtractor'

const API_BASE = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '')

export async function extractArticle(url) {
  if (Capacitor.isNativePlatform()) {
    return extractArticleNative(url)
  }

  const res = await fetch(`${API_BASE}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}))
    throw new Error(errData.error || `HTTP_${res.status}`)
  }

  return res.json()
}
