# SSM Config Panel

Ferramenta web **local** para visualizar, validar e editar parâmetros JSON no AWS SSM Parameter
Store. Roda na sua máquina, em loopback, e substitui a edição de JSON cru no console da AWS.

> **Estado atual: todas as fases concluídas.** Lê e grava no SSM real, com seletor de profiles,
> login SSO, `SecureString` decriptado, diff obrigatório, proteção contra escrita concorrente,
> backup da versão anterior antes de cada gravação e **rollback pela própria interface**.
>
> Fora de escopo por decisão: histórico nativo (`GetParameterHistory`) e criação de parâmetro — o
> rollback é coberto pelos backups locais, em [`/backups/<name>`](#rollback).

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
| `local` | `LocalFileStoreAdapter` | grava em `./.local-store`, para desenvolver sem tocar em conta AWS |
| `aws` | `AwsSsmStoreAdapter` | SSM real, leitura e gravação, sempre atrás de backup |

O store local é **um arquivo plano por parâmetro**, com valor e metadados juntos:

```
/example/demo/env  ->  .local-store/example#demo#env.json
```

```json
{
  "name": "/example/demo/env",
  "type": "String",
  "tier": "Standard",
  "keyId": null,
  "version": 3,
  "value": "{\"SERVICE_NAME\":\"example-demo\"}"
}
```

Três decisões que valem explicação:

- **`#` como separador**, e não `_`: `#` é ilegal em segmento de name no SSM, então a codificação é
  injetiva. Com `_`, os names `/a_b/c` e `/a/b/c` cairiam no mesmo arquivo.
- **Nome de arquivo minúsculo**, com o name verdadeiro dentro. O APFS não distingue caixa, mas o SSM
  sim: `/prod/env` e `/PROD/env` são parâmetros diferentes. Toda leitura compara o `name` gravado com
  o que foi pedido e falha alto se divergir — em vez de devolver, ou pior, sobrescrever o parâmetro
  errado. Isso substituiu uma varredura de diretório que comparava caixa nível por nível.
- **Sem sidecar de metadados.** Eram dois arquivos por parâmetro, com lógica de merge e de defaults
  para o caso de um faltar. O envelope único resolve o mesmo problema — o save precisa preservar
  `Type`, `Tier` e `KeyId` — sem o segundo arquivo. A consequência aceita é que `list()` lê o valor
  do disco para pegar os metadados; ela continua **devolvendo somente metadados**, e nenhum valor
  atravessa a fronteira HTTP.

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

A política pronta está em [docs/iam-policy.json](docs/iam-policy.json). Ela diverge da lista do spec
em três pontos:

- `ssm:DescribeParameters` **entra**, e **não aceita permissão por recurso**: tem de ser
  `Resource: "*"`. É a única concessão de escopo do desenho.
- `ssm:GetParametersByPath` **sai**. A listagem usa `DescribeParameters`, que devolve **só
  metadados** — `GetParametersByPath` traria os valores, carregando segredo na memória do servidor
  só para desenhar uma lista.
- `ssm:GetParameterHistory` **sai**, porque histórico ficou fora de escopo.

Sem `ssm:DescribeParameters` a leitura ainda funciona: o `Tier` cai para `Standard` e o `KeyId` fica
vazio. O aviso de tamanho fica conservador e a gravação de `SecureString` não terá a chave para
preservar.

### Listar parâmetros

No driver `local`, a tela lista tudo — enumerar arquivos é barato. Contra o SSM real, **não existe
listar tudo**: a busca é sempre por prefixo de path. Varrer uma conta de produção é paginado, lento
e sujeito a throttling.

## Backup: a rede de proteção da gravação

Antes de cada `PutParameter`, a versão que vai ser sobrescrita é copiada para disco. **Se o backup
falhar, a gravação é abortada** — não é melhor esforço, é bloqueio. Um backup que falha em silêncio é
pior que backup nenhum, porque cria a confiança sem a garantia.

```
/prod/billing/env  ->  .backups/prod/billing/env/2026-07-30T12-35-19.480Z.json
```

O arquivo é um envelope, não o valor cru — diferente do `.local-store`. Sem `version`, `type`,
`tier` e `keyId`, um backup não serve para rollback:

```json
{
  "name": "/prod/billing/env",
  "version": 3,
  "type": "SecureString",
  "tier": "Advanced",
  "keyId": "alias/minha-chave",
  "savedAt": "2026-07-30T12:35:19.480Z",
  "value": "{...}"
}
```

Escrita por temporário + `rename`, e por um motivo: o backup é lido como prova de que a versão
anterior está salva, e um arquivo truncado por queda no meio da escrita seria pior que ausência —
pareceria válido.

### Rollback

Cada parâmetro tem uma tela de histórico em **`/backups/<name>`**, alcançável pelo link
_"Backups e rollback"_ no topo do editor. Ela lista as cópias existentes com data e versão — só
metadados, nenhum valor.

Escolher uma cópia abre o editor em `/parameters/<name>?restore=<timestamp>` com o valor antigo já
carregado **como rascunho**. A partir daí não há caminho especial: é o fluxo normal de gravação.

```
histórico  ->  editor (rascunho = valor antigo, base = valor atual)
           ->  diff estrutural: o que muda em relação ao que está no store agora
           ->  confirmação explícita
           ->  backup da versão atual  ->  PutParameter
```

Duas coisas caem dessa escolha, e são o motivo dela:

1. **Restaurar não pula a revisão.** Um botão "restaurar" que gravasse direto pularia o diff e a
   confirmação, e "nunca salvar por acidente" é critério de aceitação — vale para desfazer também.
2. **O rollback tem rollback.** Como a gravação é a normal, restaurar a versão 6 sobre a 8 copia a 8
   para `./.backups` antes de gravar. Desfazer o desfazer é só voltar à mesma tela.

O `BackupHistoryUseCase` **não grava nada**, e há teste fixando isso: se restaurar ganhasse um
caminho de escrita próprio, ganharia também a chance de divergir das duas garantias acima.

### Retenção

`./.backups/` é o único lugar do desenho que guarda em texto claro o que o SSM guarda cifrado. Sem
poda, cada save de um `SecureString` deixa mais uma cópia permanente do segredo.

| Variável | Padrão | O que faz |
| --- | --- | --- |
| `BACKUP_DIR` | `./.backups` | onde as cópias ficam |
| `BACKUP_MAX_VERSIONS_PER_PARAMETER` | `20` | quantidade máxima por parâmetro; `0` desliga |

**O backup mais recente nunca é apagado**, independente do limite. Sem essa regra, um
`BACKUP_MAX_VERSIONS_PER_PARAMETER` mal entendido apagaria a única cópia existente na primeira poda —
e a poda roda justamente no momento em que a versão anterior está sendo sobrescrita. É também por
isso que `0` **desliga** a poda em vez de apagar tudo: desligar por engano é recuperável, apagar não.

Havia também poda por idade (`BACKUP_MAX_AGE_DAYS`, hoje ignorada). Saiu porque o limite de contagem
já **limita** o acúmulo — no máximo N cópias por parâmetro, para sempre. A poda por idade só mudava
*quais* dessas N ficavam, ao custo de um segundo eixo de configuração e de decidir o que fazer com
timestamp ilegível.

A poda é por parâmetro, na gravação, e falha de poda **não** invalida o backup recém-gravado: a rede
de proteção está de pé, só sobrou lixo. Abortar ali bloquearia o save por um problema de limpeza.

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

## Por que o editor é uma grade única, e não containers aninhados

A tela de edição é **uma** CSS grid: `.tree-head` e `.tree-row` compartilham a mesma
`grid-template-columns`, em qualquer profundidade.

```
16px   minmax(0,190px)   92px   minmax(0,1fr)   56px
grip   chave             tipo   valor           ação (2 slots)
```

A versão anterior renderizava recursão por **aninhamento de componentes**: cada nível abria um
container com padding e um grid próprio, dentro de uma largura já estreitada. A coluna de valor era
recalculada a cada nível, e a coluna de chave reservava espaço de novo em cada profundidade — com 3
níveis, sobravam ~30px para o input e o conteúdo não aparecia.

Agora a árvore é achatada em lista de linhas por [treeRows.ts](src/components/editor/treeRows.ts) —
recursão de **dados**, não de render. Todas as linhas são irmãs na mesma grade, a coluna de valor é
medida uma vez contra a largura total (454px na largura padrão, em qualquer nível), e a profundidade
existe só como `padding-left` dentro da célula de chave. O container da linha nunca ganha padding por
profundidade.

Linhas de objeto e lista são header: chevron, nome e badge de contagem. Não renderizam input de valor
nem seletor de tipo — a conversão para container mora no menu kebab, com confirmação **só quando há
perda real** (valor não vazio ou filhos existentes). `""` → objeto não abre diálogo.

Entre escalares, a conversão **preserva o texto bruto**: `"abc"` para número continua `"abc"`,
marcado como inválido pela validação que já existia. Resetar para `0` apagaria o trabalho de quem
digitou errado e ainda esconderia o erro.

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
3. Se a versão mudou, a gravação é **abortada**, e um aviso não-bloqueante diz em que versão o
   parâmetro está e de qual a sua edição partiu. O rascunho continua intacto e o editor continua na
   tela.
4. Três saídas: continuar editando, **comparar o rascunho com a versão de fora**, ou descartar o
   rascunho e recarregar.

A opção do meio é o que substituiu uma tela de diff de três vias. Ela adota a versão de fora como
base e mantém o seu texto: o diff normal de revisão passa a mostrar exatamente o que você mudaria em
relação a ela — **inclusive o que reverteria da alteração da outra pessoa**. Ou seja, a informação que
a tela de três vias dava continua aparecendo, no lugar onde você já ia olhar de todo jeito, e sem uma
segunda visualização de diff para manter. Há teste fixando essa propriedade em
[structuralDiff.test.ts](src/domain/json/structuralDiff.test.ts) — se ela falhasse, confirmar depois
de rebasear seria sobrescrever às cegas com uma revisão que mentiu.

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

- **Criar parâmetro não é possível pela ferramenta.** `put()` exige que o parâmetro exista; crie pelo
  console ou pela CLI da AWS, escolhendo `Type`, `Tier` e `KeyId`, e depois volte para editar.
- **Sem histórico nativo do SSM** (`GetParameterHistory`), por decisão de escopo. O rollback é
  coberto pelos backups locais, que só têm as versões gravadas por esta ferramenta.
- **A busca do editor casa segmento completo**, não pedaço de nome: `banking` encontra a chave
  `banking`, `bank` não encontra nada. Filtro por substring devolveria resultado que ninguém pediu.
- **Diff de lista é por índice.** Item de lista não tem chave, então inserir no começo marca os
  índices seguintes como alterados. É verdade — os índices mudaram — mas é ruidoso. Objetos casam
  por chave e não sofrem disso.
- **Rebasear é literal:** adota a versão atual do store como base e mantém o seu texto por cima. Se
  a outra pessoa mudou um caminho que você também mudou, o seu texto vence. O diff da revisão mostra
  isso antes de qualquer gravação; a decisão é sua.
- **Restaurar um backup só volta o valor**, não os metadados. `Type`, `Tier` e `KeyId` gravados são
  sempre os do parâmetro **atual**, não os do backup — o backup guarda os dele para referência, mas
  um rollback não rebaixa tier nem troca chave KMS por efeito colateral.
- **Reordenar é por arrastar a alça, ou `Alt+↑/↓` com a alça focada.** A alça aparece no hover e no
  foco por teclado. Arrastar só funciona entre irmãos: mover entre pais diferentes seria remover e
  inserir, outra operação com outra semântica de diff.
- **Acima de 3 níveis não há expansão em linha**: o header entra no escopo (drill-in) e o breadcrumb
  mostra o caminho. Indentar além disso comeria a coluna de chave de 190px.
- **Raiz que não é objeto nem lista** (um parâmetro cujo valor é só uma string, por exemplo) não
  tem formulário de chave-valor: cai na aba JSON cru, com aviso.
- **No driver local, names que só diferem na caixa não coexistem.** `/prod/env` e `/PROD/env` são
  parâmetros distintos no SSM, mas caem no mesmo arquivo em APFS. A ferramenta falha alto em vez de
  devolver ou sobrescrever o errado. Contra o SSM real não há essa restrição.
- **Backups de dois parâmetros que só diferem na caixa compartilham diretório.** O `name` dentro de
  cada arquivo é conferido, então nenhum backup do outro parâmetro aparece na lista nem pode ser
  restaurado — mas os dois históricos moram no mesmo lugar em disco.
- **Sem histórico.** O port não expõe `history()` e a policy não pede `ssm:GetParameterHistory` —
  manter um método que nenhum use case chama seria contrato mentindo sobre capacidade. Para
  rollback, use os backups em `./.backups`, ou o histórico nativo pelo console da AWS.
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

O diagrama das camadas, o fluxo de uma gravação e o contrato completo do `ParameterStorePort` estão
em [docs/architecture.md](docs/architecture.md). O contrato em código fica em
[ParameterStorePort.ts](src/infrastructure/store/ParameterStorePort.ts), e a política mínima de IAM
em [docs/iam-policy.json](docs/iam-policy.json).

## Roadmap

- [x] **Fase 1** — scaffold Astro + React + mise, hot reload, `LocalFileStoreAdapter` ponta a ponta.
- [x] **Fase 2a** — editor de chave-valor com aninhamento, listas, tipos, validação, aba de JSON
      cru bidirecional e mascaramento de `SecureString`. Sem gravação.
- [x] **Fase 2b** — diff estrutural por caminho, confirmação explícita, `PUT`, proteção contra lost
      update, e CSRF (`security.checkOrigin` + validação de Host).
- [x] **Fase 3a** — seletor de profiles (com os sem SSO bloqueados), login SSO, `AwsSsmStoreAdapter`
      somente-leitura, `SecureString` real, sessão do Astro desligada.
- [x] **Fase 3b** — backup local + retenção, e a escrita no SSM real habilitada em cima disso.
- [x] **Fase 4** — pretty-print como visualização, expiração de sessão como estado de primeira
      classe, aviso de rascunho não salvo, testes restantes,
      [docs/architecture.md](docs/architecture.md) e [docs/iam-policy.json](docs/iam-policy.json).

### Critérios de aceitação

- [x] A partir de sessão já autenticada, abrir, editar e salvar em menos de 5 interações.
      *(name + Enter, editar campo, Revisar e salvar, Confirmar = 4.)*
- [x] Nunca salvar por acidente: toda gravação passa por diff + confirmação.
- [x] JSON aninhado de 3 níveis editável sem tocar em texto cru.
- [x] Um parâmetro minificado de linha única é legível e navegável na UI.
      *(formulário em árvore, mais o toggle de formatação na aba crua.)*
- [x] Sessão SSO expirando no meio da edição não faz perder o que foi digitado.
      *(banner não-bloqueante com reautenticação sem recarregar; o rascunho vive no estado do
      React e não é tocado.)*
- [x] Trocar de profile com rascunho pendente sempre pede confirmação.
      *(cada rota é uma carga de página, então o aviso de saída cobre fechar, recarregar e voltar
      à tela inicial — que é onde se troca de profile.)*
- [x] Round-trip de um parâmetro sem alterações produz diff vazio.
- [x] Alteração externa entre carregar e salvar é sempre detectada, nunca sobrescrita.
- [x] Parameter name inexistente nunca vira criação acidental.
- [x] Erros aparecem com mensagem acionável, não com stack trace.
- [x] Compartilhar a tela com um parâmetro `SecureString` aberto não expõe valor sem ação
      deliberada.
- [x] Voltar para uma versão anterior é possível pela própria ferramenta, sem abrir o Finder.
      *(`/backups/<name>` → carrega no editor → diff → confirmação; e a versão substituída também
      vira backup.)*

### O que os testes garantem

| Garantia | Onde |
| --- | --- |
| round-trip byte-idêntico, ordem de chaves, `30.0`, inteiro acima de 2^53, `null` vs `""` | [roundTrip.test.ts](src/domain/json/roundTrip.test.ts) |
| duplicata detectada, não descartada | [validateDocument.test.ts](src/application/validation/validateDocument.test.ts) |
| pretty-print ligado + save = nenhuma mudança | [prettyPrint.test.ts](src/domain/json/prettyPrint.test.ts) |
| valor sentinela não sobrevive a nenhum caminho de erro, nem no log | [\_http.test.ts](src/pages/api/_http.test.ts) |
| `no-store` em resposta de página, não só de API | [noStore.test.ts](src/infrastructure/http/noStore.test.ts) |
| requisição não-GET com `Origin`/`Host` inesperado é rejeitada | [csrf.test.ts](src/infrastructure/http/csrf.test.ts) |
| lost update aborta e o arquivo em disco fica intacto | [LocalFileStoreAdapter.test.ts](src/infrastructure/store/LocalFileStoreAdapter.test.ts) |
| save em name inexistente não cria | [SaveParameterUseCase.test.ts](src/application/SaveParameterUseCase.test.ts) |
| backup acontece antes do `put`, e falha de backup aborta | [SaveParameterUseCase.test.ts](src/application/SaveParameterUseCase.test.ts) |
| o backup mais recente nunca é podado | [retention.test.ts](src/infrastructure/backup/retention.test.ts) |
| restaurar um backup não grava nada por si: só carrega rascunho | [BackupHistoryUseCase.test.ts](src/application/BackupHistoryUseCase.test.ts) |
| depois de rebasear, o diff mostra o que a minha edição reverteria da outra pessoa | [structuralDiff.test.ts](src/domain/json/structuralDiff.test.ts) |
| name que só difere na caixa não devolve nem sobrescreve o parâmetro errado | [LocalFileStoreAdapter.test.ts](src/infrastructure/store/LocalFileStoreAdapter.test.ts) |
| nenhum módulo da ilha usa API só-de-Node | [browserSafety.test.ts](src/components/editor/browserSafety.test.ts) |
| sessão do Astro não escreve em disco | [astroConfig.test.ts](src/astroConfig.test.ts) |
