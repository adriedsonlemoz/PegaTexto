import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanText,
  getWordCount,
  isCloudFirstDomain,
  looksLikeChallenge,
  normalizeHttpUrl,
  readingTimeMinutes,
  scoreContentQuality,
} from '../src/lib/extractionCore.js'

test('normaliza URLs http/https e rejeita protocolos inseguros', () => {
  assert.equal(normalizeHttpUrl('https://example.com/teste'), 'https://example.com/teste')
  assert.throws(() => normalizeHttpUrl('file:///tmp/teste'), /URL_INVALIDA/)
  assert.throws(() => normalizeHttpUrl('https://user:pass@example.com'), /URL_INVALIDA/)
})

test('detecta domínios que preferem extração alternativa', () => {
  assert.equal(isCloudFirstDomain('https://www.amazon.com.br/produto'), true)
  assert.equal(isCloudFirstDomain('https://produto.mercadolivre.com.br/item'), true)
  assert.equal(isCloudFirstDomain('https://example.com/noticia'), false)
})

test('detecta páginas de desafio/bloqueio', () => {
  assert.equal(looksLikeChallenge('<title>Just a moment...</title>'), true)
  assert.equal(looksLikeChallenge('<h1>Conteúdo normal</h1>'), false)
})

test('conta palavras de blocos de texto e listas', () => {
  const blocks = [
    { type: 'heading', text: 'Título simples' },
    { type: 'paragraph', text: 'Um texto de teste.' },
    { type: 'list', items: ['item um', 'item dois'] },
    { type: 'image', src: 'https://example.com/x.png' },
  ]
  assert.equal(getWordCount(blocks), 10)
  assert.equal(readingTimeMinutes(10), 1)
  assert.equal(readingTimeMinutes(450), 2)
  assert.equal(cleanText('  um   texto\nlimpo  '), 'um texto limpo')
})


test('avalia a qualidade de artigos para decidir fallback', () => {
  const result = scoreContentQuality({ title: 'Matéria completa', byline: 'Autor', content: [
    { type: 'heading', text: 'Subtítulo' },
    { type: 'paragraph', text: 'Este é um parágrafo suficientemente longo para representar conteúdo real e legível de uma matéria.' },
    { type: 'paragraph', text: 'Outro parágrafo com informações adicionais para melhorar a avaliação automática da extração.' },
    { type: 'paragraph', text: 'Terceiro parágrafo com contexto, detalhes e uma estrutura de leitura adequada para o usuário.' },
  ], images: [{ src: 'https://example.com/a.jpg' }] })
  assert.ok(result.score >= 45)
  assert.notEqual(result.level, 'partial')
})
