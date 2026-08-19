import ProductGallery from './ProductGallery'

export default function ProductView({ article }) {
  const product = article.product || {}
  const quality = article.quality || product.quality

  return (
    <article className="space-y-7">
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wide">
          <span className="rounded-full border border-accent/30 px-2.5 py-1 text-accent dark:border-accent-bright/30 dark:text-accent-bright">Produto · {product.siteLabel || article.siteName}</span>
          {quality && <QualityBadge quality={quality} />}
        </div>
        <h1 className="text-2xl font-semibold leading-snug md:text-3xl">{product.name || article.title}</h1>
        {(product.brand || product.sku) && <p className="mt-2 font-mono text-xs text-ink-soft dark:text-white/45">{[product.brand && `Marca: ${product.brand}`, product.sku && `SKU: ${product.sku}`].filter(Boolean).join(' · ')}</p>}
      </div>

      <ProductGallery images={product.images || []} title={product.name || article.title} />

      <section className="rounded-xl border border-ink/10 bg-white/70 p-4 dark:border-white/10 dark:bg-white/[0.035]">
        <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
          {product.price ? <div className="text-3xl font-semibold tracking-tight">{formatPrice(product.price, product.currency)}</div> : <div className="font-mono text-sm text-ink-soft dark:text-white/50">Preço não identificado</div>}
          {product.originalPrice && <div className="pb-1 text-sm text-ink-soft line-through dark:text-white/40">{formatPrice(product.originalPrice, product.currency)}</div>}
          {product.discount && <span className="mb-1 rounded bg-accent/10 px-2 py-1 font-mono text-[10px] font-semibold text-accent dark:bg-accent-bright/10 dark:text-accent-bright">{product.discount}</span>}
        </div>
        {product.installment && <p className="mt-1 text-sm text-ink-soft dark:text-white/55">{product.installment}</p>}
        <div className="mt-3 flex flex-wrap gap-2 font-mono text-[11px] text-ink-soft dark:text-white/55">
          {product.rating && <InfoChip>{product.rating} ★{product.reviewCount ? ` · ${product.reviewCount} avaliações` : ''}</InfoChip>}
          {product.soldCount && <InfoChip>{product.soldCount} vendidos</InfoChip>}
          {product.availability && <InfoChip>{product.availability}</InfoChip>}
        </div>
      </section>

      {(product.seller || product.shipping) && (
        <section className="grid gap-3 sm:grid-cols-2">
          {product.seller && <InfoCard label="Vendedor" value={product.seller} />}
          {product.shipping && <InfoCard label="Entrega" value={product.shipping} />}
        </section>
      )}

      {product.variations?.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Opções do produto</h2>
          <div className="space-y-4">
            {product.variations.map((group, index) => (
              <div key={`${group.name}-${index}`}>
                <div className="mb-2 font-mono text-[11px] uppercase tracking-wide text-ink-soft dark:text-white/45">{group.name}</div>
                <div className="flex flex-wrap gap-2">
                  {group.options.map((option) => <span key={option} className="rounded-lg border border-ink/15 bg-white/60 px-3 py-2 text-sm dark:border-white/15 dark:bg-white/[0.03]">{option}</span>)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {product.description && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Descrição</h2>
          <div className="space-y-3 text-[16px] leading-7 text-ink/90 dark:text-white/80">
            {product.description.split(/\n+/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
          </div>
        </section>
      )}

      {product.attributes?.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Características</h2>
          <dl className="overflow-hidden rounded-xl border border-ink/10 dark:border-white/10">
            {product.attributes.map((item, index) => (
              <div key={`${item.name}-${index}`} className="grid grid-cols-[minmax(7rem,0.8fr)_1.2fr] gap-3 border-b border-ink/10 px-3 py-3 text-sm last:border-b-0 dark:border-white/10">
                <dt className="font-medium text-ink-soft dark:text-white/50">{item.name}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {quality?.warnings?.length > 0 && quality.level === 'partial' && (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-3 font-mono text-[11px] text-ink-soft dark:text-white/55">
          Extração parcial: {quality.warnings.join(' · ')}.
        </div>
      )}
    </article>
  )
}

function InfoChip({ children }) { return <span className="rounded-full border border-ink/10 px-2.5 py-1 dark:border-white/10">{children}</span> }
function InfoCard({ label, value }) { return <div className="rounded-xl border border-ink/10 px-4 py-3 dark:border-white/10"><div className="font-mono text-[10px] uppercase tracking-wide text-ink-soft dark:text-white/40">{label}</div><div className="mt-1 text-sm leading-6">{value}</div></div> }
function QualityBadge({ quality }) {
  const styles = quality.level === 'high' ? 'border-emerald-500/30 text-emerald-700 dark:text-emerald-400' : quality.level === 'medium' ? 'border-amber-500/30 text-amber-700 dark:text-amber-400' : 'border-ink/15 text-ink-soft dark:border-white/15 dark:text-white/45'
  return <span className={`rounded-full border px-2.5 py-1 ${styles}`}>{quality.label} · {quality.score}%</span>
}
function formatPrice(price, currency) { const symbols = { BRL: 'R$', USD: 'US$', EUR: '€', GBP: '£' }; const prefix = symbols[String(currency || '').toUpperCase()] || currency || ''; return `${prefix}${prefix ? ' ' : ''}${price}`.trim() }
