# Spec — Editor de Parameter Store (Astro + React, execução nativa)

## Contexto e objetivo

Ferramenta web **local** (uso individual, roda na minha máquina) para **visualizar, validar e editar parâmetros JSON no AWS SSM Parameter Store**.

O problema que ela resolve: hoje edito variáveis de ambiente de vários sistemas direto no console da AWS, colando JSON cru. É fácil quebrar o formato, difícil revisar o que mudou e não existe validação. Quero uma UI parecida com a tela de "environment variables" de um repositório (lista de chave-valor), com suporte a valores aninhados.

Documentação em **português**; nomes de variáveis, funções, arquivos e commits em **inglês**.

## Stack obrigatória

- **Astro** com `output: 'server'` e adapter `@astrojs/node` (precisa de servidor: todas as chamadas AWS acontecem no backend).
- **React** via `@astrojs/react`, usado apenas nas ilhas interativas (editor, formulários). Páginas estáticas continuam `.astro`.
- **TypeScript** em modo `strict`.
- **Runtime gerenciado por `mise`**, não instalado globalmente: `mise.toml` na raiz pinando **Node** e **`awscli`** (use exatamente o nome `awscli` no registry do mise — os aliases `aws` e `aws-cli` já ficaram para trás em versões antigas). `npm` como gerenciador de pacotes.
- Ambiente: **macOS / Apple Silicon (arm64)**.
- Testes: **Vitest** para unidade. Playwright apenas se necessário para o fluxo crítico.

## Arquitetura

Sistema simples, mas com separação explícita. MVC no nível da aplicação, com a camada de acesso ao store isolada por **Ports & Adapters**:

```
src/
  pages/            # rotas Astro (views) + /api/* (controllers HTTP)
  components/       # ilhas React
  application/      # use cases (get, validate, diff, save)
  domain/           # modelo do parâmetro, tipos, regras de validação
  infrastructure/
    store/
      ParameterStorePort.ts        # interface
      AwsSsmStoreAdapter.ts        # produção
      LocalFileStoreAdapter.ts     # dev/offline
    auth/
      SsoAuthPort.ts
      AwsSsoAdapter.ts
```

**`ParameterStorePort`** deve expor algo como `list()`, `get(name)`, `put(name, value, options)`, `history(name)` — sem nenhum tipo do SDK da AWS vazando para `application/` ou `domain/`. O retorno de `get()` inclui a `version` corrente (ver "Proteção contra lost update").

Dois adapters:

1. **`AwsSsmStoreAdapter`** — SSM real.
2. **`LocalFileStoreAdapter`** — grava os mesmos parâmetros como arquivos JSON em `./.local-store/`, **espelhando exatamente o formato do SSM** (um arquivo por parameter name, conteúdo = o JSON do valor). Sem achatamento para `.env`. Serve para desenvolver e testar a UI sem tocar em conta AWS. Deve simular versionamento (contador por parâmetro) para que a proteção contra escrita concorrente seja testável no driver local.

A escolha do adapter vem de variável de ambiente (`STORE_DRIVER=aws|local`), resolvida em um único *composition root*.

## Autenticação (AWS SSO)

O app roda nativamente na minha máquina, então o navegador local está disponível — aproveite isso e mantenha o fluxo simples.

1. A tela inicial lista os profiles disponíveis lidos de `~/.aws/config`, em um seletor. Para cada profile, exibir conta, role e o estado da sessão (válida / expirada / nunca autenticada). Se `AWS_PROFILE` estiver definido, pré-selecionar esse profile.

   Para ler os profiles, use `loadSharedConfigFiles()` do pacote `@aws-sdk/shared-ini-file-loader` — não implemente parsing de INI manualmente. Ele resolve tanto o formato legado (`sso_start_url` e `sso_region` inline no profile) quanto o formato novo com blocos `[sso-session]` referenciados por `sso_session`, além de respeitar `AWS_CONFIG_FILE`. Ambos os formatos precisam funcionar.

2. Autenticar dispara `aws sso login --profile <selecionado>` no backend, que abre o navegador padrão. A UI faz polling até a sessão ficar válida.
3. Credenciais são obtidas via `fromSSO()` do `@aws-sdk/credential-providers`, que lê o cache em `~/.aws/sso/cache`, e usadas para instanciar o client do SSM.
4. Toda operação é sempre no contexto do profile selecionado. Trocar de profile **descarta a edição em andamento** — mas exige **confirmação explícita** quando existe rascunho não salvo. Nunca descarte silenciosamente.
5. **Expiração de token é estado de primeira classe**, não erro. O rascunho vive no estado do React da página aberta, então expirar não deve custar nada ao usuário: detectar, avisar em banner não-bloqueante, oferecer reautenticar (mesmo fluxo do item 2, sem recarregar a página) e retomar exatamente de onde parou, incluindo o diff pendente.

### Restrições de segurança

- Nenhuma chave de acesso estática hardcoded ou em arquivo versionado.
- O servidor faz bind em `127.0.0.1`, não em `0.0.0.0`.
- **Tokens e credenciais nunca saem do backend.**
- **Valores de parâmetro, incluindo `SecureString` decriptado, podem trafegar para o browser** — é uma ferramenta local, servida em loopback, e sem isso a edição estruturada é impossível. Em contrapartida:
  - `Type` é propriedade do parâmetro inteiro, não das chaves internas. Se `Type === 'SecureString'`, **todos** os valores do JSON entram mascarados, com "revelar tudo" global e revelar individual por linha. Não tente adivinhar por nome de chave o que é ou não segredo.
  - **Nunca** aparecem em log de servidor, log de browser, mensagem de erro ou stack trace.
  - **Nunca** são persistidos em disco fora de `./.backups/` e de `./.local-store/` (que é o próprio store no driver local). Em particular, não escreva rascunho em `localStorage` nem em arquivo temporário.
- Os arquivos de `./.backups/` e `./.local-store/` contêm segredos em texto claro: devem entrar no `.gitignore` e ser criados com permissão `0600`. Documente isso no README.
- Inputs de valor usam `autocomplete="off"`, `data-1p-ignore` e `data-lpignore` para não acionar gerenciador de senhas.

#### Estas duas regras devem ser estruturais, não disciplina

Regras que dependem de lembrar em cada rota apodrecem. Implemente-as em um único ponto e cubra com teste:

- **`Cache-Control: no-store`** em toda resposta que carregue valor de parâmetro. Crie **um único helper de resposta** usado por todas as rotas `/api/*`; nenhuma rota monta `Response` na mão.
- **Valor de parâmetro nunca entra em objeto de erro nem é serializado em exceção.** Crie um **error mapper central que redige por padrão**: o que chega ao cliente é código + mensagem acionável, nunca o payload. Isso importa porque a página de erro do Astro em modo dev expõe contexto da requisição, e uma exceção não tratada vazaria o valor decriptado em HTML.
- Teste unitário obrigatório: injetar um valor sentinela em cada caminho de erro e assertar que ele **não** aparece na resposta serializada nem no log.

## Funcionalidade: edição de parâmetros

### Seleção
- Campo para informar o **name do parameter** (ex.: `/prod/billing/env`) — requisito mínimo.
- Se o parameter name **não existir**, avisar claramente e **não** oferecer gravação implícita. Criar é fluxo separado e explícito, exigindo escolha consciente de `Type`, `Tier` e `KeyId`. Nunca criar como efeito colateral de um save — lembre que `PutParameter` com `Overwrite: true` cria o parâmetro se ele não existir, e nesse caso não há original de onde herdar metadados.
- Desejável (não bloqueante): listagem por *path prefix* com `GetParametersByPath` para autocompletar.

### Visualização
Ao abrir um parâmetro:
- Se o valor for JSON válido, renderizar como **lista de campos chave-valor** (estilo cadastro de variáveis de ambiente de repositório).
- Cada entrada tem: chave, **seletor de tipo** e valor.
- Tipos suportados, todos com representação própria na UI:
  - `string` — input de texto.
  - `number` — input numérico, distinguindo int de float na serialização.
  - `boolean` — toggle.
  - `object` — abre **painel aninhado** com o mesmo componente de chave-valor, recursivamente.
  - `array` — **editor de lista** com adicionar / remover / reordenar. Cada item tem seu próprio tipo, incluindo `object` (que abre painel aninhado) e `array` (aninhado).
  - `null` — campo desabilitado exibindo `null`.
- **Atenção ao caso `null` vs string vazia**: são valores distintos e o round-trip precisa preservar a diferença. Por isso o tipo é escolhido no seletor, não inferido de um campo vazio. `{"a": null}` e `{"a": ""}` nunca podem colapsar um no outro.
- Se o valor **não** for JSON válido, cair no editor de texto cru e avisar claramente — sem tentar "consertar" sozinho.
- Aba **"JSON cru"** sempre disponível, com sincronização bidirecional com o formulário estruturado.

### Edição e salvamento
- Adicionar, editar, renomear, reordenar e remover entradas.
- **Preservar a ordem original das chaves** e não reformatar o que não foi tocado.
- Validação antes de salvar: JSON parseável, chaves não vazias, chaves duplicadas, tipos coerentes, tamanho do payload (Standard = 4 KB, Advanced = 8 KB — avisar antes de estourar).
- **Diff obrigatório antes de salvar**: unified diff mostrando exatamente o que muda, com confirmação explícita. Se o parâmetro for `SecureString`, o diff lista **quais chaves** mudaram sem exibir os valores, respeitando o estado de revelação escolhido na edição.
- **Proteção contra lost update.** Estes são parâmetros de sistemas compartilhados: outra pessoa pode salvar entre o meu GET e o meu PUT, e `Overwrite: true` sobrescreveria a alteração dela em silêncio. O SSM não tem put condicional, mas devolve `Version`, e isso basta:
  - Guardar a `version` lida no GET.
  - No momento do save, **reler** o parâmetro e comparar com a versão guardada.
  - Se mudou, **abortar a gravação**, avisar que houve alteração externa e exibir diff de três vias (base carregada / versão atual no SSM / minha edição), deixando eu decidir.
  - Nunca sobrescrever às cegas.
- Ao salvar: `PutParameter` com `Overwrite: true`, **preservando `Type`, `KeyId` e `Tier`** do parâmetro original. `SecureString` é lido com `WithDecryption: true` e regravado como `SecureString` com o mesmo `KeyId`.
- Antes de gravar, salvar **backup local** da versão anterior em `./.backups/<name>/<timestamp>.json`.
- Retenção automática em `./.backups/`: podar por idade e por quantidade de versões por parâmetro, com limites configuráveis por variável de ambiente. É o único ponto do desenho que guarda em texto claro algo que o SSM guarda cifrado — não pode acumular indefinidamente.
- Exibir o número da versão resultante e permitir consultar histórico (`GetParameterHistory`).
- **Sem log de auditoria local.** O histórico nativo do SSM mais os backups já cobrem rollback.

## Entregáveis

1. Repositório funcional com a estrutura acima.
2. `mise.toml` com Node e `awscli` pinados.
3. `Makefile` com alvos: `setup`, `check-deps`, `dev`, `test`, `lint`, `build`.
   - `check-deps` verifica `mise`, Node e `aws --version` (exigindo v2), falhando com mensagem acionável.
   - `setup` roda `mise install` + `npm ci`. Como o `awscli` está no `mise.toml`, a instalação vem junto — **não** baixe nem execute o instalador oficial da AWS, e não use `sudo` em nenhum alvo.
4. `README.md` **em português**: pré-requisitos, setup, configuração do profile SSO, como alternar entre driver `aws` e `local`, aviso sobre segredos em `.backups/` e `.local-store/`, e limitações conhecidas.
5. `docs/architecture.md` em português com diagrama Mermaid das camadas e o contrato do `ParameterStorePort`.
6. Política IAM mínima (`ssm:GetParameter`, `ssm:GetParameterHistory`, `ssm:PutParameter`, `ssm:GetParametersByPath`, `kms:Decrypt`) em `docs/iam-policy.json`.
7. Testes unitários dos use cases e do serializador JSON. Os mais importantes:
   - **Round-trip**: parse → editar → serializar deve ser estável, preservando ordem de chaves, int vs float, `null` vs `""` e arrays heterogêneos.
   - **Redação de erro**: valor sentinela nunca sobrevive à serialização de exceção nem ao log.
   - **Lost update**: save com versão divergente aborta e não grava.

## Empacotamento (fora de escopo por enquanto)

Uso pessoal, uma máquina só — **não containerize agora**. Se um dia eu distribuir para o time, aí entra um `Dockerfile`, e nesse cenário a autenticação precisará mudar para o *device authorization flow* (`@aws-sdk/client-sso-oidc`), já que não haverá navegador dentro do container.

Consequência prática: mantenha a autenticação atrás de `SsoAuthPort`, para que trocar `AwsSsoAdapter` por um `SsoDeviceFlowAdapter` seja substituição de implementação, não refatoração.

## Critérios de aceitação (usabilidade)

Checklist a incluir no README:

- **A partir de sessão já autenticada**, abrir, editar e salvar um parâmetro em **menos de 5 interações**.
- Nunca salvar por acidente: toda gravação passa por diff + confirmação.
- JSON aninhado de 3 níveis editável sem tocar em texto cru.
- Sessão SSO expirando no meio da edição **não faz perder o que foi digitado**.
- Trocar de profile com rascunho pendente sempre pede confirmação.
- Round-trip de um parâmetro sem alterações produz **diff vazio**.
- Alteração externa entre carregar e salvar é sempre detectada, nunca sobrescrita.
- Parameter name inexistente nunca vira criação acidental.
- Erros da AWS aparecem com mensagem acionável, não com stack trace.
- Compartilhar a tela com um parâmetro `SecureString` aberto não expõe nenhum valor sem ação deliberada minha.

## Como quero que você trabalhe

- **Entrega em fases**, com o app rodando ao final de cada uma. Não escreva o sistema inteiro de uma vez.
  1. Scaffold Astro + React + `mise`, hot reload funcionando, e `LocalFileStoreAdapter` ponta a ponta.
  2. Editor de chave-valor com aninhamento, arrays, tipos, validação, diff e proteção contra lost update (ainda no driver local).
  3. Seletor de profiles + autenticação SSO + `AwsSsmStoreAdapter` + `SecureString`. **Backup e retenção entram aqui, antes do primeiro `PutParameter` contra a AWS** — nenhuma escrita em SSM real pode acontecer sem rede de proteção.
  4. Histórico, fluxo de criação de parâmetro, testes restantes e documentação.
- Ao final de cada fase, pare e me mostre o que rodar para validar.
- Não invente configuração de conta, região ou nomes de parâmetro: pergunte ou deixe como variável de ambiente documentada.
