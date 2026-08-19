import { useState, useEffect, useCallback, useRef } from 'react'
import { extractArticle } from './lib/api'
import { readClipboardText, writeClipboardText } from './lib/clipboard'
import ReaderView from './components/ReaderView'
import ImageGallery from './components/ImageGallery'

const STATUS = { IDLE: 'idle', LOADING: 'loading', DONE: 'done', ERROR: 'error' }

export default function App() {
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState(STATUS.IDLE)
  const [article, setArticle] = useState(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [showImages, setShowImages] = useState(false)
  const [showImageGallery, setShowImageGallery] = useState(false)
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const [copied, setCopied] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  const runExtraction = useCallback(async ({ openImages = false } = {}) => {
    if (!url.trim()) return
    setStatus(STATUS.LOADING)
    setArticle(null)
    setErrorMessage('')
    setShowImageGallery(openImages)
    try {
      const data = await extractArticle(url.trim())
      setArticle(data)
      setStatus(STATUS.DONE)
      setShowImageGallery(openImages)
      if (openImages) setShowImages(false)
    } catch (err) {
      setStatus(STATUS.ERROR)
      let msg = err.message;
      if (msg.startsWith('HTTP_')) {
        const code = msg.split('_')[1];
        if (code === '403' || code === '401') {
          msg = 'Acesso bloqueado pelo site (possível proteção anti-bot ou paywall).';
        } else if (code === '404') {
          msg = 'A página não foi encontrada (Erro 404).';
        } else {
          msg = `O site de origem retornou um erro (Status: ${code}).`;
        }
      } else if (msg === 'EXTRACTION_FAILED') {
        msg = 'Não foi possível encontrar texto nem manchetes nesta página.';
      } else if (msg === 'URL_INVALIDA') {
        msg = 'A URL fornecida é inválida.';
      } else if (msg === 'URL_BLOQUEADA') {
        msg = 'Esse endereço foi bloqueado por segurança.';
      } else if (msg === 'HOST_INACESSIVEL') {
        msg = 'Não foi possível localizar o servidor desse endereço.';
      } else if (msg === 'PAGE_TOO_LARGE') {
        msg = 'A página é grande demais para ser processada com segurança.';
      } else if (msg === 'CHALLENGE_PAGE') {
        msg = 'O site exibiu uma verificação anti-bot. Tente novamente ou use outro link da mesma página.';
      } else if (msg === 'CONTENT_TYPE_UNSUPPORTED') {
        msg = 'Esse link não aponta para uma página HTML compatível.';
      } else if (msg === 'TOO_MANY_REDIRECTS') {
        msg = 'A página redirecionou vezes demais e a extração foi interrompida.';
      } else if (msg.includes('Timeout') || msg.includes('timeout')) {
        msg = 'Tempo limite excedido. O site demorou muito para responder.';
      }
      setErrorMessage(msg)
    }
  }, [url])

  const handleExtract = (e) => {
    e.preventDefault()
    runExtraction()
  }

  const handleExtractImages = () => runExtraction({ openImages: true })

  const handleCopyAll = useCallback(async () => {
    if (!article) return
    const lines = [article.title, '']
    article.content.forEach((block) => {
      if (block.type === 'heading' || block.type === 'paragraph') lines.push(block.text, '')
      else if (block.type === 'quote') lines.push(`"${block.text}"`, '')
      else if (block.type === 'list') {
        block.items.forEach((item, i) => lines.push(`${block.ordered ? `${i + 1}.` : '-'} ${item}`))
        lines.push('')
      }
    })
    try {
      await writeClipboardText(lines.join('\n').trim())
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Erro ao copiar', err)
      alert('Não foi possível copiar automaticamente.')
    }
  }, [article])

  const handlePaste = async () => {
    try {
      const text = await readClipboardText()
      setUrl(text.trim())
      inputRef.current?.focus()
    } catch (err) {
      console.error('Erro ao colar', err)
      alert('Não foi possível colar automaticamente. Toque no campo e cole manualmente.')
      inputRef.current?.focus()
    }
  }

  const handleClear = () => {
    setUrl('')
    setArticle(null)
    setStatus(STATUS.IDLE)
    setShowImageGallery(false)
    setShowImages(false)
    inputRef.current?.focus()
  }

  return (
    <div className="app-shell min-h-screen bg-paper dark:bg-[#14171A] text-ink dark:text-[#E8E6DF] font-serif transition-colors">
      <header className="border-b border-ink/10 dark:border-white/10">
        <div className="safe-header max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="font-mono text-sm tracking-tight">
            <span className="text-accent dark:text-accent-bright">$</span> pega-texto
          </div>
          <button
            onClick={() => setDark((d) => !d)}
            className="font-mono text-xs px-2 py-1 rounded border border-ink/20 dark:border-white/20 hover:border-accent dark:hover:border-accent-bright transition-colors"
          >
            {dark ? 'claro' : 'escuro'}
          </button>
        </div>
      </header>
      <main className="safe-main max-w-2xl mx-auto px-4 pb-24">
        <form onSubmit={handleExtract} className="mt-8 mb-6 flex flex-col gap-3">
          <label className="block font-mono text-xs text-ink-soft dark:text-white/50">
            cole o link da matéria, e-commerce ou página
          </label>
          <div className="flex flex-col sm:flex-row gap-2 font-mono text-sm">
            <div className="flex-1 flex items-center bg-white dark:bg-black/30 border border-ink/15 dark:border-white/15 rounded-md px-3 focus-within:border-accent dark:focus-within:border-accent-bright transition-colors">
              <span className="text-accent dark:text-accent-bright mr-2">&gt;</span>
              <input
                ref={inputRef}
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://exemplo.com/materia"
                className="flex-1 bg-transparent py-3 outline-none placeholder:text-ink-soft/50 dark:placeholder:text-white/30 w-full"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handlePaste}
                className="flex-1 sm:flex-none px-4 py-3 rounded-md bg-ink/5 dark:bg-white/5 hover:bg-ink/10 dark:hover:bg-white/10 text-ink dark:text-white font-mono text-xs font-medium transition-colors"
              >
                Colar
              </button>
              <button
                type="button"
                onClick={handleClear}
                className="flex-1 sm:flex-none px-4 py-3 rounded-md bg-ink/5 dark:bg-white/5 hover:bg-ink/10 dark:hover:bg-white/10 text-ink dark:text-white font-mono text-xs font-medium transition-colors"
              >
                Limpar
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
            <button type="submit" disabled={status === STATUS.LOADING || !url.trim()} className="w-full py-3 rounded-md bg-accent hover:bg-accent-bright dark:bg-accent-bright dark:hover:bg-accent text-white font-mono text-sm font-medium transition-colors disabled:opacity-50 whitespace-nowrap">
              {status === STATUS.LOADING ? 'extraindo…' : 'Extrair conteúdo'}
            </button>
            <button type="button" onClick={handleExtractImages} disabled={status === STATUS.LOADING || !url.trim()} className="w-full py-3 rounded-md border border-accent/40 dark:border-accent-bright/40 text-accent dark:text-accent-bright font-mono text-sm font-medium hover:bg-accent/5 dark:hover:bg-accent-bright/5 transition-colors disabled:opacity-50 whitespace-nowrap">
              Extrair imagens
            </button>
          </div>
        </form>
        {status === STATUS.LOADING && (
          <div className="font-mono text-xs text-ink-soft dark:text-white/50 animate-pulse">
            analisando estrutura, convertendo blocos de texto...
          </div>
        )}
        {status === STATUS.ERROR && (
          <div className="font-mono text-sm text-red-600 dark:text-red-400 border border-red-600/20 dark:border-red-400/20 rounded-md px-4 py-3">
            <strong className="block mb-1">Falha na extração:</strong>
            {errorMessage}
          </div>
        )}
        {status === STATUS.DONE && article && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4 font-mono text-xs text-ink-soft dark:text-white/50">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={showImages} onChange={(e) => setShowImages(e.target.checked)} className="accent-accent dark:accent-accent-bright" />
                mostrar imagens no texto
              </label>
              <span>{article.images?.length || 0} imagens · {article.readingTimeMinutes} min de leitura</span>
            </div>
            <ReaderView article={article} showImages={showImages} />
            <button type="button" onClick={() => setShowImageGallery((value) => !value)} className="mt-7 w-full py-3 rounded-md font-mono text-xs font-semibold tracking-wide border border-accent/30 dark:border-accent-bright/30 text-accent dark:text-accent-bright hover:bg-accent/5 dark:hover:bg-accent-bright/5 transition-colors">
              {showImageGallery ? 'OCULTAR IMAGENS EXTRAÍDAS' : `VER IMAGENS EXTRAÍDAS (${article.images?.length || 0})`}
            </button>
            {showImageGallery && <ImageGallery images={article.images || []} />}
            <button
              onClick={handleCopyAll}
              className="mt-10 w-full py-3 rounded-md font-mono text-xs font-semibold tracking-wide border border-ink/20 dark:border-white/20 hover:bg-ink hover:text-paper dark:hover:bg-white dark:hover:text-ink transition-colors"
            >
              {copied ? 'COPIADO ✓' : 'COPIAR TUDO'}
            </button>
          </>
        )}
      </main>
    </div>
  )
}
