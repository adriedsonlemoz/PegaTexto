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
  assert.ok(result.images.some((image) => image.src === 'https://example.com/images/capa.jpg'))
  assert.ok(result.images.some((image) => image.src === 'https://example.com/images/foto-1280.jpg'))
  assert.ok(result.images.some((image) => image.src === 'https://example.com/images/foto-lazy.jpg'))
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

test('aplica filtro específico da Shopee e remove o título genérico', async () => {
  const html = await fixture('shopee-product.html')
  const result = extractArticleFromHtml(html, 'https://shopee.com.br/product/1248938331/19799123456')
  assert.equal(result.type, 'product')
  assert.equal(result.product.site, 'shopee')
  assert.match(result.title, /Tela Touch Display LCD/)
  assert.equal(result.product.price, '89,90')
  assert.equal(result.product.seller, 'Loja das Telas')
  assert.ok(result.product.variations.some((group) => group.options.includes('Sem aro')))
  assert.ok(result.product.images.every((src) => !src.includes('logo-shopee')))
  assert.ok(result.quality.score >= 50)
})

test('estrutura produto do Mercado Livre', async () => {
  const html = await fixture('ml-product.html')
  const result = extractArticleFromHtml(html, 'https://produto.mercadolivre.com.br/MLB-123456-smartphone')
  assert.equal(result.type, 'product')
  assert.equal(result.product.site, 'mercadolivre')
  assert.match(result.title, /Smartphone Exemplo/)
  assert.equal(result.product.price, '1.499,90')
  assert.match(result.product.shipping, /Frete grátis/i)
})

test('estrutura produto da Amazon', async () => {
  const html = await fixture('amazon-product.html')
  const result = extractArticleFromHtml(html, 'https://www.amazon.com.br/dp/B0ABC12345')
  assert.equal(result.type, 'product')
  assert.equal(result.product.site, 'amazon')
  assert.match(result.title, /Fone de Ouvido Bluetooth/)
  assert.equal(result.product.price, '199,90')
  assert.equal(result.product.rating, '4.7')
})
