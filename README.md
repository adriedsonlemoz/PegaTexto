# Pega Texto

Ferramenta para extrair o conteúdo principal de matérias, páginas e produtos, removendo menus, anúncios e outros ruídos. A interface usa **React + Vite** e pode ser executada no navegador ou como aplicativo Android com **Capacitor**.

Versão atual: **1.3.0**.

## Como funciona

- **Web:** o frontend usa o backend Express em `/api` ou em `VITE_API_URL`.
- **Android/APK:** o aplicativo usa HTTP nativo do Capacitor e processa o conteúdo diretamente no aparelho; o backend não é obrigatório.
- **Classificação automática:** cada URL é tratada como **Produto**, **Artigo** ou **Página** antes da apresentação final.
- **Artigos:** Mozilla Readability identifica o conteúdo principal.
- **Produtos:** a extração prioriza Schema.org/JSON-LD, Open Graph e depois filtros específicos por site.
- **Shopee:** filtra navegação, categorias, recomendações e cabeçalhos genéricos, buscando os dados do produto.
- **Mercado Livre e Amazon:** possuem extratores próprios para os campos mais relevantes do produto.
- **Qualidade/fallback:** cada resultado recebe uma nota. Resultados fracos fazem o app tentar a segunda estratégia de extração e escolher a melhor.
- **Páginas difíceis:** há fallback via `r.jina.ai` para páginas dinâmicas ou bloqueadas para leitura direta.

## Estrutura

```text
pegatexto-main/
├── backend/
│   ├── src/
│   └── test/
├── frontend/
│   ├── android-branding/      # recursos nativos aplicados após cap sync
│   ├── resources/             # fontes do ícone e splash
│   ├── scripts/
│   ├── src/
│   └── test/
├── docs/
│   └── ANDROID_SIGNING.md
└── .github/workflows/
    ├── quality.yml
    ├── android-apk.yml
    └── android-release.yml
```

## Rodar no navegador

Backend:

```bash
cd backend
npm install
npm run dev
```

Frontend, em outro terminal:

```bash
cd frontend
npm install
npm run dev
```

O Vite encaminha `/api` para `http://localhost:4000` durante o desenvolvimento.

## Testes

Frontend:

```bash
cd frontend
npm test
```

Backend:

```bash
cd backend
npm test
```

O workflow **Quality checks** executa os testes e também valida o build do frontend a cada push/pull request para `main`.

## Android com Capacitor

Requisitos locais: Node.js 22+, JDK/Java e Android SDK com API 36.

Primeira criação do projeto Android:

```bash
cd frontend
npm install
npm run build
npm run android:add
npm run android:sync
npm run android:open
```

`android:sync` agora também aplica automaticamente o ícone, splash, versão nativa e o hook de assinatura.

### APK debug local

Depois que `frontend/android` já existir:

```bash
cd frontend
npm run android:apk
```

Saída:

```text
frontend/android/app/build/outputs/apk/debug/app-debug.apk
```

## APK debug pelo GitHub

O workflow **Android APK**:

1. instala as dependências;
2. executa os testes do frontend;
3. gera o build Vite;
4. cria/sincroniza o projeto Capacitor Android;
5. aplica ícone e splash;
6. gera `app-debug.apk`;
7. publica o artifact `pega-texto-debug-apk`.

## Release assinado

O workflow **Android Signed Release** gera **APK e AAB assinados**. Ele não armazena a chave no repositório e lê tudo pelos GitHub Secrets.

Consulte [docs/ANDROID_SIGNING.md](docs/ANDROID_SIGNING.md) para criar a chave e configurar:

- `ANDROID_KEYSTORE_BASE64`;
- `ANDROID_KEYSTORE_PASSWORD`;
- `ANDROID_KEY_ALIAS`;
- `ANDROID_KEY_PASSWORD`.

O workflow pode ser executado manualmente ou por tags `v*`, como `v1.3.0`.

## Branding Android

Os recursos ficam em `frontend/android-branding`. O script:

```bash
npm run android:brand
```

copia esses recursos para o projeto Android gerado e sincroniza a versão do `package.json` com `versionName`/`versionCode`.

## Publicar a versão web

Se frontend e backend forem publicados separadamente, copie `frontend/.env.example` para `.env` e defina:

```env
VITE_API_URL=https://seu-backend.exemplo.com/api
```

No APK essa variável não é necessária para a extração normal.

## Segurança

A API rejeita URLs inválidas, credenciais embutidas, localhost, IPs privados e redirecionamentos para destinos privados antes de fazer requisições. Também limita o tamanho das páginas processadas para reduzir abuso e consumo excessivo de memória.


## Extração de imagens

O botão **Extrair imagens** procura imagens no HTML completo, incluindo `src`, atributos de lazy-load, `srcset`, `picture/source`, Open Graph e Twitter Card. Os resultados aparecem em uma galeria separada com opção de abrir o original, copiar um link ou copiar todos os links.

O launcher Android usa diretamente o ícone quadrado arredondado aprovado em `frontend/resources/icon.png`, convertido para todas as densidades `mipmap-*`.

## Modo produto

Quando uma URL é identificada como produto, o app não usa a tela de leitura de artigos. Ele mostra:

- galeria principal com miniaturas;
- preço atual, preço anterior e desconto quando disponíveis;
- avaliação, quantidade de avaliações e vendidos;
- vendedor, entrega e disponibilidade;
- opções/variações;
- descrição limpa;
- características técnicas;
- nota de qualidade da extração.

As imagens principais são separadas das imagens extras da página. Logos, ícones, banners, avatares e pixels de rastreamento são descartados da galeria do produto.

## Pipeline de extração

```text
URL
  ↓
detectar site
  ↓
classificar Produto / Artigo / Página
  ↓
extrator específico (Shopee / Mercado Livre / Amazon)
  ↓
metadados estruturados e heurísticas genéricas
  ↓
limpeza + ranking de imagens
  ↓
nota de qualidade
  ↓
resultado bom → exibir
resultado fraco → tentar fallback e escolher o melhor
```
