import { useState } from 'react';

/**
 * Expiração de token é **estado de primeira classe**, não erro.
 *
 * O token do SSO dura poucas horas, e expirar no meio de uma edição é rotina.
 * Uma tela de erro ali custaria caro sem motivo: o rascunho vive no estado do
 * React desta página e não foi perdido — só a credencial venceu.
 *
 * Por isso o banner é **não-bloqueante**: o editor continua utilizável atrás
 * dele, e reautenticar acontece sem recarregar a página. Ao terminar, o usuário
 * volta exatamente de onde parou, com o diff pendente intacto.
 */

interface Props {
  readonly profileName: string | undefined;
  /** Chamado quando a sessão volta a ser válida. */
  readonly onReauthenticated: () => void;
}

type Phase =
  | { readonly phase: 'idle' }
  | { readonly phase: 'authenticating' }
  | { readonly phase: 'failed'; readonly message: string };

const POLL_INTERVAL_MILLIS = 1500;
const POLL_ATTEMPTS = 80;

export default function SessionExpiredBanner({ profileName, onReauthenticated }: Props) {
  const [state, setState] = useState<Phase>({ phase: 'idle' });

  async function reauthenticate(): Promise<void> {
    if (profileName === undefined) {
      setState({
        phase: 'failed',
        message: 'Não há profile associado a esta página. Volte à tela inicial.',
      });
      return;
    }

    setState({ phase: 'authenticating' });

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

        setState({
          phase: 'failed',
          message: body?.error?.message ?? `O login falhou (HTTP ${response.status}).`,
        });
        return;
      }
    } catch {
      setState({
        phase: 'failed',
        message: 'Não foi possível falar com o servidor para iniciar o login.',
      });
      return;
    }

    if (await waitForValidSession(profileName)) {
      setState({ phase: 'idle' });
      onReauthenticated();
      return;
    }

    setState({
      phase: 'failed',
      message: 'O login terminou, mas a sessão continua inválida. Tente de novo.',
    });
  }

  return (
    <div className="session-banner" role="status">
      <div className="session-banner-text">
        <strong>A sessão do SSO expirou.</strong> Nada do que você editou foi perdido — o rascunho
        continua nesta página. Reautentique e salve de novo.
      </div>

      {state.phase === 'authenticating' ? (
        <span className="muted">Abrindo o navegador…</span>
      ) : (
        <button type="button" onClick={() => void reauthenticate()}>
          Reautenticar{profileName === undefined ? '' : ` ${profileName}`}
        </button>
      )}

      {state.phase === 'failed' && <p className="notice error">{state.message}</p>}
    </div>
  );
}

/** Faz polling em `/api/profiles` até a sessão do profile ficar válida. */
async function waitForValidSession(profileName: string): Promise<boolean> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch('/api/profiles', { credentials: 'same-origin' });

      if (response.ok) {
        const body = (await response.json()) as {
          profiles?: readonly { name: string; sessionState: string }[];
        };

        const profile = body.profiles?.find((candidate) => candidate.name === profileName);

        if (profile?.sessionState === 'valid') {
          return true;
        }
      }
    } catch {
      // Servidor momentaneamente indisponível não encerra a espera.
    }

    await delay(POLL_INTERVAL_MILLIS);
  }

  return false;
}

function delay(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis));
}
