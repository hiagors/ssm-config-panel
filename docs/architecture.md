# Arquitetura

MVC no nível da aplicação, com o acesso ao store e à autenticação isolados por
**Ports & Adapters**. A regra que sustenta tudo: `application/` e `domain/` não
conhecem nenhum tipo do SDK da AWS.

## Camadas

```mermaid
flowchart TB
  subgraph browser["Browser (loopback)"]
    island["Ilhas React<br/>editor, seletor de profile"]
  end

  subgraph server["Servidor Astro (127.0.0.1)"]
    mw["middleware.ts<br/><i>no-store · Origin · Host</i>"]

    subgraph pages["pages/"]
      view[".astro (views)"]
      api["/api/* (controllers)"]
    end

    subgraph app["application/"]
      uc["use cases<br/>Get · Save · ListProfiles · validate"]
    end

    subgraph dom["domain/"]
      model["Parameter · AwsProfile · errors"]
      json["json/<br/>parser com spans · serializador<br/>operações · diff estrutural"]
    end

    subgraph infra["infrastructure/"]
      store["store/<br/>ParameterStorePort"]
      auth["auth/<br/>SsoAuthPort"]
      backup["backup/<br/>BackupPort"]
      http["http/<br/>noStore · csrf"]
    end
  end

  subgraph out["Fora do processo"]
    ssm[("AWS SSM")]
    files[("./.local-store")]
    baks[("./.backups")]
    awscfg[("~/.aws")]
  end

  island -->|"fetch<br/>?profile="| mw
  view --> mw
  mw --> pages
  api --> uc
  view --> uc
  uc --> dom
  uc --> store
  uc --> backup
  api --> auth

  store -.->|implementa| ssm
  store -.->|implementa| files
  backup --> baks
  auth --> awscfg
  auth --> ssm

  classDef port fill:#1d2430,stroke:#5aa9ff
  class store,auth,backup,http port
```

A seta que **não** existe é tão importante quanto as que existem: nada em
`domain/` ou `application/` aponta para um adapter concreto. Só o *composition
root* em `infrastructure/store/index.ts` conhece as implementações.

## Fluxo de uma gravação

```mermaid
sequenceDiagram
  participant U as Editor (browser)
  participant M as middleware
  participant R as PUT /api/parameters/*
  participant S as SaveParameterUseCase
  participant B as BackupPort
  participant P as ParameterStorePort

  U->>M: PUT + Origin + ?profile=
  M->>M: Host e Origin confiáveis?
  M->>R: segue
  R->>S: {value, expectedVersion}
  S->>P: get(name)
  P-->>S: valor + versão atual
  S->>S: valida (JSON, chaves, tamanho)
  alt versão divergiu
    S-->>R: {outcome: 'conflict', currentValue}
    R-->>U: 409 + diff de três vias
  else parâmetro não existe
    S-->>R: {outcome: 'notFound'}
    R-->>U: 404 — nunca cria
  else tudo certo
    S->>B: save(versão anterior)
    alt backup falhou
      B-->>S: BackupFailedError
      S-->>U: 500 — nada foi alterado
    else backup gravado
      S->>P: put(expectedVersion)
      P->>P: checa versão de novo
      P-->>S: nova versão
      S-->>U: {outcome: 'saved', version}
    end
  end
```

Três ordens são obrigatórias e estão fixadas por teste:

1. **Origin e Host antes de qualquer rota.** A checagem de CSRF nasceu junto com
   a primeira rota mutante, nunca depois.
2. **Backup antes do `put`.** Um teste assere literalmente `['backup', 'put']`:
   verificar só o desfecho deixaria passar uma implementação que grava e copia
   depois.
3. **Describe antes do `PutParameter`**, no adapter da AWS. É o que impede criar
   por efeito colateral e sobrescrever às cegas de uma vez.

## Contrato do `ParameterStorePort`

```ts
interface ParameterStorePort {
  list(options?: ListOptions): Promise<ParameterMetadata[]>;
  get(name: string): Promise<Parameter>;
  put(name: string, value: string, options: PutOptions): Promise<PutResult>;
}
```

Nenhum tipo do SDK aparece aqui. Erros do fornecedor são traduzidos **dentro** do
adapter para `AppError`, e nenhuma mensagem crua do SDK atravessa — ela pode
embutir o valor da requisição.

### `list(options)`

Devolve **apenas metadados**, nunca valores: listar não deve carregar segredo
para a memória do servidor. No driver `local` enumera tudo; no `aws`, o
`pathPrefix` é **obrigatório** — varrer uma conta de produção é paginado, lento e
sujeito a throttling.

### `get(name)`

Devolve valor e metadados, com `SecureString` já decriptado e a `version`
corrente. A versão é o que alimenta a proteção contra lost update.

### `put(name, value, options)`

```ts
interface PutOptions {
  type: ParameterType;
  tier: ParameterTier;
  keyId?: string;
  description?: string;
  expectedVersion: number;   // obrigatório
}
```

`expectedVersion` é o campo que torna **estruturais** duas regras que, no use
case sozinho, seriam disciplina de quem chama:

| Valor | Contrato |
| --- | --- |
| `>= 1` | o parâmetro **tem** de existir e estar nessa versão |
| `0` (`EXPECT_NEW_PARAMETER`) | espera-se que **não** exista — criação deliberada |

O SSM não tem put condicional, mas devolve `Version`, e os dois adapters
comparam antes de gravar. `PutParameter` com `Overwrite: true` cria o parâmetro
quando ele não existe, e nesse caso não haveria original de onde herdar `Type`,
`Tier` e `KeyId` — daí exigir a existência.

**Limitação conhecida:** reler-comparar-gravar não é atômico. A janela cai do
tempo inteiro de edição para os milissegundos entre o re-read e a gravação, mas
não zera.

### O que o port **não** expõe

`history()` foi removido. O histórico ficou fora de escopo por decisão, e manter
um método que nenhum use case chama — implementado por dois adapters que só
devolveriam a versão atual — seria contrato mentindo sobre capacidade. O rollback
é coberto pelos backups em `./.backups`. Consequência direta:
`ssm:GetParameterHistory` saiu da política de IAM.

## Modelo do documento JSON

`JSON.parse` não serve como modelo do editor, e não é preferência de estilo:

| Entrada | `JSON.parse` devolve | O que se perde |
| --- | --- | --- |
| `{"timeout": 30.0}` | `{timeout: 30}` | int vs float, e o round-trip deixa de ser vazio |
| `{"2":"b","1":"a"}` | chaves reordenadas | a ordem original, que o spec exige preservar |
| `{"a":1,"a":2}` | `{a: 2}` | a duplicata, que a validação precisa acusar |

Então: parser de descida recursiva próprio, número guardado como **lexema**,
objeto como **lista ordenada** de entradas, e cada nó com o **span** no texto de
origem mais um flag `dirty`.

```mermaid
flowchart LR
  src["texto do store"] -->|parseJsonDocument| doc["JsonDocument<br/>root + source + style"]
  doc -->|operações puras| doc2["JsonDocument'"]
  doc2 -->|serializeJsonDocument| out["texto a gravar"]
  doc -->|prettyPrintDocument| pretty["texto só para a tela"]

  style pretty stroke-dasharray: 4
```

Subárvore com `dirty === false` é reemitida **verbatim** a partir de `source`. É
o que faz duas promessas serem literais:

- Round-trip sem edição produz texto byte-idêntico, logo diff vazio.
- Editar um campo não reformata os vizinhos.

O caminho pontilhado é o pretty-print: **não devolve documento**, devolve texto
que some quando o toggle desliga. Formatar de verdade marcaria tudo como `dirty`
e um save sem edição reescreveria o parâmetro inteiro.

**Nenhum caminho de número passa por `Number`, `parseFloat` ou `parseInt`.**
Validação é contra a gramática JSON; o input mantém string.

## Guardas transversais

Cada uma em um ponto único, com teste:

| Guarda | Onde | Por quê em ponto único |
| --- | --- | --- |
| `Cache-Control: no-store` | `middleware.ts` | um helper só de `/api/*` deixaria a página do editor cacheável, e ela carrega o valor no HTML |
| Origin + Host | `middleware.ts` → `http/csrf.ts` | loopback não é fronteira contra o browser: qualquer aba pode escrever, e DNS rebinding faz o Host parecer legítimo |
| Redação de erro | `pages/api/_http.ts` | allow-list: só `publicMessage` curada atravessa, na resposta **e** no log |
| Atributos anti-gerenciador de senha | `ValueInput.tsx` | um único input concentra `autocomplete="off"`, `data-1p-ignore`, `data-lpignore` |
| Sessão do Astro | `astro.config.mjs` | o adapter node liga storage em filesystem por padrão, o que conflita com "rascunho nunca em disco" |

## Estado no cliente

```mermaid
flowchart TB
  draft["useParameterDraft<br/><b>documento</b>"]
  tree["useTreeView<br/><b>visualização</b>"]

  draft -->|"base.text imutável"| diff["diff · isDirty · save"]
  tree -->|"expandido · escopo · busca"| grid["TreeGrid"]

  draft -.->|"nunca"| tree
  tree -.->|"nunca"| draft
```

Os dois estados são **separados de propósito**. Se expandido, escopo e busca
morassem no rascunho, abrir um nó marcaria o campo como `dirty`, apareceria no
diff, e um save "sem alterações" reescreveria o parâmetro.

`base.text` é snapshot imutável do texto carregado, guardado à parte e **nunca**
derivado dos spans do documento atual. Ir para a aba JSON cru e voltar reparseia
tudo e zera o `dirty` contra o texto novo — se a base viesse dali, o diff passaria
a mentir.
