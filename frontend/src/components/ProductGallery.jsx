import { useEffect, useMemo, useState } from 'react'

export default function ProductGallery({ images = [], title = 'Produto' }) {
  const safeImages = useMemo(() => [...new Set((images || []).filter((src) => /^https?:\/\//i.test(String(src || ''))))].slice(0, 20), [images])
  const [selected, setSelected] = useState(0)
  const [failed, setFailed] = useState(() => new Set())

  useEffect(() => {
    setSelected(0)
    setFailed(new Set())
  }, [safeImages.join('|')])

  const available = safeImages.filter((src) => !failed.has(src))
  const current = available[Math.min(selected, Math.max(0, available.length - 1))]

  const markFailed = (src) => {
    setFailed((previous) => new Set([...previous, src]))
    setSelected(0)
  }

  if (!current) {
    return (
      <div className="flex h-56 items-center justify-center rounded-xl border border-ink/10 bg-ink/[0.025] px-6 text-center font-mono text-xs text-ink-soft dark:border-white/10 dark:bg-white/[0.025] dark:text-white/45">
        Nenhuma imagem principal do produto foi identificada.
      </div>
    )
  }

  return (
    <section aria-label="Galeria do produto" className="space-y-3">
      <a href={current} target="_blank" rel="noreferrer" className="relative flex h-[19rem] items-center justify-center overflow-hidden rounded-xl border border-ink/10 bg-white dark:border-white/10 dark:bg-white/[0.03] sm:h-[25rem]">
        <img src={current} alt={title} onError={() => markFailed(current)} className="h-full w-full object-contain p-2" />
        <span className="absolute bottom-2 right-2 rounded-full bg-black/65 px-2.5 py-1 font-mono text-[10px] text-white">{Math.min(selected + 1, available.length)}/{available.length}</span>
      </a>
      {available.length > 1 && (
        <div className="grid grid-cols-5 gap-2 sm:grid-cols-7">
          {available.slice(0, 14).map((src, index) => (
            <button key={src} type="button" onClick={() => setSelected(index)} aria-label={`Ver imagem ${index + 1}`} className={`aspect-square overflow-hidden rounded-md border bg-white p-1 transition ${index === selected ? 'border-accent ring-1 ring-accent dark:border-accent-bright dark:ring-accent-bright' : 'border-ink/10 dark:border-white/10'} dark:bg-white/[0.03]`}>
              <img src={src} alt="" loading="lazy" onError={() => markFailed(src)} className="h-full w-full object-contain" />
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
