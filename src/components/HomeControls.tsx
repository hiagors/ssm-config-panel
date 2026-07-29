import { useState } from 'react';
import type { AwsProfile } from '../domain/AwsProfile.js';
import type { ParameterMetadata } from '../domain/Parameter.js';
import ProfileSelector from './ProfileSelector.js';

/**
 * Controles da tela inicial.
 *
 * No driver `aws` o fluxo tem uma etapa a mais que no local: escolher o
 * profile, garantir sessão válida, e só então buscar. A busca é **por prefixo**,
 * não listagem completa — `DescribeParameters` contra uma conta de produção é
 * paginado e sujeito a throttling, e ninguém quer esperar por uma varredura ao
 * abrir a ferramenta.
 */

interface Props {
  readonly driver: 'local' | 'aws';
  readonly initialProfiles: readonly AwsProfile[];
  readonly initialPreselected: string | undefined;
  readonly localParameters: readonly ParameterMetadata[];
  readonly localListError: string | undefined;
}

type SearchState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'searching' }
  | { readonly phase: 'done'; readonly parameters: readonly ParameterMetadata[] }
  | { readonly phase: 'failed'; readonly message: string };

export default function HomeControls({
  driver,
  initialProfiles,
  initialPreselected,
  localParameters,
  localListError,
}: Props) {
  const [profile, setProfile] = useState<string | undefined>(initialPreselected);
  const [prefix, setPrefix] = useState('');
  const [search, setSearch] = useState<SearchState>({ phase: 'idle' });
  const [name, setName] = useState('');

  const needsProfile = driver === 'aws';
  const readyToOperate = !needsProfile || profile !== undefined;

  function openParameter(rawName: string): void {
    const trimmed = rawName.trim();

    if (trimmed === '') {
      return;
    }

    const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    const query = profile === undefined ? '' : `?profile=${encodeURIComponent(profile)}`;

    window.location.href = `/parameters${normalized}${query}`;
  }

  async function runSearch(): Promise<void> {
    const trimmed = prefix.trim();

    if (trimmed === '') {
      setSearch({ phase: 'failed', message: 'Informe um prefixo de path, por exemplo /prod.' });
      return;
    }

    setSearch({ phase: 'searching' });

    const params = new URLSearchParams({ prefix: trimmed.startsWith('/') ? trimmed : `/${trimmed}` });

    if (profile !== undefined) {
      params.set('profile', profile);
    }

    try {
      const response = await fetch(`/api/parameters?${params.toString()}`, {
        credentials: 'same-origin',
      });
      const body = (await response.json()) as {
        parameters?: readonly ParameterMetadata[];
        error?: { message?: string };
      };

      if (!response.ok) {
        setSearch({
          phase: 'failed',
          message: body.error?.message ?? `A busca falhou (HTTP ${response.status}).`,
        });
        return;
      }

      setSearch({ phase: 'done', parameters: body.parameters ?? [] });
    } catch {
      setSearch({ phase: 'failed', message: 'Não foi possível falar com o servidor.' });
    }
  }

  return (
    <div className="home-controls">
      {needsProfile && (
        <div className="panel">
          <ProfileSelector
            initialProfiles={initialProfiles}
            initialPreselected={initialPreselected}
            selected={profile}
            onSelect={setProfile}
            onAuthenticated={(authenticated) => {
              setProfile(authenticated);
              setSearch({ phase: 'idle' });
            }}
          />
        </div>
      )}

      <div className="panel" style={{ marginTop: needsProfile ? '1rem' : 0 }}>
        <label htmlFor="name">Name do parameter</label>
        <div className="row">
          <input
            type="text"
            id="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                openParameter(name);
              }
            }}
            placeholder="/prod/billing/env"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={!readyToOperate}
          />
          <button type="button" disabled={!readyToOperate} onClick={() => openParameter(name)}>
            Abrir
          </button>
        </div>
        <p className="muted hint">
          Precisa começar com <code>/</code>. Letras, números, ponto, hífen e underscore.
          {needsProfile && profile === undefined && ' Escolha um profile antes.'}
        </p>
      </div>

      {needsProfile ? (
        <div className="panel" style={{ marginTop: '1rem' }}>
          <label htmlFor="prefix">Buscar por prefixo de path</label>
          <div className="row">
            <input
              type="text"
              id="prefix"
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void runSearch();
                }
              }}
              placeholder="/prod"
              autoComplete="off"
              spellCheck={false}
              disabled={!readyToOperate}
            />
            <button
              type="button"
              className="secondary"
              disabled={!readyToOperate || search.phase === 'searching'}
              onClick={() => void runSearch()}
            >
              {search.phase === 'searching' ? 'Buscando…' : 'Buscar'}
            </button>
          </div>
          <p className="muted hint">
            Contra o SSM real a busca é sempre por prefixo: varrer a conta inteira é paginado, lento
            e sujeito a throttling. A busca traz só metadados — nenhum valor.
          </p>

          {search.phase === 'failed' && <p className="notice error">{search.message}</p>}

          {search.phase === 'done' && (
            <ParameterList parameters={search.parameters} profile={profile} showTier />
          )}
        </div>
      ) : (
        <div className="panel" style={{ marginTop: '1rem' }}>
          <label>No store local ({localParameters.length})</label>
          {localListError !== undefined && <p className="notice error">{localListError}</p>}
          {localListError === undefined && localParameters.length === 0 && (
            <p className="notice">
              O store local está vazio. Rode <code>make seed</code> para criar{' '}
              <code>/example/demo/env</code>.
            </p>
          )}
          <ParameterList parameters={localParameters} profile={undefined} showTier />
        </div>
      )}
    </div>
  );
}

function ParameterList({
  parameters,
  profile,
  showTier,
}: {
  readonly parameters: readonly ParameterMetadata[];
  readonly profile: string | undefined;
  readonly showTier: boolean;
}) {
  if (parameters.length === 0) {
    return <p className="muted hint">Nenhum parâmetro.</p>;
  }

  const query = profile === undefined ? '' : `?profile=${encodeURIComponent(profile)}`;

  return (
    <ul className="parameters">
      {parameters.map((parameter) => (
        <li key={parameter.name}>
          <a href={`/parameters${parameter.name}${query}`}>{parameter.name}</a>
          <span className="muted list-meta">
            {parameter.type}
            {showTier && ` · ${parameter.tier}`} · v{parameter.version}
          </span>
        </li>
      ))}
    </ul>
  );
}
