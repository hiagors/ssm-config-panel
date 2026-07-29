# Spec — Editor de Parameter Store (Astro + React, execução nativa)

## Contexto e objetivo

Ferramenta web **local** (uso individual, roda na minha máquina) para **visualizar, validar e editar parâmetros JSON no AWS SSM Parameter Store**.

O problema que ela resolve: hoje edito variáveis de ambiente de vários sistemas direto no console da AWS, colando JSON cru. É fácil quebrar o formato, difícil revisar o que mudou e não existe validação. Quero uma UI parecida com a tela de "environment variables" de um repositório (lista de chave-valor), com suporte a valores aninhados.

Documentação em **português**; nomes de variáveis, funções, arquivos e commits em **inglês**.

**Fato observado, que vale como premissa de desenho:** meus parâmetros reais são **JSON minificado, em linha única** (o limite de 4 KB do tier Standard empurra para isso). Toda decisão de diff e de visualização precisa funcionar bem nesse formato — não no JSON indentado de exemplo.

## Stack obrigatória

- **Astro** com `output: 'server'` e adapter `@astrojs/node` (precisa de servidor: todas as chamadas AWS acontecem no backend).
- **React** via `@astrojs/react`, usado apenas nas ilhas interativas (editor, formulários). Páginas estáticas continuam `.astro`.
- **TypeScript** em modo `strict`.
- **Runtime gerenciado por `mise`**, não instalado globalmente: `mise.toml` na raiz pinando **Node** e o **AWS CLI v2** pelo backend explícito `"aqua:aws/aws-cli"`. Backend explícito em vez de short-name porque não depende de alias do registry. `npm` como gerenciador de pacotes.
- Ambiente: **macOS / Apple Silicon (arm64)**.
- Testes: **Vitest** para unidade. Playwright apenas se necessário para o fluxo crítico.

## Arquitetura

Sistema simples, mas com separação explícita. MVC no nível da aplicação, com a camada de acesso ao store isolada por **Ports & Adapters**:

```
src/
  middleware.ts     # guardas transversais (ver Restrições de segurança)
  pages/            # rotas Astro (views) + /api/* (controllers HTTP)
  components/       # ilhas React
  application/      # use cases (get, validate, diff, save)
  domain/           # modelo do parâmetro, modelo do documento JSON, validação
  infrastructure/
    store/
      ParameterStorePort.ts        # interface
      AwsSsmStoreAdapter.ts        # produção
      LocalFileStoreAdapter.ts     # dev/offline
    auth/
      SsoAuthPort.ts
      AwsSsoAdapter.ts
```

**`ParameterStorePort`** expõe `list()`, `get(name)`, `put(name, value, options)`, `history(name)` — sem nenhum tipo do SDK da AWS vazando para `application/` ou `domain/`.

- `get()` devolve a `version` corrente.
- `PutOptions` inclui `expectedVersion: number`. Os dois adapters exigem que o parâmetro **exista** e esteja **nessa versão**. Verificar só no use case bastaria para o comportamento, mas colocar no port torna "nunca criar por efeito colateral" e "nunca sobrescrever às cegas" estruturais nos dois drivers.

Dois adapters:

1. **`AwsSsmStoreAdapter`** — SSM real.
2. **`LocalFileStoreAdapter`** — grava os mesmos parâmetros como arquivos JSON em `./.local-store/`, **espelhando exatamente o formato do SSM** (um arquivo por parameter name, conteúdo = o JSON do valor; metadados em sidecar). Sem achatamento para `.env`. Simula versionamento por contador, para que a proteção contra escrita concorrente seja testável sem AWS.

A escolha do adapter vem de variável de ambiente (`STORE_DRIVER=aws|local`), resolvida em um único *composition root*.

## Autenticação (AWS SSO)

O app roda nativamente na minha máquina, então o navegador local está disponível — aproveite isso e mantenha o fluxo simples.

1. A tela inicial lista os profiles disponíveis lidos de `~/.aws/config`, em um seletor. Para cada profile, exibir conta, role e o estado da sessão (válida / expirada / nunca autenticada). Se `AWS_PROFILE` estiver definido, pré-selecionar esse profile.

   Para ler os profiles, use `loadSharedConfigFiles()` do pacote `@aws-sdk/shared-ini-file-loader` — não implemente parsing de INI manualmente. Ele resolve tanto o formato legado (`sso_start_url` e `sso_region` inline no profile) quanto o formato novo com blocos `[sso-session]` referenciados por `sso_session`, além de respeitar `AWS_CONFIG_FILE`. Ambos os formatos precisam funcionar — os meus usam só o novo, então cubra o legado com fixture de teste.

2. **Profiles sem SSO devem ser distinguidos.** `loadSharedConfigFiles()` lê também `~/.aws/credentials`, e eu tenho ali chaves estáticas num `[default]`. O seletor não pode apresentá-las como equivalentes a um profile SSO: bloqueie ou marque com destaque visível. Selecionar por engano um profile de credencial estática e editar produção sob uma identidade esquecida é erro sem sinal.
3. Autenticar dispara `aws sso login --profile <selecionado>` no backend, que abre o navegador padrão. A UI faz polling até a sessão ficar válida.
4. Credenciais são obtidas via **`fromSSO()` explícito** do `@aws-sdk/credential-providers` — nunca pela cadeia default, que poderia silenciosamente pegar as chaves estáticas do item 2.
5. Toda operação é sempre no contexto do profile selecionado, passado explicitamente por request. Trocar de profile **descarta a edição em andamento** — mas exige **confirmação explícita** quando existe rascunho não salvo. Nunca descarte silenciosamente.
6. **Expiração de token é estado de primeira classe**, não erro. O rascunho vive no estado do React da página aberta, então expirar não deve custar nada: detectar, avisar em banner não-bloqueante, oferecer reautenticar (mesmo fluxo do item 3, sem recarregar a página) e retomar exatamente de onde parou, incluindo o diff pendente.

## Restrições de segurança

- Nenhuma chave de acesso estática hardcoded ou em arquivo versionado.
- O servidor faz bind em `127.0.0.1`, não em `0.0.0.0`.
- **Tokens e credenciais nunca saem do backend.**
- **Valores de parâmetro, incluindo `SecureString` decriptado, podem trafegar para o browser** — é uma ferramenta local, servida em loopback, e sem isso a edição estruturada é impossível. Em contrapartida:
  - `Type` é propriedade do parâmetro inteiro, não das chaves internas. Se `Type === 'SecureString'`, **todos** os valores do JSON entram mascarados, com "revelar tudo" global e revelar individual por linha. Não tente adivinhar por nome de chave o que é ou não segredo. **Chaves não são mascaradas**, só valores — sem os nomes não se navega o formulário.
  - O estado de revelação **nunca persiste**: nem em `localStorage`, nem em cookie, nem em URL. Recarregar a página volta tudo a mascarado.
  - **Nunca** aparecem em log de servidor, log de browser, mensagem de erro ou stack trace.
  - **Nunca** são persistidos em disco fora de `./.backups/` e de `./.local-store/` (que é o próprio store no driver local). Em particular, não escreva rascunho em `localStorage` nem em arquivo temporário.
- Os arquivos de `./.backups/` e `./.local-store/` contêm segredos em texto claro: devem entrar no `.gitignore` e ser criados com permissão `0600` (diretórios `0700`). Documente isso no README.
- Inputs de valor usam `autocomplete="off"`, `data-1p-ignore` e `data-lpignore` para não acionar gerenciador de senhas. Um único componente de input concentra isso, com teste assertando os três atributos.
- **Sessão do Astro desabilitada explicitamente na config.** O adapter node habilita sessão com storage em filesystem por padrão, o que conflita com "rascunho nunca em disco". Desligue na configuração — não basta evitar o uso, porque disciplina apodrece. Se algum dia for preciso, que exija decisão consciente.

### Guardas transversais: estruturais, não disciplina

Regras que dependem de lembrar em cada rota apodrecem. Implemente cada uma em **um único ponto** e cubra com teste:

- **`Cache-Control: no-store` em toda resposta — página e API.** Um helper de JSON cobrindo só `/api/*` é insuficiente: a página do editor renderiza o valor no HTML (no SSR e nos props da ilha) e seria cacheável. O ponto único é `src/middleware.ts`; o helper de JSON continua existindo para o corpo, mas o middleware é o que impede uma rota nova de esquecer.
- **Valor de parâmetro nunca entra em objeto de erro nem é serializado em exceção.** Error mapper central que **redige por padrão**, em allow-list: só uma mensagem pública curada atravessa; qualquer outro erro vira genérico. Vale para a resposta e para o log. Isso importa porque a página de erro do Astro em dev expõe contexto da requisição, e uma exceção não tratada vazaria o valor decriptado em HTML. Inclua uma página de erro própria (`500.astro`) para não cair na overlay do Astro.
- **Proteção contra CSRF em toda rota mutante.** O app escuta em `127.0.0.1`, e **qualquer site aberto no meu navegador pode disparar requisições para lá**. Em GET a same-origin policy protege — a página dispara mas não lê a resposta. **Em escrita, não protege nada**: uma aba maliciosa poderia gravar num parâmetro de produção e, como o profile vai por request, escolher em qual conta. Portanto:
  - `security.checkOrigin` ligado no `astro.config.mjs` (valida `Origin` em requisições não-GET).
  - Validação do header `Host` contra allow-list (`127.0.0.1:<porta>`, `localhost:<porta>`), contra DNS rebinding.
  - Toda rota não-GET passa pela **mesma verificação central** no middleware. Nenhuma rota implementa a checagem por conta própria.
  - Isso nasce **junto com o primeiro PUT**, nunca depois.
- Teste obrigatório para cada guarda: valor sentinela que não sobrevive a nenhum caminho de erro; requisição não-GET com `Origin` estranho rejeitada; resposta de página com `no-store`.

## Modelo do documento JSON

`JSON.parse` **não serve** como modelo do editor, e isso não é preferência de estilo — ele perde três coisas que o spec exige:

- `{"timeout": 30.0}` volta como `30` e serializa como `"30"`, quebrando "round-trip sem alterações produz diff vazio" num campo que ninguém tocou.
- `{"2":"b","1":"a"}` tem as chaves reordenadas, porque chave que parece inteiro é reordenada pela semântica de objeto do JS — quebra "preservar a ordem original".
- `{"a":1,"a":2}` colapsa silenciosamente, tornando indetectável a validação de chave duplicada que o spec pede.

Então: **modelo de documento próprio, com parser de descida recursiva**.

- Número guarda o **lexema original** como string (`"30.0"`, `"1e5"`, `"1.50"` preservados).
- Objeto guarda **lista ordenada** de entradas, permitindo duplicata; cada entrada tem `id` estável, para renomear e reordenar sem o React remontar o campo e perder foco.
- Cada nó guarda o **span** no texto original e um flag `dirty`. Na serialização, subárvore limpa é reemitida **verbatim** a partir do texto original. É isso que faz "não reformatar o que não foi tocado" ser literal, não aproximado.

**Nenhum caminho de número passa por `Number`, `parseFloat` ou `parseInt`** — nem na validação, nem no input, nem na serialização. Validação é contra a gramática JSON; o input mantém string. Teste obrigatório com inteiro acima de 2^53 (`12345678901234567890` não pode virar `12345678901234567000`).

Erros de parse reportam **apenas linha e coluna**, nunca o trecho. A mensagem nativa do `JSON.parse` embute conteúdo da entrada e é o vazamento mais fácil de cometer.

## Funcionalidade: edição de parâmetros

### Seleção
- Campo para informar o **name do parameter** (ex.: `/prod/billing/env`) — requisito mínimo.
- Se o parameter name **não existir**, avisar claramente e **não** oferecer gravação implícita. Criar é fluxo separado e explícito, exigindo escolha consciente de `Type`, `Tier` e `KeyId`. Nunca criar como efeito colateral de um save — `PutParameter` com `Overwrite: true` cria o parâmetro se ele não existir, e nesse caso não há original de onde herdar metadados.
- Listagem: no driver local, enumerar tudo é barato. **Contra SSM real não é** — `GetParametersByPath` exige um path, é paginado, e varrer uma conta de produção é lento e caro. A UI de listar-tudo da fase 1 não sobrevive igual na fase 3; provavelmente vira busca por prefixo.

### Visualização
Ao abrir um parâmetro:
- Se o valor for JSON válido, renderizar como **lista de campos chave-valor** (estilo cadastro de variáveis de ambiente de repositório).
- Cada entrada tem: chave, **seletor de tipo** e valor.
- Tipos suportados, todos com representação própria na UI:
  - `string` — input de texto.
  - `number` — input de texto validado contra a gramática JSON, preservando o lexema.
  - `boolean` — toggle.
  - `object` — abre **painel aninhado** com o mesmo componente de chave-valor, recursivamente.
  - `array` — **editor de lista** com adicionar / remover / reordenar. Cada item tem seu próprio tipo, incluindo `object` e `array` aninhados. Reordenar por botão sobe/desce (acessível por teclado e testável); drag-and-drop é polimento opcional.
  - `null` — campo desabilitado exibindo `null`.
- **`null` vs string vazia**: valores distintos, o round-trip precisa preservar a diferença. Por isso o tipo é escolhido no seletor, não inferido de campo vazio. `{"a": null}` e `{"a": ""}` nunca colapsam.
- Renomear uma chave **mantém a posição na lista**. Não reordena.
- Documento com chave duplicada **carrega e mostra as duas**, com erro de validação que bloqueia o save — em vez de descartar uma silenciosamente.
- Se o valor **não** for JSON válido, cair no editor de texto cru e avisar claramente — sem tentar "consertar" sozinho. Parâmetro `StringList` cai aqui, o que é aceitável.
- Aba **"JSON cru"** sempre disponível, com sincronização bidirecional. Enquanto o texto cru estiver inválido, **ele é a fonte da verdade**, a aba estruturada fica indisponível com o motivo, e nada é convertido. Voltando a ser válido, o formulário reaparece.
- **Pretty-print é toggle de visualização apenas.** Como os parâmetros reais são minificados em linha única, o JSON cru é ilegível sem isso — mas formatar o documento de verdade marcaria tudo como `dirty`, destruiria o round-trip verbatim e faria um save sem edição reescrever o parâmetro inteiro. A formatação existe no render e some na serialização. Teste: ativar o toggle e salvar não produz mudança alguma.

### Edição e salvamento
- Adicionar, editar, renomear, reordenar e remover entradas.
- **Preservar a ordem original das chaves** e não reformatar o que não foi tocado.
- Validação antes de salvar: chave vazia, chave duplicada por nível, lexema numérico inválido, e tamanho do payload em **bytes UTF-8** contra o limite do tier (Standard 4 KB, Advanced 8 KB) — aviso a partir de 90%, erro ao estourar.
- **Diff obrigatório antes de salvar**, com confirmação explícita.
  - A visualização é **diff estrutural, renderizado por caminho** (`db_connections.ba.se: "value" → "novo"`). **Não** use diff unificado por linha: em JSON minificado ele reporta "uma linha mudou" e joga o documento inteiro na tela, o que é pior que não ter diff, porque dá impressão de revisão.
  - Se o parâmetro for `SecureString`, o diff lista **quais caminhos** mudaram sem exibir os valores, respeitando o estado de revelação.
  - **Invariante:** a base do diff é um **snapshot imutável do texto originalmente carregado**, guardado à parte. Nunca derivada dos spans do documento atual — se fosse, ir para a aba JSON cru e voltar reparseia tudo, zera o `dirty` contra o texto novo e o diff passa a mentir.
- **Proteção contra lost update.** São parâmetros de sistemas compartilhados: outra pessoa pode salvar entre o meu GET e o meu PUT, e `Overwrite: true` sobrescreveria em silêncio. O SSM não tem put condicional, mas devolve `Version`:
  - Guardar a `version` lida no GET e enviá-la como `expectedVersion`.
  - No save, **reler** o parâmetro e comparar.
  - Se mudou, **abortar**, avisar de alteração externa e exibir **diff de três vias** (base carregada / versão atual no store / minha edição), marcando por caminho se o conflito é real ou se as mudanças são disjuntas.
  - Nunca sobrescrever às cegas.
  - **Conflito é resultado, não exceção.** O use case devolve algo como `{ outcome: 'saved' | 'conflict' | 'not-found', ... }`, e a rota responde 409 ou 404 pelo helper normal. Modelar conflito como exceção obrigaria a escolher entre vazar o valor atual pela redação ou não ter o que mostrar no diff de três vias.
  - **Limitação conhecida, documentada no README:** reler-comparar-gravar não é atômico. A janela cai do tempo inteiro de edição para os milissegundos entre o re-read e o `PutParameter`, mas não zera.
- Ao salvar: `PutParameter` com `Overwrite: true`, **preservando `Type`, `KeyId` e `Tier`** do original. `SecureString` é lido com `WithDecryption: true` e regravado como `SecureString` com o mesmo `KeyId`.
- Antes de gravar, salvar **backup local** da versão anterior em `./.backups/<name>/<timestamp>.json`.
- Retenção automática em `./.backups/`: podar por idade e por quantidade de versões por parâmetro, com limites configuráveis por variável de ambiente. É o único ponto do desenho que guarda em texto claro algo que o SSM guarda cifrado — não pode acumular indefinidamente.
- Exibir o número da versão resultante e permitir consultar histórico (`GetParameterHistory`).
- **Sem log de auditoria local.** O histórico nativo do SSM mais os backups já cobrem rollback.

## Entregáveis

1. Repositório funcional com a estrutura acima.
2. `mise.toml` com Node e `"aqua:aws/aws-cli"` pinados.
3. `Makefile` com alvos: `setup`, `check-deps`, `dev`, `test`, `lint`, `build`.
   - `check-deps` valida que `node` e `aws` **resolvem para dentro do diretório do mise** — não só a versão. Há um Node do Homebrew e um AWS CLI x86_64 sob Rosetta nesta máquina, e verificar só `--version` deixaria passar o binário errado. Falha com mensagem acionável.
   - `setup` roda `mise install` + `npm ci`. **Não** baixe nem execute o instalador oficial da AWS, e não use `sudo` em nenhum alvo.
4. `README.md` **em português**: pré-requisitos, setup, configuração do profile SSO, como alternar entre driver `aws` e `local`, aviso sobre segredos em `.backups/` e `.local-store/`, limitação de atomicidade do lost update, e demais limitações conhecidas.
5. `docs/architecture.md` em português com diagrama Mermaid das camadas e o contrato do `ParameterStorePort`.
6. Política IAM mínima (`ssm:GetParameter`, `ssm:GetParameterHistory`, `ssm:PutParameter`, `ssm:GetParametersByPath`, `kms:Decrypt`) em `docs/iam-policy.json`.
7. Testes unitários. Os que não podem faltar:
   - **Round-trip byte-idêntico**: parse → serializar sem editar produz o texto original exato.
   - **Ordem de chaves** preservada, inclusive com chaves de nome numérico.
   - **`30.0` sobrevive** como `30.0`; inteiro acima de 2^53 sobrevive exato.
   - **`null` vs `""`** distintos.
   - **Duplicata** detectada, não descartada.
   - **Pretty-print** ligado + save = nenhuma mudança.
   - **Redação de erro**: valor sentinela não sobrevive a nenhum caminho de erro, nem na resposta nem no log.
   - **`no-store`** presente em resposta de página, não só de API.
   - **CSRF**: requisição não-GET com `Origin`/`Host` inesperado é rejeitada.
   - **Lost update**: save com versão divergente aborta e o arquivo em disco fica intacto.
   - **Not found**: save em name inexistente não cria.

## Empacotamento (fora de escopo por enquanto)

Uso pessoal, uma máquina só — **não containerize agora**. Se um dia eu distribuir para o time, aí entra um `Dockerfile`, e nesse cenário a autenticação precisará mudar para o *device authorization flow* (`@aws-sdk/client-sso-oidc`), já que não haverá navegador dentro do container.

Consequência prática: mantenha a autenticação atrás de `SsoAuthPort`, para que trocar `AwsSsoAdapter` por um `SsoDeviceFlowAdapter` seja substituição de implementação, não refatoração.

## Critérios de aceitação (usabilidade)

Checklist a incluir no README:

- **A partir de sessão já autenticada**, abrir, editar e salvar um parâmetro em **menos de 5 interações**.
- Nunca salvar por acidente: toda gravação passa por diff + confirmação.
- JSON aninhado de 3 níveis editável sem tocar em texto cru.
- Um parâmetro minificado de linha única é legível e navegável na UI.
- Sessão SSO expirando no meio da edição **não faz perder o que foi digitado**.
- Trocar de profile com rascunho pendente sempre pede confirmação.
- Round-trip de um parâmetro sem alterações produz **diff vazio**.
- Alteração externa entre carregar e salvar é sempre detectada, nunca sobrescrita.
- Parameter name inexistente nunca vira criação acidental.
- Erros da AWS aparecem com mensagem acionável, não com stack trace.
- Compartilhar a tela com um parâmetro `SecureString` aberto não expõe nenhum valor sem ação deliberada minha.

## Fases

Entrega em fases, com o app rodando ao final de cada uma. Ao final de cada fase, pare e me mostre o que rodar para validar.

1. **Scaffold** — Astro + React + `mise`, hot reload, `LocalFileStoreAdapter` ponta a ponta, helper de resposta e error mapper com teste sentinela. *(concluída)*
2. **2a — Editor, sem nenhum caminho de gravação.** Middleware com `no-store` em toda resposta; modelo de documento próprio (parser com spans, serializador ciente de `dirty`, operações puras); validação; editor React recursivo com os seis tipos, arrays e aba JSON cru bidirecional; pretty-print como render; mascaramento de `SecureString`; `500.astro`. Botão Salvar presente e desabilitado.
3. **2b — Gravação, com as duas guardas nascendo juntas.** Diff estrutural por caminho, confirmação, rota PUT, `expectedVersion` no port, lost update com diff de três vias, `SaveOutcome` como resultado, e **CSRF/Origin/Host no mesmo pacote** — a primeira rota mutante não pode existir sem isso.
4. **Fase 3 — AWS.** Seletor de profiles (com profiles sem SSO distinguidos), autenticação SSO, `AwsSsmStoreAdapter`, `SecureString` real, sessão do Astro desabilitada. **Backup e retenção entram aqui, antes do primeiro `PutParameter` contra a AWS** — nenhuma escrita em SSM real sem rede de proteção. Considere fazer o adapter nascer somente-leitura e liberar a escrita junto com o backup.
5. **Fase 4 — Fechamento.** Histórico, fluxo de criação de parâmetro, testes restantes, `docs/architecture.md`, `docs/iam-policy.json`, README completo.

Não invente configuração de conta, região ou nomes de parâmetro: pergunte ou deixe como variável de ambiente documentada.
