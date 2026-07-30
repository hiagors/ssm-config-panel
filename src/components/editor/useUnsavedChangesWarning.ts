import { useEffect } from 'react';

/**
 * Avisa antes de descartar um rascunho não salvo.
 *
 * Cobre fechar a aba, recarregar e **navegar para outra página** — inclusive
 * voltar para a tela inicial, que é onde se troca de profile. Como cada rota é
 * uma carga de página completa no Astro, um único `beforeunload` cobre os três
 * casos, e trocar de profile com rascunho pendente passa a pedir confirmação
 * sem precisar de um guarda separado.
 *
 * O texto não é nosso: navegadores modernos ignoram mensagem customizada e
 * mostram a própria, justamente para o site não conseguir enganar o usuário.
 * Só dá para dizer *que* há algo a perder, não *o quê*.
 */
export function useUnsavedChangesWarning(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) {
      return;
    }

    function onBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault();
      // Navegadores antigos exigiam `returnValue` preenchido para exibir o
      // diálogo. Inofensivo nos atuais, que usam o texto padrão deles.
      event.returnValue = '';
    }

    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [isDirty]);
}
