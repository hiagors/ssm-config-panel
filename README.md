# SSM Config Panel

Ferramenta web **local** para visualizar, validar e editar parâmetros JSON no AWS SSM Parameter
Store. Roda na sua máquina, em loopback, e substitui a edição de JSON cru no console da AWS.

> **Estado atual: Fase 3a concluída.** Já lê do SSM real, com seletor de profiles, login SSO e
> `SecureString` decriptado. O adapter da AWS é **somente-leitura**: a gravação entra junto com o
> backup local, para que nenhuma escrita em conta real aconteça sem rede de proteção. No driver
> `local` a gravação já funciona completa, com diff e proteção contra lost update.
> Veja [Roadmap](#roadmap).

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
| `aws` | `AwsSsmStoreAdapter` | SSM real, **somente leitura**. `put()` falha explicitamente até o backup existir |

O store local espelha a hierarquia do SSM em diretórios:

```
/example/demo/env  ->  .local-store/example/demo/env.json        # o JSON do valor, sem envelope
                       .local-store/example/demo/env.meta.json   # Type, Tier, KeyId, Version
```

O arquivo de valor contém **exatamente** o JSON do valor. Os metadados ficam num sidecar porque o
save da Fase 2 precisa preservar `Type`, `KeyId` e `Tier` do parâmetro original.

### Configuração do profile SSO

```sh
make dev-aws   # sobe com STORE_DRIVER=aws
```

Na tela inicial: escolha o profile, clique **Autenticar** (abre o navegador padrão), e a tela
detecta sozinha quando a sessão fica válida. Se o navegador não abrir, a URL e o código aparecem no
terminal onde o servidor está rodando. Dá para autenticar por fora também:

```sh
aws sso login --profile <nome>
```

Os profiles vêm de `~/.aws/config` via `loadSharedConfigFiles()`, nos dois formatos:

| Formato | Como é reconhecido | Chave do cache de token |
| --- | --- | --- |
| Novo | `sso_session = X` + bloco `[sso-session X]` | `sha1("X")` |
| Legado | `sso_start_url` inline no profile | `sha1(sso_start_url)` |

Nenhuma conta, região ou nome de parâmetro é embutido no código. A **região vem do profile** — se o
profile não tiver `region`, a ferramenta recusa em vez de escolher uma.

`AWS_PROFILE`, se definido, apenas **pré-seleciona** no seletor. O profile usado de fato vai
explicitamente em cada request, no parâmetro `?profile=`. Não há fallback para a variável de
ambiente: uma requisição sem profile falha e diz o que faltou, em vez de operar em silêncio sob
outra identidade.

### ⚠️ Profiles sem SSO são bloqueados

`loadSharedConfigFiles()` lê também `~/.aws/credentials`, então profiles com chave de acesso
estática aparecem na lista — **desabilitados, com o motivo escrito**. Aparecer importa: quem procura
`default` e não encontra conclui que a ferramenta está quebrada, em vez de entender o motivo.

O risco que isso evita: selecionar por engano um profile de credencial estática e editar produção
sob uma identidade de longa duração que a tela não consegue nomear. As credenciais vêm sempre de
`fromSSO()` explícito, nunca da cadeia default — que tentaria variável de ambiente e
`~/.aws/credentials` antes do SSO.

### Permissões de IAM

Além do que o spec lista, é preciso **`ssm:DescribeParameters`**. O motivo é concreto:
`GetParameter` **não devolve `Tier` nem `KeyId`** — só `Name`, `Type`, `Value`, `Version`,
`LastModifiedDate`, `ARN` e `DataType`. Preservar `Tier` e `KeyId` na gravação é requisito, e o
limite de tamanho da validação depende do `Tier`. Os dois campos só existem em `ParameterMetadata`,
que vem de `DescribeParameters` ou de `GetParameterHistory` — e o histórico pagina em ordem
crescente de versão, então pegar a atual exigiria percorrer tudo.

Duas consequências:

- `ssm:DescribeParameters` **não aceita permissão por recurso**: tem de ser `Resource: "*"`.
- `ssm:GetParametersByPath` deixou de ser necessário. A listagem usa `DescribeParameters`, que
  devolve **só metadados** — `GetParametersByPath` traria os valores, carregando segredo na memória
  do servidor só para desenhar uma lista.

Sem `ssm:DescribeParameters` a leitura ainda funciona: o `Tier` cai para `Standard` e o `KeyId` fica
vazio. O aviso de tamanho fica conservador e a gravação de `SecureString` não terá a chave para
preservar.

### Listar parâmetros

No driver `local`, a tela lista tudo — enumerar arquivos é barato. Contra o SSM real, **não existe
listar tudo**: a busca é sempre por prefixo de path. Varrer uma conta de produção é paginado, lento
e sujeito a throttling.

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

## Gravação: as duas barreiras

Salvar passa **sempre** por revisão e confirmação explícita. O diff é estrutural, por caminho:

```
alterado  /DATABASE/pool/max
  − number  10
  + number  20
adicionado /RETRY_POLICY/backoff/maxMillis
  + number  5000
movido    /PORT            posição 2 → 1
```

Não existe diff por linha, de propósito: os parâmetros reais são JSON minificado em linha única, e
comparar duas linhas gigantes não diz nada. Por caminho também é o único formato que atende
`SecureString` — dá para listar **quais chaves** mudaram sem exibir os valores, porque chave e valor
são campos separados do resultado.

### Proteção contra lost update

Estes são parâmetros de sistemas compartilhados. Outra pessoa pode gravar entre o meu GET e o meu
PUT, e `Overwrite: true` apagaria o trabalho dela em silêncio. O SSM não tem put condicional, mas
devolve `Version`, e isso basta:

1. A versão lida no GET vive junto com o texto base, no estado do editor.
2. No save, o servidor **relê** o parâmetro e compara.
3. Se a versão mudou, a gravação é **abortada** e a tela mostra diff de três vias — base carregada /
   versão atual no store / minha edição — classificando cada caminho em *só eu*, *só o outro* ou
   *conflito*.
4. O rascunho continua intacto: dá para rebasear na versão atual, descartar e recarregar, ou voltar
   a editar.

A checagem existe em duas camadas: no use case e de novo no adapter, via `PutOptions.expectedVersion`
— assim vale para qualquer chamador do port, não só para o caminho que a UI usa.

**Limite honesto:** reler-comparar-gravar não é atômico. A janela cai de "todo o tempo de edição"
para os milissegundos entre o re-read e a gravação, mas não zera.

### Nunca criar por efeito colateral

`PutParameter` com `Overwrite: true` cria o parâmetro se ele não existir — e nesse caso não há
original de onde herdar `Type`, `Tier` e `KeyId`. Por isso `expectedVersion` é obrigatório no port:
`>= 1` exige que o parâmetro exista, e `0` é o sentinela de criação deliberada, recusado pela rota
`PUT`. O fluxo explícito de criação é da Fase 4.

## Rede em loopback não é fronteira de segurança

Escutar em `127.0.0.1` não protege do browser. Duas coisas que o loopback não impede, ambas
tratadas em [csrf.ts](src/infrastructure/http/csrf.ts) e aplicadas no middleware:

- **CSRF.** Qualquer aba aberta pode disparar `fetch` para `http://127.0.0.1:4321`. O CORS bloqueia
  a *leitura* da resposta, mas a requisição acontece — e escrita não precisa de resposta para causar
  dano. Toda rota não-GET exige `Origin` de loopback na porta certa; `Origin` ausente é recusa, não
  permissão.
- **DNS rebinding.** Um domínio do atacante pode resolver para `127.0.0.1`, e aí o browser trata as
  duas como mesma origem e libera até a leitura da resposta — que carrega valor decriptado. A defesa
  é o servidor recusar `Host` que não seja loopback conhecido. Aplicada a **toda** requisição,
  inclusive de leitura, porque é na leitura que o segredo sai.

`security.checkOrigin` do Astro e `server.allowedHosts` também estão declarados no
`astro.config.mjs`, como segunda camada.

## Limitações conhecidas

- **O driver `aws` não grava.** `put()` falha com `WRITE_NOT_ENABLED`. A escrita entra junto com o
  backup e a retenção — nenhuma gravação em conta real sem rede de proteção. O driver `local` grava
  completo.
- **Sem backup ainda.** No driver local a gravação sobrescreve sem guardar a versão anterior.
- **Sem histórico, sem fluxo de criação de parâmetro e sem drag-and-drop**, por decisão de escopo:
  usar a ferramenta por duas semanas antes de decidir se fazem falta.
- **Sem pretty-print da aba JSON cru.** Um parâmetro minificado de linha única é navegável pelo
  formulário, mas a aba de texto cru mostra uma linha só. O toggle de visualização está previsto no
  spec e ainda não foi feito.
- **Diff de lista é por índice.** Item de lista não tem chave, então inserir no começo marca os
  índices seguintes como alterados. É verdade — os índices mudaram — mas é ruidoso. Objetos casam
  por chave e não sofrem disso.
- **Rebasear é literal:** adota a versão atual do store como base e mantém o seu texto por cima. Se
  a outra pessoa mudou um caminho que você também mudou, o seu texto vence. O diff de três vias
  mostra isso antes; a decisão é sua.
- **Conflito de `SecureString` não tem botão de revelar.** Mostra só quais caminhos divergiram.
  Revelar três versões de um segredo numa tela de decisão apressada é o oposto do critério de
  compartilhar tela com segurança — para ver o conteúdo, volte a editar e revele campo por campo.
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
- [x] **Fase 2b** — diff estrutural por caminho, confirmação explícita, `PUT`, proteção contra lost
      update com diff de três vias, e CSRF (`security.checkOrigin` + validação de Host).
- [x] **Fase 3a** — seletor de profiles (com os sem SSO bloqueados), login SSO, `AwsSsmStoreAdapter`
      somente-leitura, `SecureString` real, sessão do Astro desligada.
- [ ] **Fase 3b** — backup local + retenção, e só então a escrita no SSM real.
- [ ] **Fase 4** — testes restantes e documentação (`docs/architecture.md`,
      `docs/iam-policy.json`). Histórico, fluxo de criação e drag-and-drop ficaram fora por decisão
      de escopo.

### Critérios de aceitação

- [x] A partir de sessão já autenticada, abrir, editar e salvar em menos de 5 interações.
      *(name + Enter, editar campo, Revisar e salvar, Confirmar = 4.)*
- [x] Nunca salvar por acidente: toda gravação passa por diff + confirmação.
- [x] JSON aninhado de 3 níveis editável sem tocar em texto cru.
- [ ] Sessão SSO expirando no meio da edição não faz perder o que foi digitado.
- [ ] Trocar de profile com rascunho pendente sempre pede confirmação.
- [x] Round-trip de um parâmetro sem alterações produz diff vazio.
- [x] Alteração externa entre carregar e salvar é sempre detectada, nunca sobrescrita.
- [x] Parameter name inexistente nunca vira criação acidental.
- [x] Erros aparecem com mensagem acionável, não com stack trace. *(mecanismo pronto; os erros da
      AWS em si entram na Fase 3.)*
- [x] Compartilhar a tela com um parâmetro `SecureString` aberto não expõe valor sem ação
      deliberada.
