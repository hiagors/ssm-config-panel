# SSM Config Panel

Ferramenta web **local** para visualizar, validar e editar parâmetros JSON no AWS SSM Parameter
Store. Roda na sua máquina, em loopback, e substitui a edição de JSON cru no console da AWS.

> **Estado atual: Fase 2a concluída.** O editor de chave-valor funciona com aninhamento, listas,
> os seis tipos, validação e aba de JSON cru bidirecional, tudo no `LocalFileStoreAdapter`.
> Ainda **não grava**: o save exige diff e proteção contra escrita concorrente, e os dois entram
> na Fase 2b. O acesso ao SSM real é a Fase 3. Veja [Roadmap](#roadmap).

## Pré-requisitos

- macOS em Apple Silicon (arm64).
- [`mise`](https://mise.jdx.dev) para gerenciar o runtime. Nada é instalado globalmente.

```sh
brew install mise
```

Ative o mise no seu shell, adicionando ao `~/.zshrc`:

```sh
eval "$(mise activate zsh)"
```

O `mise.toml` pina **Node 24.18.0** e **AWS CLI 2.36.10**. O AWS CLI vem pelo backend
`aqua:aws/aws-cli`, que na origem extrai o `.pkg` oficial da AWS — não é necessário rodar o
instalador da AWS e nenhum alvo do `Makefile` usa `sudo`.

## Setup

```sh
make setup       # mise install + npm ci, cria .env a partir de .env.example
make check-deps  # confirma que node e aws vêm do diretório do mise
```

O `check-deps` verifica **caminho**, não só versão: se você tiver um `aws` ou `node` global
sombreando o pinado, ele falha com a mensagem do que corrigir.

## Uso

```sh
make seed   # cria o parâmetro de exemplo /example/demo/env no store local
make dev    # http://127.0.0.1:4321 com hot reload
```

Outros alvos:

| Alvo | O que faz |
| --- | --- |
| `make test` | testes unitários (Vitest) |
| `make test-watch` | testes em modo watch |
| `make lint` | checagem de tipos e diagnósticos do Astro |
| `make build` | build de produção (servidor Node standalone) |
| `make start` | roda o build em `127.0.0.1` |
| `make clean` | remove `dist`, `.astro` e `node_modules` (preserva os stores) |

## Drivers de store

A escolha do adapter vem de `STORE_DRIVER` no `.env`, resolvida em um único *composition root*
([src/infrastructure/store/index.ts](src/infrastructure/store/index.ts)):

| Valor | Adapter | Situação |
| --- | --- | --- |
| `local` | `LocalFileStoreAdapter` | grava JSON em `./.local-store`, espelhando o formato do SSM |
| `aws` | `AwsSsmStoreAdapter` | **Fase 3.** Hoje falha explicitamente, em vez de cair no local sem avisar |

O store local espelha a hierarquia do SSM em diretórios:

```
/example/demo/env  ->  .local-store/example/demo/env.json        # o JSON do valor, sem envelope
                       .local-store/example/demo/env.meta.json   # Type, Tier, KeyId, Version
```

O arquivo de valor contém **exatamente** o JSON do valor. Os metadados ficam num sidecar porque o
save da Fase 2 precisa preservar `Type`, `KeyId` e `Tier` do parâmetro original.

### Configuração do profile SSO

Ainda não se aplica: a Fase 1 não toca em conta AWS. Na Fase 3 os profiles serão lidos de
`~/.aws/config` via `loadSharedConfigFiles()`, nos dois formatos (`sso_start_url` inline e blocos
`[sso-session]`). Nenhuma conta, região ou nome de parâmetro é embutido no código.

## ⚠️ Segredos em texto claro

**`./.local-store/` e `./.backups/` contêm valores de parâmetro em texto claro, incluindo
`SecureString` decriptado.**

- Os dois estão no `.gitignore`. Não os force para dentro do git.
- Arquivos são criados com permissão `0600` e diretórios com `0700`.
- `make clean` **não** apaga esses diretórios; remova à mão quando não precisar mais deles.

Outras garantias implementadas:

- O servidor faz bind em `127.0.0.1`, nunca em `0.0.0.0`.
- **Toda** resposta sai com `Cache-Control: no-store`, não só as de `/api/*`. A regra vive em
  [src/middleware.ts](src/middleware.ts), um ponto único, porque a página do editor carrega o valor
  do parâmetro embutido no HTML — no SSR e nos props da ilha React. Uma rota nova nasce coberta.
- Erros são **redigidos por padrão**: só mensagens curadas no domínio atravessam a fronteira HTTP.
  Mensagem de erro de biblioteca, `cause` e stack trace nunca chegam ao browser nem ao log do
  servidor. Isso é testado com valor sentinela em
  [src/pages/api/\_http.test.ts](src/pages/api/_http.test.ts) — inclusive contra o vazamento por
  `JSON.parse`, cuja mensagem nativa embute um trecho do texto de entrada.
- `Type` é propriedade do parâmetro inteiro, não das chaves. Em `SecureString`, **todos** os
  valores entram mascarados, com "revelar tudo" global e revelar por linha. Nada é adivinhado por
  nome de chave. Mascarar não é CSS: o valor real **não entra no atributo do input** até a
  revelação, e o campo fica somente-leitura enquanto oculto — não se edita o que não se vê.
- Todo input de valor passa por [um único componente](src/components/editor/ValueInput.tsx) que
  aplica `autocomplete="off"`, `data-1p-ignore` e `data-lpignore`, para gerenciador de senha não se
  oferecer. Nunca usa `type="password"` para mascarar, porque é exatamente o que dispara o
  gerenciador. O teste verifica o HTML emitido, não os props.
- Rascunho nunca é escrito em `localStorage`, cookie, query string nem arquivo temporário: vive só
  no estado do React.

## Por que o editor tem parser próprio de JSON

`JSON.parse` perde três coisas que o spec exige preservar:

```js
JSON.parse('{"timeout": 30.0}')   // -> {timeout: 30}      perde int vs float
JSON.parse('{"2":"b","1":"a"}')   // -> reordena as chaves  objeto JS ordena chave numérica
JSON.parse('{"a":1,"a":2}')       // -> {a: 2}             perde a duplicata
```

Além disso, `Number('9007199254740993')` devolve `9007199254740992`: qualquer conversão para
`number` corrompe inteiro acima de 2^53. Por isso **nenhum caminho do editor chama `Number`,
`parseFloat` ou `parseInt` em um número de parâmetro** — o número é guardado como lexema de texto e
validado por gramática, em [jsonNumber.ts](src/domain/json/jsonNumber.ts).

O modelo em [src/domain/json/](src/domain/json/) guarda ainda o *span* de cada nó no texto de
origem. Subárvore que não foi editada é reemitida **byte a byte** do original, o que faz duas
promessas serem literais e não aproximadas:

- Round-trip de um parâmetro sem alterações produz diff vazio.
- Editar um campo não reformata os vizinhos — `{  "x":1,   "y":2  }` mantém o espaçamento torto,
  `30.0` não vira `30`, e JSON minificado continua minificado depois de inserir campo.

O que **é** reformatado: um container editado reemite seus separadores, usando o estilo detectado do
próprio arquivo. Necessário porque inserir ou remover item muda quantos separadores existem.

## Limitações conhecidas

- **Ainda não grava.** O botão Salvar existe desabilitado. Gravar sem diff e sem recheque de versão
  violaria dois critérios de aceitação de uma vez; os dois entram na Fase 2b.
- **Sem driver AWS.** `STORE_DRIVER=aws` falha com erro explícito.
- **Reordenar é por botão sobe/desce**, não arrastar. Funciona por teclado e é testável.
- **Painel aninhado começa fechado a partir do terceiro nível**, para a tela não explodir em
  parâmetro grande. Abrir é um clique.
- **Raiz que não é objeto nem lista** (um parâmetro cujo valor é só uma string, por exemplo) não
  tem formulário de chave-valor: cai na aba JSON cru, com aviso.
- **Chave terminada em `.meta`** é rejeitada no driver local, porque colidiria com o sidecar.
- **`history()` no driver local** devolve apenas a versão atual. O store em arquivos não guarda
  versões anteriores; o histórico real vem dos backups (Fase 4) e do `GetParameterHistory`
  (Fase 3).
- **Colisão de caixa no APFS.** O sistema de arquivos do macOS não distingue maiúsculas de
  minúsculas, mas o SSM sim. `/prod/env` e `/Prod/env` são parâmetros diferentes na AWS e
  colidiriam no mesmo arquivo local. O adapter **detecta e falha com HTTP 409** em vez de devolver
  ou sobrescrever o parâmetro errado. Se você precisa dos dois ao mesmo tempo, use o driver `aws`.
- **Names terminados em `.meta` são rejeitados** no driver local, porque colidiriam com o arquivo
  de metadados do parâmetro vizinho.
- Sem autocomplete por path prefix, sem histórico, sem backup, sem diff. Fases 2 a 4.

## Arquitetura

MVC no nível da aplicação, com o acesso ao store isolado por Ports & Adapters. `application/` e
`domain/` não conhecem nenhum tipo do SDK da AWS.

```
src/
  pages/            # rotas Astro (views) + /api/* (controllers HTTP)
  components/       # ilhas React
  application/      # use cases
  domain/           # modelo do parâmetro, tipos, validação
  infrastructure/
    store/          # ParameterStorePort + adapters + composition root
```

O diagrama e o contrato completo do `ParameterStorePort` vão em `docs/architecture.md` na Fase 4.
O contrato está em [src/infrastructure/store/ParameterStorePort.ts](src/infrastructure/store/ParameterStorePort.ts).

## Roadmap

- [x] **Fase 1** — scaffold Astro + React + mise, hot reload, `LocalFileStoreAdapter` ponta a ponta.
- [x] **Fase 2a** — editor de chave-valor com aninhamento, listas, tipos, validação, aba de JSON
      cru bidirecional e mascaramento de `SecureString`. Sem gravação.
- [ ] **Fase 2b** — diff estrutural por caminho, confirmação explícita, `PUT`, proteção contra lost
      update com diff de três vias, e CSRF (`security.checkOrigin` + validação de Host).
- [ ] **Fase 3** — seletor de profiles, autenticação SSO, `AwsSsmStoreAdapter`, `SecureString` real.
      Backup e retenção entram aqui, **antes** do primeiro `PutParameter` contra a AWS.
- [ ] **Fase 4** — histórico, fluxo de criação de parâmetro, testes restantes e documentação
      (`docs/architecture.md`, `docs/iam-policy.json`).

### Critérios de aceitação

- [ ] A partir de sessão já autenticada, abrir, editar e salvar em menos de 5 interações.
- [ ] Nunca salvar por acidente: toda gravação passa por diff + confirmação.
- [x] JSON aninhado de 3 níveis editável sem tocar em texto cru.
- [ ] Sessão SSO expirando no meio da edição não faz perder o que foi digitado.
- [ ] Trocar de profile com rascunho pendente sempre pede confirmação.
- [x] Round-trip de um parâmetro sem alterações produz diff vazio. *(garantido pelo serializador
      verbatim; o diff em si é da 2b.)*
- [ ] Alteração externa entre carregar e salvar é sempre detectada, nunca sobrescrita.
- [x] Parameter name inexistente nunca vira criação acidental. *(não existe caminho de gravação; o
      fluxo explícito de criação é da Fase 4.)*
- [x] Erros aparecem com mensagem acionável, não com stack trace. *(mecanismo pronto; os erros da
      AWS em si entram na Fase 3.)*
- [x] Compartilhar a tela com um parâmetro `SecureString` aberto não expõe valor sem ação
      deliberada.
