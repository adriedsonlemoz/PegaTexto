export default function ReaderView({ article, showImages }) {
  const product = article.type === 'product' ? article.product : null

  return (
    <article>
      {product && (
        <div className="mb-5 inline-flex items-center rounded-full border border-accent/30 dark:border-accent-bright/30 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide text-accent dark:text-accent-bright">
          produto detectado
        </div>
      )}
      <h1 className="text-2xl md:text-3xl font-semibold leading-snug mb-2">
        {article.title}
      </h1>
      {(article.byline || article.siteName) && (
        <p className="font-mono text-xs text-ink-soft dark:text-white/40 mb-8">
          {[article.byline, article.siteName].filter(Boolean).join(' · ')}
        </p>
      )}
      {product?.price && (
        <div className="mb-8 rounded-md border border-ink/10 dark:border-white/10 bg-white/60 dark:bg-white/[0.03] px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-wider text-ink-soft dark:text-white/40">preço identificado</div>
          <div className="mt-1 text-xl font-semibold">
            {formatProductPrice(product.price, product.currency)}
          </div>
          {product.availability && (
            <div className="mt-1 font-mono text-xs text-ink-soft dark:text-white/50">{product.availability}</div>
          )}
        </div>
      )}
      <div className="space-y-5 text-[17px] leading-[1.8]">
        {article.content.map((block, i) => {
          if (block.type === 'image') {
            return showImages ? (
              <img key={i} src={block.src} alt={block.alt} className="rounded-md w-full" loading="lazy" />
            ) : null
          }
          if (block.type === 'heading') {
            const Tag = `h${Math.min(block.level + 1, 6)}`
            return (
              <Tag key={i} className="font-semibold pt-4 text-lg md:text-xl">
                {block.text}
              </Tag>
            )
          }
          if (block.type === 'quote') {
            return (
              <blockquote
                key={i}
                className="border-l-2 border-accent dark:border-accent-bright pl-4 italic text-ink-soft dark:text-white/70"
              >
                {block.text}
              </blockquote>
            )
          }
          if (block.type === 'list') {
            const ListTag = block.ordered ? 'ol' : 'ul'
            return (
              <ListTag key={i} className={block.ordered ? 'list-decimal pl-5' : 'list-disc pl-5'}>
                {block.items.map((item, j) => <li key={j} className="mb-2">{item}</li>)}
              </ListTag>
            )
          }
          return <p key={i}>{block.text}</p>
        })}
      </div>
    </article>
  )
}

function formatProductPrice(price, currency) {
  const symbols = { BRL: 'R$', USD: 'US$', EUR: '€', GBP: '£' }
  const prefix = symbols[String(currency || '').toUpperCase()] || currency || ''
  return `${prefix}${prefix ? ' ' : ''}${price}`.trim()
}
