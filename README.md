# SSM Config Panel

Ferramenta web **local** para visualizar, validar e editar parâmetros JSON no AWS SSM Parameter
Store. Roda na sua máquina, em loopback, e substitui a edição de JSON cru no console da AWS.

> **Estado atual: Fase 1 concluída.** O app sobe, tem hot reload e lê parâmetros ponta a ponta pelo
> `LocalFileStoreAdapter`. É **somente leitura** — o editor de chave-valor é a Fase 2 e o acesso ao
> SSM real é a Fase 3. Veja [Roadmap](#roadmap).

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
- Toda resposta da API sai com `Cache-Control: no-store`, para o browser não persistir valor em
  cache de disco.
- Erros são **redigidos por padrão**: só mensagens curadas no domínio atravessam a fronteira HTTP.
  Mensagem de erro de biblioteca, `cause` e stack trace nunca chegam ao browser nem ao log do
  servidor. Isso é testado com valor sentinela em
  [src/pages/api/\_http.test.ts](src/pages/api/_http.test.ts) — inclusive contra o vazamento por
  `JSON.parse`, cuja mensagem nativa embute um trecho do texto de entrada.
- `SecureString` chega à UI mascarado, com botão explícito de revelar por campo.
- Rascunho nunca é escrito em `localStorage` nem em arquivo temporário.

## Limitações conhecidas

- **Somente leitura.** Não há caminho de gravação exposto na UI: gravar sem diff violaria o
  critério de "nunca salvar por acidente".
- **Sem driver AWS.** `STORE_DRIVER=aws` falha com erro explícito.
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
- [ ] **Fase 2** — editor de chave-valor com aninhamento, arrays, tipos, validação e diff.
- [ ] **Fase 3** — seletor de profiles, autenticação SSO, `AwsSsmStoreAdapter`, `SecureString`.
- [ ] **Fase 4** — histórico, backup, testes de aceitação e documentação (`docs/architecture.md`,
      `docs/iam-policy.json`).

### Critérios de aceitação (a validar ao fim da Fase 4)

- [ ] Abrir, editar e salvar um parâmetro em menos de 5 interações a partir da tela inicial.
- [ ] Nunca salvar por acidente: toda gravação passa por diff + confirmação.
- [ ] JSON aninhado de 3 níveis editável sem tocar em texto cru.
- [ ] Sessão SSO expirando no meio da edição não faz perder o que foi digitado.
- [ ] Trocar de profile com rascunho pendente sempre pede confirmação.
- [ ] Round-trip de um parâmetro sem alterações produz diff vazio.
- [x] Erros da AWS aparecem com mensagem acionável, não com stack trace. *(mecanismo pronto na
      Fase 1; os erros da AWS em si entram na Fase 3.)*
