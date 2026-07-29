import { describe, expect, it } from 'vitest';
import type { DraftAction, DraftState } from './useParameterDraft.js';
import { draftReducer, draftText, initialDraftState } from './useParameterDraft.js';
import {
  appendEntry,
  changeNodeKind,
  removeEntry,
  setNumberLexeme,
  setStringValue,
} from '../../domain/json/editOperations.js';

/**
 * O reducer é testado direto, sem renderizar React: toda a lógica de estado
 * está nele, e assim o teste não precisa de jsdom.
 */

const LOADED = '{\n  "a": 30.0,\n  "b": "texto"\n}';

function apply(state: DraftState, ...actions: readonly DraftAction[]): DraftState {
  return actions.reduce(draftReducer, state);
}

describe('invariante: a base é snapshot imutável do texto carregado', () => {
  it('base.text é exatamente o texto carregado', () => {
    const state = initialDraftState(LOADED, 4);

    expect(state.base.text).toBe(LOADED);
    expect(state.base.version).toBe(4);
  });

  it('editar no formulário não altera a base', () => {
    let state = initialDraftState(LOADED, 4);

    state = apply(
      state,
      { type: 'EDIT', apply: (document) => setNumberLexeme(document, [0], '99') },
      { type: 'EDIT', apply: (document) => setStringValue(document, [1], 'outro') },
      { type: 'EDIT', apply: (document) => appendEntry(document, [], 'c', 'boolean') },
    );

    expect(state.base.text).toBe(LOADED);
    expect(draftText(state)).not.toBe(LOADED);
  });

  it('editar a aba JSON cru não altera a base', () => {
    // Este é o caso que a invariante protege. Editar o JSON cru reparseia o
    // documento, e o documento novo passa a ter `source` igual ao texto
    // digitado, com todos os nós limpos. Se a base viesse de
    // `document.source`, ela passaria a ser o texto digitado e o diff daria
    // vazio — escondendo a alteração.
    let state = initialDraftState(LOADED, 4);

    state = apply(state, { type: 'SET_RAW', text: '{"totalmente":"diferente"}' });

    expect(state.base.text).toBe(LOADED);

    const document = state.content.kind === 'structured' ? state.content.document : undefined;

    // A prova de que os dois conceitos divergiram.
    expect(document?.source).toBe('{"totalmente":"diferente"}');
    expect(document?.source).not.toBe(state.base.text);
  });

  it('a base sobrevive a uma sequência longa e mista de edições', () => {
    let state = initialDraftState(LOADED, 4);

    state = apply(
      state,
      { type: 'EDIT', apply: (document) => setNumberLexeme(document, [0], '1') },
      { type: 'SELECT_TAB', tab: 'raw' },
      { type: 'SET_RAW', text: '{"x":1}' },
      { type: 'SET_RAW', text: '{"x":1,' },
      { type: 'SET_RAW', text: '{"x":1,"y":2}' },
      { type: 'SELECT_TAB', tab: 'structured' },
      { type: 'EDIT', apply: (document) => appendEntry(document, [], 'z', 'null') },
      { type: 'EDIT', apply: (document) => removeEntry(document, [0]) },
    );

    expect(state.base.text).toBe(LOADED);
    expect(state.base.version).toBe(4);
  });

  it('isDirty é comparação textual contra a base, não contagem de spans sujos', () => {
    let state = initialDraftState(LOADED, 4);

    // Ida e volta: edita e desfaz manualmente. Os spans ficam sujos, mas o
    // texto voltou a ser o da base — então não há rascunho pendente.
    state = apply(
      state,
      { type: 'EDIT', apply: (document) => setNumberLexeme(document, [0], '99') },
      { type: 'EDIT', apply: (document) => setNumberLexeme(document, [0], '30.0') },
    );

    const document = state.content.kind === 'structured' ? state.content.document : undefined;

    expect(document?.root.dirty).toBe(true);
    expect(draftText(state)).toBe(LOADED);
  });
});

describe('round-trip sem edição', () => {
  it('draftText devolve o texto carregado byte a byte', () => {
    const state = initialDraftState(LOADED, 1);

    expect(draftText(state)).toBe(LOADED);
  });

  it('vale para JSON minificado', () => {
    const minified = '{"a":1,"b":[1,2,{"c":30.0}]}';

    expect(draftText(initialDraftState(minified, 1))).toBe(minified);
  });

  it('descartar volta exatamente para a base', () => {
    let state = initialDraftState(LOADED, 1);

    state = apply(
      state,
      { type: 'EDIT', apply: (document) => appendEntry(document, [], 'novo', 'string') },
      { type: 'DISCARD' },
    );

    expect(draftText(state)).toBe(LOADED);
  });
});

describe('sincronização entre as abas', () => {
  it('JSON válido no cru volta a habilitar o formulário', () => {
    let state = initialDraftState(LOADED, 1);

    state = apply(state, { type: 'SET_RAW', text: '{"ok":true}' });

    expect(state.content.kind).toBe('structured');
  });

  it('JSON inválido no cru preserva o texto e explica o motivo', () => {
    let state = initialDraftState(LOADED, 1);

    state = apply(state, { type: 'SET_RAW', text: '{"quebrado":' });

    expect(state.content.kind).toBe('rawInvalid');
    expect(state.content.kind === 'rawInvalid' && state.content.text).toBe('{"quebrado":');
    expect(state.content.kind === 'rawInvalid' && state.content.error.message).toMatch(/linha/);
  });

  it('não deixa voltar ao formulário com JSON inválido', () => {
    let state = initialDraftState(LOADED, 1);

    state = apply(
      state,
      { type: 'SELECT_TAB', tab: 'raw' },
      { type: 'SET_RAW', text: 'nao e json' },
      { type: 'SELECT_TAB', tab: 'structured' },
    );

    expect(state.tab).toBe('raw');
  });

  it('digitar até voltar a ser válido recupera o formulário sem perder nada', () => {
    let state = initialDraftState(LOADED, 1);

    state = apply(
      state,
      { type: 'SET_RAW', text: '{"a"' },
      { type: 'SET_RAW', text: '{"a":' },
      { type: 'SET_RAW', text: '{"a":1' },
      { type: 'SET_RAW', text: '{"a":1}' },
    );

    expect(state.content.kind).toBe('structured');
    expect(draftText(state)).toBe('{"a":1}');
  });

  it('valor que não é JSON começa em rawInvalid', () => {
    const state = initialDraftState('isto nao e json { mesmo', 1);

    expect(state.content.kind).toBe('rawInvalid');
  });

  it('edição no formulário aparece no texto do cru', () => {
    let state = initialDraftState('{"a":1}', 1);

    state = apply(state, {
      type: 'EDIT',
      apply: (document) => setNumberLexeme(document, [0], '2'),
    });

    expect(draftText(state)).toBe('{"a":2}');
  });
});

describe('estado de revelação', () => {
  it('começa tudo oculto', () => {
    const state = initialDraftState('{"a":"x"}', 1);

    expect(state.revealAll).toBe(false);
    expect(state.revealedPaths.size).toBe(0);
  });

  it('revelar tudo liga o flag global', () => {
    const state = apply(initialDraftState('{"a":"x"}', 1), { type: 'TOGGLE_REVEAL_ALL' });

    expect(state.revealAll).toBe(true);
  });

  it('ocultar tudo derruba também as revelações individuais', () => {
    // Senão "ocultar tudo" deixaria linhas visíveis, e o critério de
    // compartilhar tela não valeria.
    let state = initialDraftState('{"a":"x","b":"y"}', 1);

    state = apply(
      state,
      { type: 'TOGGLE_REVEAL_PATH', path: [0] },
      { type: 'TOGGLE_REVEAL_PATH', path: [1] },
      { type: 'TOGGLE_REVEAL_ALL' },
      { type: 'TOGGLE_REVEAL_ALL' },
    );

    expect(state.revealAll).toBe(false);
    expect(state.revealedPaths.size).toBe(0);
  });

  it('revelar individual alterna', () => {
    let state = initialDraftState('{"a":"x"}', 1);

    state = apply(state, { type: 'TOGGLE_REVEAL_PATH', path: [0] });
    expect(state.revealedPaths.has('0')).toBe(true);

    state = apply(state, { type: 'TOGGLE_REVEAL_PATH', path: [0] });
    expect(state.revealedPaths.has('0')).toBe(false);
  });

  it('revelação não entra no texto do rascunho', () => {
    // Nada de estado de UI contaminando o que seria gravado.
    const revealed = apply(initialDraftState('{"a":"x"}', 1), { type: 'TOGGLE_REVEAL_ALL' });

    expect(draftText(revealed)).toBe('{"a":"x"}');
  });
});

describe('troca de tipo pelo seletor', () => {
  it('null para string dá string vazia, e o texto muda', () => {
    let state = initialDraftState('{"a":null}', 1);

    state = apply(state, {
      type: 'EDIT',
      apply: (document) => changeNodeKind(document, [0], 'string'),
    });

    expect(draftText(state)).toBe('{"a":""}');
  });

  it('string vazia para null dá null, e o texto muda', () => {
    let state = initialDraftState('{"a":""}', 1);

    state = apply(state, {
      type: 'EDIT',
      apply: (document) => changeNodeKind(document, [0], 'null'),
    });

    expect(draftText(state)).toBe('{"a":null}');
  });
});
