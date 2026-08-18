import { cp, readFile, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.resolve(here, '..')
const androidDir = path.join(frontendDir, 'android')
const appDir = path.join(androidDir, 'app')
const buildGradle = path.join(appDir, 'build.gradle')
const brandingSource = path.join(frontendDir, 'android-branding')
const brandingTarget = path.join(appDir, 'src', 'main', 'res')
const packageJson = JSON.parse(await readFile(path.join(frontendDir, 'package.json'), 'utf8'))

try {
  await access(buildGradle)
} catch {
  throw new Error('Projeto Android não encontrado. Rode `npx cap add android` antes de aplicar a personalização.')
}

await cp(brandingSource, brandingTarget, { recursive: true, force: true })

let gradle = await readFile(buildGradle, 'utf8')
const versionName = packageJson.version || '1.0.0'
const versionCode = versionToCode(versionName)

gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
gradle = gradle.replace(/versionName\s+["'][^"']+["']/, `versionName "${versionName}"`)

const signingApply = "apply from: '../../android-signing.gradle'"
if (!gradle.includes(signingApply)) {
  gradle = `${gradle.trimEnd()}\n${signingApply}\n`
}

await writeFile(buildGradle, gradle)
console.log(`Android personalizado: ícone/splash aplicados, versão ${versionName} (${versionCode}).`)

function versionToCode(version) {
  const [major = 0, minor = 0, patch = 0] = String(version)
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0)
  return Math.max(1, major * 10000 + minor * 100 + patch)
}
