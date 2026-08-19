import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyPage,
  cleanProductDescription,
  detectSite,
  isLikelyProductUrl,
  normalizeProductPrice,
  pickBestProductTitle,
  scoreProductQuality,
} from '../src/lib/pageIntelligence.js'

test('detecta Shopee, Mercado Livre e Amazon por domínio e URL de produto', () => {
  assert.equal(detectSite('https://shopee.com.br/product/123/456').id, 'shopee')
  assert.equal(detectSite('https://produto.mercadolivre.com.br/MLB-123456-item').id, 'mercadolivre')
  assert.equal(detectSite('https://www.amazon.com.br/dp/B0ABC12345').id, 'amazon')
  assert.equal(isLikelyProductUrl('https://shopee.com.br/product/123/456'), true)
  assert.equal(isLikelyProductUrl('https://www.amazon.com.br/dp/B0ABC12345'), true)
})

test('classifica produto antes de artigo quando há URL e sinais comerciais', () => {
  const result = classifyPage({ url: 'https://shopee.com.br/product/123/456', title: 'Tela LCD Compatível Redmi 13C', price: 'R$ 89,90', articleTextLength: 4000 })
  assert.equal(result.type, 'product')
})

test('escolhe título do produto e rejeita cabeçalho genérico da Shopee', () => {
  const title = pickBestProductTitle([
    'Shopee Brasil | Ofertas incríveis. Melhores preços do mercado',
    'Central do Vendedor Vender na Shopee',
    'Tela Touch Display LCD Compatível Xiaomi Redmi 13C Sem Aro A Pronta Entrega',
  ])
  assert.match(title, /Tela Touch Display LCD/)
})

test('normaliza preço e pontua qualidade da extração', () => {
  assert.equal(normalizeProductPrice('R$ 1.299,90'), '1.299,90')
  assert.equal(normalizeProductPrice('R$ 1.499'), '1.499')
  const quality = scoreProductQuality({ name: 'Produto Teste Completo', price: '99,90', description: 'Descrição completa com informações suficientes para o produto.', images: ['https://cdn.example/x.jpg'], seller: 'Loja', rating: '4.8', variations: [{ name: 'Cor', options: ['Azul', 'Preto'] }], attributes: [{ name: 'Marca', value: 'Teste' }] }, { siteSpecific: true })
  assert.ok(quality.score >= 75)
  assert.equal(quality.level, 'high')
})

test('limpa navegação conhecida da descrição', () => {
  const value = cleanProductDescription('Descrição do item\nAjuda\nMaterial resistente\nBaixe o App\nCompatível com Redmi 13C')
  assert.doesNotMatch(value, /Ajuda|Baixe o App/)
  assert.match(value, /Material resistente/)
})
