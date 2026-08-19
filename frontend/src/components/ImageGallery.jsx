import { useMemo, useState } from 'react'
import { writeClipboardText } from '../lib/clipboard'

export default function ImageGallery({ images = [] }) {
  const [copied, setCopied] = useState('')
  const safeImages = useMemo(() => {
    const seen = new Set()
    return images.filter((image) => {
      const src = String(image?.src || '').trim()
      if (!/^https?:\/\//i.test(src) || seen.has(src)) return false
      seen.add(src)
      return true
    })
  }, [images])

  const copyText = async (text, key) => {
    try {
      await writeClipboardText(text)
      setCopied(key)
      setTimeout(() => setCopied(''), 1600)
    } catch (error) {
      console.error('Erro ao copiar imagem', error)
      alert('Não foi possível copiar o link da imagem.')
    }
  }

  if (!safeImages.length) {
    return <div className="rounded-md border border-ink/10 dark:border-white/10 px-4 py-4 font-mono text-xs text-ink-soft dark:text-white/50">Nenhuma imagem pública foi encontrada nessa página.</div>
  }

  return (
    <section aria-label="Imagens extraídas" className="mt-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-mono text-sm font-semibold">Imagens extraídas</h2>
          <p className="mt-1 font-mono text-[11px] text-ink-soft dark:text-white/45">{safeImages.length} {safeImages.length === 1 ? 'imagem encontrada' : 'imagens encontradas'} na página</p>
        </div>
        <button type="button" onClick={() => copyText(safeImages.map((image) => image.src).join('\n'), 'all')} className="shrink-0 rounded-md border border-ink/15 dark:border-white/15 px-3 py-2 font-mono text-[10px] font-semibold hover:bg-ink/5 dark:hover:bg-white/5">{copied === 'all' ? 'LINKS COPIADOS ✓' : 'COPIAR LINKS'}</button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {safeImages.map((image, index) => {
          const key = `${index}:${image.src}`
          return (
            <div key={key} className="overflow-hidden rounded-lg border border-ink/10 dark:border-white/10 bg-white/60 dark:bg-white/[0.03]">
              <a href={image.src} target="_blank" rel="noreferrer" className="block bg-ink/[0.03] dark:bg-white/[0.03]">
                <img src={image.src} alt={image.alt || `Imagem ${index + 1}`} loading="lazy" className="h-52 w-full object-contain" />
              </a>
              <div className="p-3">
                <div className="mb-2 min-h-[2rem] font-mono text-[10px] text-ink-soft dark:text-white/45">{image.alt || `Imagem ${index + 1}`}</div>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => copyText(image.src, key)} className="rounded-md border border-ink/15 dark:border-white/15 px-2 py-2 font-mono text-[10px] font-semibold hover:bg-ink/5 dark:hover:bg-white/5">{copied === key ? 'COPIADO ✓' : 'COPIAR LINK'}</button>
                  <a href={image.src} target="_blank" rel="noreferrer" className="rounded-md bg-accent dark:bg-accent-bright px-2 py-2 text-center font-mono text-[10px] font-semibold text-white">ABRIR ORIGINAL</a>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
