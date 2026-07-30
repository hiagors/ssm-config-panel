import { useEffect, useRef, useState } from 'react';
import type { JsonNode, JsonNodeKind } from '../../domain/json/JsonDocument.js';
import { hasContentToLose, kindLabel } from '../../domain/json/JsonDocument.js';
import Icon from './Icon.js';

/**
 * Menu de ações estruturais da linha.
 *
 * Converter para `objeto` ou `lista` mora aqui, e não no `<select>` de tipo, por
 * uma razão concreta: um clique errado num select é fácil demais para uma ação
 * que descarta conteúdo. O select ficou só com os escalares, onde a conversão
 * preserva o texto e a validação acusa o que ficou inválido.
 *
 * ── Quando pedir confirmação ────────────────────────────────────────────────
 *
 * Só quando há **perda real**: valor não vazio, ou filhos existentes. `""` →
 * objeto não abre diálogo, `null` → lista não abre diálogo, objeto vazio →
 * texto não abre diálogo. Confirmar operação inócua ensina a clicar em "sim"
 * sem ler, e aí a confirmação que importa também passa batida.
 */

interface Props {
  readonly node: JsonNode;
  readonly label: string;
  readonly dottedPath: string;
  readonly onConvert: (kind: JsonNodeKind) => void;
  readonly onRemove: () => void;
}

/** Alvos de conversão oferecidos: os containers e a volta para texto. */
const CONVERSION_TARGETS: readonly JsonNodeKind[] = ['object', 'array', 'string'];

export default function RowKebabMenu({
  node,
  label,
  dottedPath,
  onConvert,
  onRemove,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pendingKind, setPendingKind] = useState<JsonNodeKind | undefined>(undefined);
  const container = useRef<HTMLDivElement | null>(null);

  // Fecha ao clicar fora ou no Escape. Sem isso o menu fica preso aberto e
  // rouba o clique da próxima linha.
  useEffect(() => {
    if (!open) {
      return;
    }

    function onPointerDown(event: MouseEvent): void {
      if (container.current !== null && !container.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }

    window.document.addEventListener('mousedown', onPointerDown);
    window.document.addEventListener('keydown', onKeyDown);

    return () => {
      window.document.removeEventListener('mousedown', onPointerDown);
      window.document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function requestConversion(kind: JsonNodeKind): void {
    setOpen(false);

    if (hasContentToLose(node)) {
      setPendingKind(kind);
      return;
    }

    // Nada a perder: converte direto.
    onConvert(kind);
  }

  const targets = CONVERSION_TARGETS.filter((kind) => kind !== node.kind);

  return (
    <div className="kebab-wrapper" ref={container}>
      <button
        type="button"
        className="row-action kebab-trigger"
        aria-label={`Mais ações para ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="kebab" size={14} />
      </button>

      {open && (
        <div className="kebab-menu" role="menu">
          <p className="kebab-path" title={dottedPath}>
            {dottedPath === '' ? '(raiz)' : dottedPath}
          </p>

          {targets.map((kind) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              className="kebab-item"
              onClick={() => requestConversion(kind)}
            >
              Converter em {kindLabel(kind)}
            </button>
          ))}

          <button
            type="button"
            role="menuitem"
            className="kebab-item danger"
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
          >
            Remover
          </button>
        </div>
      )}

      {pendingKind !== undefined && (
        <ConversionConfirm
          node={node}
          label={label}
          targetKind={pendingKind}
          onCancel={() => setPendingKind(undefined)}
          onConfirm={() => {
            const kind = pendingKind;
            setPendingKind(undefined);
            onConvert(kind);
          }}
        />
      )}
    </div>
  );
}

/** Diálogo de confirmação. Só aparece quando há conteúdo a perder de fato. */
function ConversionConfirm({
  node,
  label,
  targetKind,
  onCancel,
  onConfirm,
}: {
  readonly node: JsonNode;
  readonly label: string;
  readonly targetKind: JsonNodeKind;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <div className="convert-confirm" role="alertdialog" aria-label={`Converter ${label}`}>
      <p>
        Converter <code>{label}</code> em <strong>{kindLabel(targetKind)}</strong>{' '}
        {describeLoss(node)}
      </p>
      <div className="convert-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          Cancelar
        </button>
        <button type="button" className="secondary danger-action" onClick={onConfirm}>
          Converter e descartar
        </button>
      </div>
    </div>
  );
}

/** Diz exatamente o que se perde, em vez de um "tem certeza?" genérico. */
function describeLoss(node: JsonNode): string {
  if (node.kind === 'object') {
    const count = node.entries.length;
    return `descarta ${count} ${count === 1 ? 'campo' : 'campos'}.`;
  }

  if (node.kind === 'array') {
    const count = node.items.length;
    return `descarta ${count} ${count === 1 ? 'item' : 'itens'}.`;
  }

  return 'descarta o valor atual.';
}
