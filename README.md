# SSM Config Panel

Editor web **local** para parâmetros JSON no AWS SSM Parameter Store. Roda na sua máquina, em
loopback, e substitui a edição de JSON cru no console da AWS.

O problema que ele resolve: variáveis de ambiente de vários sistemas vivem como um JSON minificado
dentro de um parâmetro do SSM. Editar isso no console é colar texto numa `<textarea>` — sem
validação, sem saber o que mudou, e sem rede de proteção se o formato quebrar. Aqui o mesmo
parâmetro aparece como um formulário de chave-valor, toda gravação passa por um diff que você
confirma, e a versão anterior vai para o disco antes de qualquer escrita.

| O que faz | |
| --- | --- |
| **Formulário** | JSON aninhado como lista de campos, com tipo por campo e busca por caminho |
| **Diff antes de salvar** | estrutural, por caminho, com confirmação explícita |
| **Backup e rollback** | cópia da versão anterior antes de cada gravação, e restauração pela interface |
| **Sessão SSO** | seletor de profiles de `~/.aws/config`, login e estado da sessão na tela |
| **Busca** | parâmetros por prefixo de path |

## Requisitos

- **Sistema operacional POSIX.** O store local e os backups usam permissão `0600`/`0700`, e os
  scripts são bash — então Windows fica de fora, exceto por WSL. Desenvolvido e testado em **macOS
  Apple Silicon**; nada em `src/` é específico de macOS, mas Linux não foi exercitado (em particular,
  o pacote aqua do AWS CLI pinado no `mise.toml` só foi validado no macOS).
- [**`mise`**](https://mise.jdx.dev) para o runtime — nada é instalado globalmente. O `mise.toml`
  pina Node 24.18.0 e AWS CLI 2.36.10.
- **Navegador na mesma máquina.** O login SSO abre o navegador padrão, e a interface é servida em
  loopback. Não serve para rodar num servidor remoto sem sessão gráfica.
- Um **profile SSO em `~/.aws/config`** com `region` definida. Profiles com chave de acesso estática
  aparecem na lista mas ficam **bloqueados**: as credenciais vêm sempre de SSO explícito.
- **Permissões de IAM** na role do profile: `ssm:GetParameter`, `ssm:GetParameters`,
  `ssm:PutParameter`, `ssm:DescribeParameters`, e `kms:Decrypt` + `kms:GenerateDataKey` para
  `SecureString`. A política pronta está em [docs/iam-policy.json](docs/iam-policy.json), com as
  chaves KMS restritas por `kms:ViaService`.

  `ssm:DescribeParameters` **não aceita permissão por recurso** — precisa de `Resource: "*"`. É de
  onde vêm `Tier` e `KeyId`, que a gravação preserva. Sem ela a leitura ainda funciona, mas o `Tier`
  cai para `Standard` (o aviso de tamanho fica conservador) e a gravação de `SecureString` perde a
  chave a preservar.

## Instalação

```sh
brew install mise
eval "$(mise activate zsh)"   # adicione ao ~/.zshrc

make setup       # mise install + npm ci, cria .env a partir de .env.example
make check-deps  # confirma que node e aws vêm do diretório do mise
```

`check-deps` verifica **caminho**, não só versão: um `node` ou `aws` global sombreando o pinado faz
o alvo falhar com a correção na mensagem.

## Executar

```sh
make dev-aws   # contra o SSM real, em http://127.0.0.1:4321
```

Para uso contínuo, o build standalone:

```sh
make build
make start     # roda dist/ em 127.0.0.1
```

Todos os alvos:

| Alvo | O que faz |
| --- | --- |
| `make dev-aws` | servidor de desenvolvimento contra o SSM real (`STORE_DRIVER=aws`) |
| `make dev` | idem, contra o store local em arquivos |
| `make seed` | cria `/example/demo/env` no store local, para experimentar sem AWS |
| `make build` | build de produção (servidor Node standalone) |
| `make start` | roda o build em `127.0.0.1` |
| `make test` | testes unitários |
| `make lint` | checagem de tipos |
| `make clean` | remove `dist`, `.astro` e `node_modules` — **preserva** os stores |

## Configuração

Tudo no `.env`, criado a partir do [.env.example](.env.example):

| Variável | Padrão | O que faz |
| --- | --- | --- |
| `STORE_DRIVER` | `local` | `aws` para o SSM real; `local` para arquivos em disco |
| `HOST` | `127.0.0.1` | **não troque por `0.0.0.0`** — a ferramenta é de loopback |
| `PORT` | `4321` | porta do servidor |
| `BACKUP_DIR` | `./.backups` | onde ficam as cópias das versões anteriores |
| `BACKUP_MAX_VERSIONS_PER_PARAMETER` | `20` | máximo de cópias por parâmetro; `0` desliga a poda |
| `LOCAL_STORE_DIR` | `./.local-store` | store do driver `local` |
| `AWS_PROFILE` | — | se definido, apenas **pré-seleciona** no seletor |

O profile usado de fato vai explicitamente em cada request. Não há fallback para `AWS_PROFILE`: uma
requisição sem profile falha e diz o que faltou, em vez de operar em silêncio sob outra identidade.

### Driver `local`

Modo offline, para experimentar sem tocar em conta AWS. Um arquivo plano por parâmetro, com valor e
metadados juntos:

```
/example/demo/env  ->  .local-store/example#demo#env.json
```

## Uso

### 1. Autenticar

Na tela inicial, escolha o profile e clique **Autenticar** — abre o navegador padrão e a tela detecta
sozinha quando a sessão fica válida. Se o navegador não abrir, a URL e o código aparecem no terminal
do servidor. Autenticar por fora também funciona:

```sh
aws sso login --profile <nome>
```

Cada profile mostra conta, role e o estado da sessão: válida, expirada ou nunca autenticada.

### 2. Abrir um parâmetro

Duas formas: digitar o name completo em **Name do parameter** (`/prod/billing/env`), ou **Buscar por
prefixo de path** (`/prod`) e escolher da lista. A busca traz só metadados, nunca valores.

Contra o SSM real a busca é sempre por prefixo — varrer uma conta inteira é paginado, lento e sujeito
a throttling.

### 3. Editar

O editor tem duas abas:

- **Formulário** — uma linha por campo, com chave editável, seletor de tipo e valor. `object` e
  `array` são linhas expansíveis; conversão para container fica no menu `⋮` da linha, com
  confirmação quando há conteúdo a perder. Arraste a alça à esquerda para reordenar, ou `Alt+↑/↓`
  com ela focada.
- **JSON cru** — o texto, com um toggle de formatação para ler JSON minificado. Enquanto o texto
  estiver inválido, ele é a fonte da verdade e o formulário fica indisponível com o motivo.

Tipos: `string`, `number`, `boolean`, `object`, `array` e `null`. `null` e string vazia são valores
distintos e nunca colapsam um no outro.

A busca da barra superior filtra por caminho e casa **segmento completo**: `banking` encontra a chave
`banking`; `pool.min` encontra `DATABASE.pool.min`; `bank` não encontra nada.

O cabeçalho mostra `type`, `tier`, versão atual e o tamanho em bytes UTF-8 contra o limite do tier
(4 KB no Standard, 8 KB no Advanced). Acima de 90% do limite vira aviso; estourar bloqueia a
gravação, como chave vazia, chave duplicada no mesmo nível e número inválido.

**O que você não editou não é reescrito.** Espaçamento, ordem das chaves e o formato dos números
sobrevivem byte a byte: `30.0` não vira `30`, inteiro acima de 2^53 não perde precisão, e um
parâmetro minificado continua minificado depois de você inserir um campo.

### 4. Revisar e salvar

**Revisar e salvar** mostra o diff antes de qualquer escrita. Ele é estrutural, por caminho:

```
alterado   /DATABASE/pool/max
  − number  10
  + number  20
adicionado /RETRY_POLICY/backoff/maxMillis
  + number  5000
movido     /PORT            posição 2 → 1
```

Confirmar grava. Nessa ordem: backup da versão atual em disco, depois `PutParameter` preservando
`Type`, `Tier` e `KeyId` do original. **Se o backup falhar, nada é gravado.**

Não existe caminho que salve sem passar por aqui.

### 5. Rollback

O link **Backups e rollback** no topo do editor leva a `/backups/<name>`, com as cópias existentes
por data e versão. Escolher uma abre o editor com o valor antigo carregado como rascunho — e daí em
diante é o fluxo normal: diff contra o que está no store agora, confirmação, gravação.

Duas consequências úteis: restaurar não pula a revisão, e o rollback tem rollback (restaurar a versão
6 sobre a 8 copia a 8 para `./.backups` antes de gravar).

### Situações que você vai encontrar

| Situação | O que acontece |
| --- | --- |
| **Alguém gravou enquanto você editava** | a gravação é abortada e um aviso diz as duas versões. Seu rascunho fica intacto, com três saídas: continuar editando, **comparar seu rascunho com a versão de fora** (o diff passa a mostrar o que você mudaria — e o que reverteria — em relação a ela), ou descartar e recarregar |
| **A sessão SSO expira no meio da edição** | banner não-bloqueante com botão de reautenticar, sem recarregar a página. Nada do que você digitou é perdido |
| **O parâmetro é `SecureString`** | todos os valores entram mascarados, com "revelar tudo" e revelar por linha. Recarregar volta tudo a oculto |
| **O valor não é JSON válido** | cai na aba de texto cru com o motivo (linha e coluna), sem tentar consertar |
| **O parâmetro não existe** | avisa e não cria nada |
| **Você fecha a aba com rascunho pendente** | o navegador pede confirmação |

## ⚠️ Segredos em texto claro

**`./.backups/` e `./.local-store/` contêm valores de parâmetro em texto claro, incluindo
`SecureString` decriptado.**

- Os dois estão no `.gitignore`. Não os force para dentro do git.
- Arquivos nascem com `0600`, diretórios com `0700`.
- `make clean` **não** apaga esses diretórios. Remova à mão quando não precisar mais.
- A retenção mantém no máximo `BACKUP_MAX_VERSIONS_PER_PARAMETER` cópias por parâmetro. A mais
  recente nunca é apagada, mesmo com o limite desligado.

Outras garantias:

- O servidor faz bind em `127.0.0.1`. Loopback não protege do browser — qualquer aba aberta pode
  fazer requisição para `127.0.0.1` — então toda escrita exige `Origin` da própria interface, e toda
  requisição exige `Host` de loopback (contra DNS rebinding).
- Toda resposta sai com `Cache-Control: no-store`, inclusive as páginas: a do editor carrega o valor
  embutido no HTML.
- Erros são redigidos por padrão: só mensagens curadas atravessam para o browser e para o log.
  Mensagem de biblioteca, `cause` e stack trace nunca saem — nem a do `JSON.parse`, que embute um
  trecho do texto de entrada.
- Rascunho nunca vai para `localStorage`, cookie, query string ou arquivo temporário. Vive só no
  estado do React.
- Os inputs de valor desativam gerenciador de senha (`autocomplete="off"`, `data-1p-ignore`,
  `data-lpignore`) e nunca usam `type="password"`.

## Limitações conhecidas

- **Não cria parâmetro.** A ferramenta edita o que já existe. Crie pelo console ou pela CLI da AWS,
  escolhendo `Type`, `Tier` e `KeyId`, e depois volte para editar.
- **Sem o histórico nativo do SSM.** O rollback usa os backups locais, que só têm as versões
  gravadas por esta ferramenta. Para versões anteriores a ela, use o console da AWS.
- **A proteção contra escrita concorrente não é atômica.** O servidor relê e compara a versão antes
  de gravar, o que reduz a janela do tempo inteiro de edição para os milissegundos entre a releitura
  e a escrita — mas não a zera. O SSM não tem escrita condicional.
- **Rebasear é literal.** Ao comparar com a versão de fora, o seu texto vence nos caminhos em que os
  dois mexeram. O diff mostra isso antes de gravar; a decisão é sua.
- **Restaurar um backup volta só o valor.** `Type`, `Tier` e `KeyId` gravados são sempre os do
  parâmetro atual — um rollback não rebaixa tier nem troca chave KMS por efeito colateral.
- **Diff de lista é por índice.** Inserir no começo de uma lista marca os itens seguintes como
  alterados: os índices mudaram de fato. Objetos casam por chave e não sofrem disso.
- **Acima de 3 níveis não há expansão em linha.** O campo entra em escopo e um breadcrumb mostra o
  caminho.
- **Valor cuja raiz não é objeto nem lista** (uma string solta, ou um `StringList`) não tem
  formulário: cai na aba de texto cru.
- **No driver `local`, names que só diferem na caixa não coexistem.** `/prod/env` e `/PROD/env` são
  parâmetros distintos no SSM, mas o sistema de arquivos do macOS não distingue caixa. A ferramenta
  falha alto em vez de devolver ou sobrescrever o errado. Contra o SSM real não há essa restrição.

## Arquitetura

MVC no nível da aplicação, com o acesso ao store e à autenticação isolados por Ports & Adapters.
`application/` e `domain/` não conhecem nenhum tipo do SDK da AWS.

```
src/
  middleware.ts     # no-store, Origin e Host em toda requisição
  pages/            # rotas Astro + /api/* (controllers HTTP)
  components/       # ilhas React
  application/      # use cases
  domain/           # modelo do parâmetro e do documento JSON, validação
  infrastructure/   # store, auth, backup, http — portas e adapters
```

Diagramas das camadas, o fluxo de uma gravação, o de um rollback e o contrato do
`ParameterStorePort` estão em [docs/architecture.md](docs/architecture.md).
