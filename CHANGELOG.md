# Changelog

## 1.3.0

- adiciona classificador automático de página: **Produto**, **Artigo** ou **Página**;
- adiciona filtro específico da **Shopee**, rejeitando cabeçalhos, menus, categorias, recomendações e textos institucionais como conteúdo do produto;
- adiciona extratores específicos para **Mercado Livre** e **Amazon**;
- estrutura produtos em título, preço, preço anterior, desconto, avaliação, vendas, vendedor, entrega, estoque, marca, SKU, opções, características e descrição;
- cria uma tela exclusiva para produtos, sem usar o leitor de artigos;
- reorganiza imagens do produto em galeria principal com miniaturas e separa imagens extras da página;
- adiciona ranking de imagens por domínio/CDN e remove logos, ícones, banners e pixels de rastreamento da galeria principal;
- adiciona sistema de qualidade da extração com nota, nível e avisos;
- quando a primeira estratégia produz resultado fraco, tenta a segunda estratégia (direta/Jina) e mantém o melhor resultado;
- melhora o botão de cópia para produtos, copiando dados estruturados em vez de texto bruto da página;
- amplia testes do frontend para classificação, limpeza, preço e qualidade e adiciona fixtures de Shopee, Mercado Livre e Amazon ao backend.

## 1.2.3

- integra no APK o ícone quadrado arredondado aprovado, sem gerar uma nova arte;
- usa o mesmo PNG aprovado em todas as densidades Android e remove o adaptive icon antigo para evitar divergência no launcher;
- adiciona o botão **Extrair imagens**;
- coleta imagens da página completa por `src`, lazy-load, `srcset`, `picture/source`, Open Graph e Twitter Card;
- adiciona galeria com abertura da imagem original e cópia individual ou em lote dos links;
- elimina URLs duplicadas, protocolos não públicos e pixels de rastreamento óbvios;
- adiciona testes para Open Graph, lazy-load e `srcset`.

## 1.2.2

- Corrige falha `:app:mergeDebugResources` causada por recursos Android duplicados no branding.
- Remove o `splash.png` padrão antes de aplicar `splash.xml` personalizado.
- Remove a definição padrão duplicada de `ic_launcher_background` antes de aplicar as cores do app.
- Adiciona validação preventiva de conflitos de recursos antes do Gradle.
- Atualiza as actions do GitHub para runtimes Node 24 atuais.

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
