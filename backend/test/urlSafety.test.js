import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPublicHttpUrl } from '../src/urlSafety.js'

test('bloqueia localhost e endereços IPv4 privados', async () => {
  await assert.rejects(() => assertPublicHttpUrl('http://localhost/teste'), /URL_BLOQUEADA/)
  await assert.rejects(() => assertPublicHttpUrl('http://127.0.0.1/teste'), /URL_BLOQUEADA/)
  await assert.rejects(() => assertPublicHttpUrl('http://192.168.1.10/teste'), /URL_BLOQUEADA/)
  await assert.rejects(() => assertPublicHttpUrl('http://10.0.0.2/teste'), /URL_BLOQUEADA/)
})

test('rejeita protocolos e credenciais embutidas', async () => {
  await assert.rejects(() => assertPublicHttpUrl('file:///etc/passwd'), /URL_INVALIDA/)
  await assert.rejects(() => assertPublicHttpUrl('https://user:pass@example.com'), /URL_INVALIDA/)
})
