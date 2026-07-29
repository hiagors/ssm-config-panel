import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseJsonDocument } from '../../domain/json/parseJsonDocument.js';
import { serializeJsonDocument } from '../../domain/json/serializeJsonDocument.js';
import { validateDocument } from '../../application/validation/validateDocument.js';
import { draftReducer, draftText, initialDraftState } from './useParameterDraft.js';

/**
 * Guarda da fronteira servidor/browser.
 *
 * Existe por causa de um bug real: `valueSizeInBytes` usava
 * `Buffer.byteLength`, que só existe no Node. A validação roda dentro da ilha
 * React, a cada tecla, então a página quebrava na hidratação com
 * `ReferenceError: Buffer is not defined` — o formulário aparecia por um
 * instante (vindo do SSR) e desaparecia quando o React desmontava a árvore.
 *
 * Nenhum teste pegou isso porque o Vitest roda em Node, onde `Buffer` existe,
 * e as verificações ponta a ponta eram por `curl`, que só vê o HTML do SSR e
 * nunca a ilha hidratada.
 *
 * A defesa aqui tem duas partes: exercitar o código sem `Buffer` no escopo
 * global, e caminhar o grafo de imports de verdade a partir da ilha, para que
 * um import novo que arraste API só-de-Node falhe no teste em vez de falhar no
 * browser.
 */

// ─── parte 1: executar sem as globais do Node ───────────────────────────────

describe('o código da ilha roda sem as globais do Node', () => {
  const LOADED = '{"a":30.0,"b":"texto","c":[1,2,{"d":null}]}';

  it('validateDocument funciona sem Buffer', () => {
    vi.stubGlobal('Buffer', undefined);

    try {
      const result = parseJsonDocument(LOADED);
      expect(result.ok).toBe(true);

      const validation = validateDocument(
        result.ok ? result.document : (undefined as never),
        'Standard',
      );

      expect(validation.sizeInBytes).toBe(LOADED.length);
      expect(validation.canSave).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('conta bytes UTF-8 sem Buffer, não caracteres', () => {
    vi.stubGlobal('Buffer', undefined);

    try {
      const source = '{"a":"çãé"}';
      const result = parseJsonDocument(source);

      const validation = validateDocument(
        result.ok ? result.document : (undefined as never),
        'Standard',
      );

      // 3 acentuados = 6 bytes; 8 do resto.
      expect(validation.sizeInBytes).toBe(14);
      expect(validation.sizeInBytes).not.toBe(source.length);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('parse, serialize e o reducer do rascunho funcionam sem Buffer', () => {
    vi.stubGlobal('Buffer', undefined);

    try {
      let state = initialDraftState(LOADED, 1);

      expect(draftText(state)).toBe(LOADED);

      state = draftReducer(state, { type: 'SET_RAW', text: '{"x":9007199254740993}' });

      expect(draftText(state)).toBe('{"x":9007199254740993}');

      const reparsed = parseJsonDocument(draftText(state));
      expect(reparsed.ok && serializeJsonDocument(reparsed.document)).toBe(
        '{"x":9007199254740993}',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ─── parte 2: caminhar o grafo de imports da ilha ────────────────────────────

/** Ponto de entrada da ilha, o mesmo que o `.astro` monta com `client:load`. */
const ISLAND_ENTRY = 'src/components/editor/ParameterEditor.tsx';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');

/**
 * API que não existe no browser.
 *
 * `process` entra porque `import.meta.env` é o equivalente que funciona nos
 * dois lados; `node:` porque módulo nativo não é empacotável para o cliente.
 */
const NODE_ONLY_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'Buffer', pattern: /(?<![\w.])Buffer\s*\./ },
  { name: 'process', pattern: /(?<![\w.])process\s*\./ },
  { name: 'require()', pattern: /(?<![\w.])require\s*\(/ },
  { name: 'import de node:', pattern: /from\s+['"]node:/ },
  { name: '__dirname', pattern: /(?<![\w.])__dirname(?![\w])/ },
];

/**
 * Coleta os módulos do projeto alcançáveis em runtime a partir da ilha.
 *
 * Ignora `import type`, que é apagado na compilação e portanto não chega ao
 * browser — é o que permite a ilha declarar tipos vindos de `application/`
 * sem arrastar o código de lá.
 */
function collectRuntimeImports(entry: string): string[] {
  const visited = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.shift() as string;

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    let source: string;
    try {
      source = readFileSync(resolve(PROJECT_ROOT, current), 'utf8');
    } catch {
      continue;
    }

    for (const specifier of runtimeImportSpecifiers(source)) {
      if (!specifier.startsWith('.')) {
        // Dependência externa (react, etc.): fora do nosso controle e já
        // sabidamente compatível com browser.
        continue;
      }

      const resolved = resolveProjectModule(current, specifier);

      if (resolved !== undefined) {
        queue.push(resolved);
      }
    }
  }

  return [...visited];
}

function runtimeImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importStatement = /import\s+(type\s+)?([^'"]*?)from\s*['"]([^'"]+)['"]/g;

  for (const match of source.matchAll(importStatement)) {
    const isTypeOnly = match[1] !== undefined;
    const clause = match[2] ?? '';
    const specifier = match[3] as string;

    if (isTypeOnly) {
      continue;
    }

    // `import { type A, b }` traz `b` em runtime; `import { type A }` não.
    const named = clause.match(/\{([\s\S]*)\}/)?.[1];

    if (named !== undefined) {
      const hasRuntimeBinding = named
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .some((part) => !part.startsWith('type '));

      const hasDefaultOrNamespace = clause.replace(/\{[\s\S]*\}/, '').trim().replace(/,$/, '');

      if (!hasRuntimeBinding && hasDefaultOrNamespace === '') {
        continue;
      }
    }

    specifiers.push(specifier);
  }

  return specifiers;
}

/** Resolve `./x.js` para o `.ts`/`.tsx` correspondente no projeto. */
function resolveProjectModule(fromFile: string, specifier: string): string | undefined {
  const base = resolve(PROJECT_ROOT, dirname(fromFile), specifier);
  const withoutExtension = base.replace(/\.(js|jsx)$/, '');

  for (const candidate of [`${withoutExtension}.ts`, `${withoutExtension}.tsx`, base]) {
    try {
      readFileSync(candidate, 'utf8');
      return relative(PROJECT_ROOT, candidate);
    } catch {
      continue;
    }
  }

  return undefined;
}

describe('nenhum módulo alcançado pela ilha usa API só-de-Node', () => {
  const modules = collectRuntimeImports(ISLAND_ENTRY);

  it('o grafo foi realmente caminhado', () => {
    // Se a coleta quebrar e devolver só a entrada, o teste abaixo passaria
    // vazio e não guardaria nada.
    expect(modules.length).toBeGreaterThan(8);
    expect(modules).toContain('src/domain/Parameter.ts');
    expect(modules).toContain('src/application/validation/validateDocument.ts');
    expect(modules).toContain('src/domain/json/serializeJsonDocument.ts');
  });

  it('a camada de store não é arrastada para o browser', () => {
    // `infrastructure/store` lê arquivo e process.env. Se aparecer aqui, algum
    // import deixou de ser `import type`.
    expect(modules.filter((file) => file.includes('infrastructure/store'))).toEqual([]);
  });

  it.each(NODE_ONLY_PATTERNS)('nenhum módulo usa $name', ({ pattern }) => {
    const offenders = modules.filter((file) => {
      const source = readFileSync(resolve(PROJECT_ROOT, file), 'utf8');
      // Ignora linha de comentário, para poder falar de Buffer na prosa.
      const code = source
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      return pattern.test(code);
    });

    expect(offenders).toEqual([]);
  });
});
