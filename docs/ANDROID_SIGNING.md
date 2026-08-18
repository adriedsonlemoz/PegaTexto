# Assinatura do Android no GitHub Actions

O workflow `.github/workflows/android-release.yml` gera:

- `app-release.apk` assinado;
- `app-release.aab` assinado para publicação;
- checksums SHA-256 dos dois arquivos.

A chave **não deve ser enviada ao repositório**. O projeto já ignora arquivos `*.jks` e `*.keystore`.

## 1. Criar uma chave de release

Em um computador com JDK instalado:

```bash
keytool -genkeypair -v \
  -keystore pega-texto-release.jks \
  -alias pega-texto \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000
```

Guarde a chave e as senhas em local seguro. A mesma chave deve ser preservada para futuras atualizações do aplicativo distribuído fora do Play App Signing.

## 2. Converter a chave para Base64

Linux:

```bash
base64 -w 0 pega-texto-release.jks > keystore.base64.txt
```

macOS:

```bash
base64 < pega-texto-release.jks | tr -d '\n' > keystore.base64.txt
```

PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("pega-texto-release.jks")) | Set-Content -NoNewline keystore.base64.txt
```

## 3. Criar os GitHub Secrets

No repositório, abra **Settings → Secrets and variables → Actions** e crie:

- `ANDROID_KEYSTORE_BASE64`: conteúdo de `keystore.base64.txt`;
- `ANDROID_KEYSTORE_PASSWORD`: senha do arquivo `.jks`;
- `ANDROID_KEY_ALIAS`: alias escolhido, por exemplo `pega-texto`;
- `ANDROID_KEY_PASSWORD`: senha da chave/alias.

## 4. Gerar o release

Você pode usar **Actions → Android Signed Release → Run workflow**.

Outra opção é criar uma tag:

```bash
git tag v1.2.1
git push origin v1.2.1
```

No fim da execução, o artifact `pega-texto-signed-release` conterá APK, AAB e checksums.

## Versão Android

O script `frontend/scripts/apply-android-customizations.mjs` lê a versão do `frontend/package.json` e aplica automaticamente:

- `versionName`: por exemplo `1.2.1`;
- `versionCode`: por exemplo `10201`.

Isso evita esquecer de atualizar a versão nativa depois de alterar a versão do frontend.
