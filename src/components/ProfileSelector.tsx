import { useCallback, useEffect, useRef, useState } from 'react';
import type { AwsProfile } from '../domain/AwsProfile.js';
import {
  isReadyToUse,
  needsLogin,
  profileKindLabel,
  sessionStateLabel,
} from '../domain/AwsProfile.js';

/**
 * Seletor de profile e disparo de login SSO.
 *
 * Duas coisas que a tela precisa comunicar sem ambiguidade:
 *
 * 1. **Profile de chave estática não é equivalente a profile SSO.** Aparece na
 *    lista — esconder faria quem procura `default` concluir que a ferramenta
 *    está quebrada — mas desabilitado, com o motivo escrito. Operar produção
 *    sob uma identidade de longa duração que a tela não sabe nomear é o erro
 *    que isto evita.
 *
 * 2. **Qual identidade está em uso.** Conta e role ficam visíveis o tempo todo.
 *    Nenhum dos dois é segredo, e sem eles não há como saber onde a gravação
 *    vai cair.
 */

interface Props {
  readonly initialProfiles: readonly AwsProfile[];
  readonly initialPreselected: string | undefined;
  readonly selected: string | undefined;
  readonly onSelect: (profileName: string) => void;
  /** Chamado quando o login termina, para a página recarregar o que precisa. */
  readonly onAuthenticated?: (profileName: string) => void;
}

type LoginPhase =
  | { readonly phase: 'idle' }
  | { readonly phase: 'awaitingBrowser'; readonly profileName: string }
  | { readonly phase: 'failed'; readonly message: string };

/** Intervalo do polling enquanto o navegador está aberto no login. */
const POLL_INTERVAL_MILLIS = 1500;

export default function ProfileSelector({
  initialProfiles,
  initialPreselected,
  selected,
  onSelect,
  onAuthenticated,
}: Props) {
  const [profiles, setProfiles] = useState<readonly AwsProfile[]>(initialProfiles);
  const [login, setLogin] = useState<LoginPhase>({ phase: 'idle' });
  const pollTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const current = profiles.find((profile) => profile.name === selected);
  const usable = profiles.filter((profile) => profile.selectable);

  const refresh = useCallback(async (): Promise<readonly AwsProfile[]> => {
    const response = await fetch('/api/profiles', { credentials: 'same-origin' });

    if (!response.ok) {
      return profiles;
    }

    const body = (await response.json()) as { profiles?: readonly AwsProfile[] };
    const fresh = body.profiles ?? [];

    setProfiles(fresh);

    return fresh;
  }, [profiles]);

  // Para o polling ao desmontar, senão continua batendo depois de sair da tela.
  useEffect(() => {
    return () => {
      if (pollTimer.current !== undefined) {
        clearInterval(pollTimer.current);
      }
    };
  }, []);

  async function authenticate(profileName: string): Promise<void> {
    setLogin({ phase: 'awaitingBrowser', profileName });

    // Enquanto o `aws sso login` roda, a sessão pode ficar válida antes de o
    // comando terminar. O polling detecta isso e a UI reage sem esperar.
    pollTimer.current = setInterval(() => {
      void refresh().then((fresh) => {
        const updated = fresh.find((profile) => profile.name === profileName);

        if (updated !== undefined && isReadyToUse(updated)) {
          if (pollTimer.current !== undefined) {
            clearInterval(pollTimer.current);
            pollTimer.current = undefined;
          }
          setLogin({ phase: 'idle' });
          onAuthenticated?.(profileName);
        }
      });
    }, POLL_INTERVAL_MILLIS);

    let message: string | undefined;

    try {
      const response = await fetch('/api/profiles/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ profileName }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => undefined)) as
          | { error?: { message?: string } }
          | undefined;
        message = body?.error?.message ?? `O login falhou (HTTP ${response.status}).`;
      }
    } catch {
      message = 'Não foi possível falar com o servidor para iniciar o login.';
    }

    if (pollTimer.current !== undefined) {
      clearInterval(pollTimer.current);
      pollTimer.current = undefined;
    }

    const fresh = await refresh();
    const updated = fresh.find((profile) => profile.name === profileName);

    if (updated !== undefined && isReadyToUse(updated)) {
      setLogin({ phase: 'idle' });
      onAuthenticated?.(profileName);
      return;
    }

    setLogin({
      phase: 'failed',
      message: message ?? 'O login terminou, mas a sessão continua inválida.',
    });
  }

  return (
    <div className="profile-selector">
      <label htmlFor="profile">Profile da AWS</label>

      {usable.length === 0 ? (
        <p className="notice error">
          Nenhum profile SSO encontrado em <code>~/.aws/config</code>. Esta ferramenta só opera com
          SSO — configure um profile com <code>sso_session</code> ou <code>sso_start_url</code>.
        </p>
      ) : (
        <select
          id="profile"
          className="type-selector profile-select"
          value={selected ?? initialPreselected ?? ''}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="" disabled>
            escolha um profile…
          </option>
          {profiles.map((profile) => (
            <option key={profile.name} value={profile.name} disabled={!profile.selectable}>
              {profile.name} · {profileKindLabel(profile.kind)}
              {profile.selectable ? ` · ${sessionStateLabel(profile.sessionState)}` : ' · bloqueado'}
            </option>
          ))}
        </select>
      )}

      {current !== undefined && (
        <div className="profile-detail">
          <div className="badges">
            <span className="badge">
              conta <strong>{current.accountId ?? '—'}</strong>
            </span>
            <span className="badge">
              role <strong>{current.roleName ?? '—'}</strong>
            </span>
            <span className="badge">
              região <strong>{current.region ?? '—'}</strong>
            </span>
            <span
              className={`badge ${current.sessionState === 'valid' ? 'session-ok' : 'session-bad'}`}
            >
              {sessionStateLabel(current.sessionState)}
              {current.sessionState === 'valid' && current.expiresAt !== undefined && (
                <strong> até {formatExpiry(current.expiresAt)}</strong>
              )}
            </span>
          </div>

          {current.blockedReason !== undefined && (
            <p className="notice error">{current.blockedReason}</p>
          )}

          {needsLogin(current) && login.phase !== 'awaitingBrowser' && (
            <div className="profile-login">
              <p className="muted">
                {current.sessionState === 'expired'
                  ? 'A sessão deste profile expirou.'
                  : 'Este profile nunca foi autenticado nesta máquina.'}{' '}
                Autenticar abre o navegador padrão.
              </p>
              <button type="button" onClick={() => void authenticate(current.name)}>
                Autenticar {current.name}
              </button>
            </div>
          )}

          {login.phase === 'awaitingBrowser' && (
            <p className="notice">
              Abrindo o navegador para autenticar <code>{login.profileName}</code>. Conclua o login
              e volte aqui — a tela detecta sozinha. Se o navegador não abriu, a URL e o código
              estão no terminal onde o servidor está rodando.
            </p>
          )}

          {login.phase === 'failed' && <p className="notice error">{login.message}</p>}
        </div>
      )}
    </div>
  );
}

/** Só hora e minuto: a data completa não acrescenta nada num token de horas. */
function formatExpiry(isoDate: string): string {
  const parsed = new Date(isoDate);

  if (Number.isNaN(parsed.getTime())) {
    return isoDate;
  }

  return parsed.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
