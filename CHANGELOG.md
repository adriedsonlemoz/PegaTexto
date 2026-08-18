# Changelog

## 1.2.1

- corrige o carregamento da configuração do Capacitor 8 em projeto ESM;
- troca `capacitor.config.js` por `capacitor.config.json` para o CLI enxergar `appId`, `appName` e `webDir` corretamente;
- adiciona validação explícita da configuração nos workflows Android antes de `npx cap add android`;
- corrige o erro `Missing appId for new platform` observado no GitHub Actions.

## 1.2.0

- adiciona testes automatizados do frontend e backend;
- adiciona CI de qualidade no GitHub Actions;
- melhora detecção de páginas de produto com JSON-LD/Schema.org, Open Graph e seletores genéricos;
- normaliza preço, moeda, estoque, marca, vendedor, avaliação, SKU e imagens de produtos;
- adiciona visual específico para produtos detectados;
- melhora fallback entre HTTP direto e extração alternativa no Android e backend;
- adiciona ícone próprio e splash screen do Pega Texto;
- automatiza aplicação do branding após `cap sync`;
- sincroniza `versionName` e `versionCode` com `frontend/package.json`;
- adiciona workflow de APK/AAB release assinados com GitHub Secrets;
- adiciona checksums SHA-256 dos releases.
