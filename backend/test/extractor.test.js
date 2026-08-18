import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extractArticleFromHtml } from '../src/extractor.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name) => readFile(path.join(here, 'fixtures', name), 'utf8')

test('extrai uma matéria HTML em blocos legíveis', async () => {
  const html = await fixture('article.html')
  const result = extractArticleFromHtml(html, 'https://example.com/noticia')

  assert.match(result.title, /Matéria de teste/)
  assert.ok(result.content.some((block) => block.type === 'paragraph'))
  assert.ok(result.wordCount > 20)
  assert.ok(result.readingTimeMinutes >= 1)
})

test('prioriza JSON-LD de Product e normaliza os dados do e-commerce', async () => {
  const html = await fixture('product.html')
  const result = extractArticleFromHtml(html, 'https://loja.example.com/produtos/notebook')

  assert.equal(result.type, 'product')
  assert.equal(result.title, 'Notebook Exemplo 16GB 512GB')
  assert.equal(result.product.price, '3499.90')
  assert.equal(result.product.currency, 'BRL')
  assert.equal(result.product.availability, 'Em estoque')
  assert.equal(result.product.brand, 'Marca Teste')
  assert.equal(result.product.rating, '4.8')
  assert.ok(result.images[0].src.startsWith('https://loja.example.com/'))
  assert.ok(result.content.some((block) => block.type === 'list' && block.items.some((item) => item.includes('Preço: R$ 3499.90'))))
})
