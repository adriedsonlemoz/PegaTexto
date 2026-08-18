import dns from 'node:dns/promises'
import net from 'node:net'

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
])

export async function assertPublicHttpUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('URL_INVALIDA')
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('URL_INVALIDA')
  if (parsed.username || parsed.password) throw new Error('URL_INVALIDA')

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new Error('URL_BLOQUEADA')
  }

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('URL_BLOQUEADA')
    return parsed.toString()
  }

  let addresses
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new Error('HOST_INACESSIVEL')
  }

  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('URL_BLOQUEADA')
  }

  return parsed.toString()
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) return isPrivateIpv4(address)
  if (net.isIPv6(address)) return isPrivateIpv6(address)
  return true
}

function isPrivateIpv4(address) {
  const [a, b] = address.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase()
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (/^fe[89ab]/.test(normalized)) return true

  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return mapped ? isPrivateIpv4(mapped[1]) : false
}
