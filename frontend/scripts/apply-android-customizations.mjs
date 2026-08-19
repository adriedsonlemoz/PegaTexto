import { access, cp, readFile, rm, writeFile } from 'node:fs/promises'
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

// O template do Capacitor cria recursos padrão com os mesmos nomes lógicos
// usados pelo branding. Android considera splash.png + splash.xml no mesmo
// diretório como o mesmo recurso @drawable/splash, e o mesmo vale para a cor
// ic_launcher_background declarada em dois XMLs. Removemos apenas os padrões
// conflitantes antes de copiar a identidade visual do app.
await removeGeneratedResourceConflicts()
await cp(brandingSource, brandingTarget, { recursive: true, force: true })
await validateBrandingResources()

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
console.log(`Android personalizado: recursos sem duplicação, ícone aprovado/splash aplicados, versão ${versionName} (${versionCode}).`)

async function removeGeneratedResourceConflicts() {
  const conflictingFiles = [
    path.join(brandingTarget, 'drawable', 'splash.png'),
    path.join(brandingTarget, 'drawable', 'splash.webp'),
    path.join(brandingTarget, 'drawable', 'splash.jpg'),
    path.join(brandingTarget, 'drawable', 'splash.jpeg'),
    path.join(brandingTarget, 'values', 'ic_launcher_background.xml'),
    path.join(brandingTarget, 'mipmap-anydpi-v26', 'ic_launcher.xml'),
    path.join(brandingTarget, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'),
  ]

  await Promise.all(conflictingFiles.map((file) => rm(file, { force: true })))
}

async function validateBrandingResources() {
  const splashXml = path.join(brandingTarget, 'drawable', 'splash.xml')
  const splashAlternatives = ['png', 'webp', 'jpg', 'jpeg'].map((extension) =>
    path.join(brandingTarget, 'drawable', `splash.${extension}`),
  )

  await access(splashXml)

  for (const file of splashAlternatives) {
    try {
      await access(file)
      throw new Error(`Recurso Android duplicado detectado: ${path.basename(splashXml)} e ${path.basename(file)}`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  const launcherSizes = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']
  for (const density of launcherSizes) {
    await access(path.join(brandingTarget, `mipmap-${density}`, 'ic_launcher.png'))
    await access(path.join(brandingTarget, `mipmap-${density}`, 'ic_launcher_round.png'))
  }

  for (const adaptiveName of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    const adaptivePath = path.join(brandingTarget, 'mipmap-anydpi-v26', adaptiveName)
    try {
      await access(adaptivePath)
      throw new Error(`Adaptive icon antigo ainda ativo: ${adaptiveName}`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  const legacyLauncherColor = path.join(brandingTarget, 'values', 'ic_launcher_background.xml')
  try {
    await access(legacyLauncherColor)
    throw new Error('Recurso Android duplicado detectado: ic_launcher_background ainda existe em arquivo separado.')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function versionToCode(version) {
  const [major = 0, minor = 0, patch = 0] = String(version)
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0)
  return Math.max(1, major * 10000 + minor * 100 + patch)
}
