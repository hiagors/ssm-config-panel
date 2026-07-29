#!/usr/bin/env bash
#
# Verifica que as ferramentas em uso são as pinadas no mise.toml.
#
# A checagem é de CAMINHO, não só de versão. O motivo é concreto: esta
# máquina tem `aws` 2.22 x86_64 em /usr/local/bin e Node 22 do Homebrew.
# Ambos "passariam" numa checagem de versão, e o projeto rodaria com
# ferramenta que não é a pinada — exatamente o que o mise.toml existe para
# evitar. Então exigimos que o binário resolvido esteja DENTRO do diretório
# de instalação do mise.

set -uo pipefail

RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
DIM=$'\033[2m'
RESET=$'\033[0m'

failures=0
# Preenchido por assert_from_mise. Global de propósito: usar substituição de
# comando criaria um subshell e o incremento de `failures` seria perdido.
RESOLVED_PATH=''

fail() {
  printf '%s✗%s %s\n' "$RED" "$RESET" "$1" >&2
  shift
  local line
  for line in "$@"; do
    printf '  %s%s%s\n' "$DIM" "$line" "$RESET" >&2
  done
  failures=$((failures + 1))
}

ok() {
  printf '%s✓%s %s\n' "$GREEN" "$RESET" "$1"
}

warn() {
  printf '%s!%s %s\n' "$YELLOW" "$RESET" "$1" >&2
}

# Caminho real, com symlinks e `..` resolvidos.
real_path_of() {
  local target="$1"
  printf '%s/%s\n' "$(cd "$(dirname "$target")" && pwd -P)" "$(basename "$target")"
}

# ─── mise ────────────────────────────────────────────────────────────────────

if ! command -v mise >/dev/null 2>&1; then
  fail 'mise não encontrado no PATH.' \
    'Instale com:  brew install mise' \
    'Depois ative no shell adicionando ao ~/.zshrc:' \
    '  eval "$(mise activate zsh)"'
  exit 1
fi

ok "mise $(mise --version | head -1)"

# Raiz de instalação do mise, derivada do próprio mise em vez de chutada.
# `mise where node` devolve <installs>/node/<versão>.
if ! node_install_dir="$(mise where node 2>/dev/null)"; then
  fail 'o Node pinado no mise.toml não está instalado.' \
    'Rode:  make setup'
  exit 1
fi

MISE_INSTALLS="$(dirname "$(dirname "$node_install_dir")")"

# ─── asserção central: o binário vem de dentro do mise ───────────────────────
#
# Resolvemos via `mise exec`, que é como todos os alvos do Makefile rodam.
# Se o resultado apontar para fora do diretório do mise, alguma coisa está
# sombreando a ferramenta pinada.
assert_from_mise() {
  local tool="$1" expected_subdir="$2"
  local resolved

  RESOLVED_PATH=''

  if ! resolved="$(mise exec -- sh -c "command -v ${tool}" 2>/dev/null)"; then
    fail "${tool} não foi encontrado nem dentro do ambiente do mise." \
      "Confirme que ${tool} está pinado no mise.toml e rode:  make setup"
    return 1
  fi

  local real
  real="$(real_path_of "$resolved")"

  if [[ "$real" != "$MISE_INSTALLS"/* ]]; then
    fail "${tool} resolve para FORA do diretório do mise." \
      "resolvido:   ${real}" \
      "esperado em: ${MISE_INSTALLS}/${expected_subdir}/..." \
      'Uma instalação global está sombreando a versão pinada no mise.toml.' \
      'Rode  make setup  e confirme o pin da ferramenta no mise.toml.'
    return 1
  fi

  RESOLVED_PATH="$real"
  return 0
}

# ─── Node ────────────────────────────────────────────────────────────────────

if assert_from_mise node node; then
  node_path="$RESOLVED_PATH"
  node_version="$(mise exec -- node --version)"
  ok "node ${node_version}  ${DIM}${node_path}${RESET}"

  node_major="${node_version#v}"
  node_major="${node_major%%.*}"
  if ((node_major < 24)); then
    fail "node ${node_version} é anterior ao exigido (24.x)." \
      'Ajuste o mise.toml e rode:  make setup'
  fi
fi

# npm vem junto com o Node do mise.
if assert_from_mise npm node; then
  ok "npm $(mise exec -- npm --version)  ${DIM}${RESOLVED_PATH}${RESET}"
fi

# ─── AWS CLI ─────────────────────────────────────────────────────────────────

if assert_from_mise aws aqua-aws-aws-cli; then
  aws_path="$RESOLVED_PATH"
  aws_version_line="$(mise exec -- aws --version 2>&1)"

  # Exige v2: o v1 tem CLI e formato de cache SSO diferentes.
  if [[ "$aws_version_line" != aws-cli/2.* ]]; then
    fail "é exigido AWS CLI v2, encontrado: ${aws_version_line}" \
      'Ajuste a versão pinada no mise.toml e rode:  make setup'
  else
    ok "aws ${aws_version_line%% *}  ${DIM}${aws_path}${RESET}"
  fi

  # A build do aqua para macOS extrai o .pkg oficial, que é binário
  # universal. Numa máquina arm64, cair na fatia x86_64 sob Rosetta indica
  # que o binário em uso não é o esperado.
  if [[ "$(uname -m)" == 'arm64' && "$aws_version_line" == *'exe/x86_64'* ]]; then
    warn "aws roda como x86_64 sob Rosetta nesta máquina arm64: ${aws_version_line}"
  fi
fi

# ─── sombreamento no PATH ────────────────────────────────────────────────────
#
# Aqui checamos o `command -v` do shell, sem `mise exec`. Os alvos do Makefile
# usam `mise exec` e portanto funcionariam de todo jeito, mas isto é falha e
# não aviso de propósito: com o mise inativo, qualquer comando digitado à mão
# — `aws sso login`, `node script.mjs`, `npx astro` — pega a ferramenta errada
# em silêncio. Numa máquina que tem aws 2.22 x86_64 em /usr/local/bin e Node
# 22 do Homebrew, é só questão de tempo.
for tool in node aws; do
  if ! shell_path="$(command -v "$tool" 2>/dev/null)"; then
    fail "${tool} não está no PATH do shell." \
      'Ative o mise no ~/.zshrc:  eval "$(mise activate zsh)"'
    continue
  fi

  shell_real="$(real_path_of "$shell_path")"

  # Aceita tanto o caminho de instalação (mise activate) quanto os shims
  # (mise activate --shims), que são as duas formas suportadas.
  if [[ "$shell_real" != "$MISE_INSTALLS"/* && "$shell_real" != *'/shims/'* ]]; then
    fail "no PATH do shell, \`${tool}\` resolve para FORA do mise." \
      "resolvido:   ${shell_real}" \
      "esperado em: ${MISE_INSTALLS}/... ou em um diretório de shims do mise" \
      'Ative o mise adicionando ao ~/.zshrc:' \
      '  eval "$(mise activate zsh)"' \
      'Depois abra um novo terminal (ou rode: exec zsh) e tente de novo.'
  fi
done

# ─── resultado ───────────────────────────────────────────────────────────────

if ((failures > 0)); then
  printf '\n%s%d verificação(ões) falharam.%s\n' "$RED" "$failures" "$RESET" >&2
  exit 1
fi

printf '\nTodas as dependências estão corretas.\n'
