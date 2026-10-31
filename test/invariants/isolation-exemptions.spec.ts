import {
  exemptionProblems,
  isolationCoversIn,
  lastStaticSegment,
  type IsolationExemption,
} from '../support/isolation-exemptions';

// DX-451 (TST-055): controles de la guardia de exenciones de la matriz de
// aislamiento. La guardia corre sobre las listas reales en
// test/tenant-isolation-matrix.e2e-spec.ts; aquí se comprueba, con ficheros
// en memoria, que falla en cada caso que debe fallar.

const CHECKLIST =
  'POST /patients/:patientId/clinical-entries/:entryId/sedation/checklist';
const AGENTS =
  'POST /patients/:patientId/clinical-entries/:entryId/sedation/agents';

/** Un spec que ataca desde B el último tramo de cada ruta, con su marcador. */
const specAttacking = (routes: string[]): string =>
  routes
    .map(
      (route) => `
  // ISOLATION_COVERS: ${route}
  it('B → 404', async () => {
    await call(b, 'post', \`\${sheet(p, e)}/${lastStaticSegment(route)}\`).expect(404);
  });`,
    )
    .join('\n');

const SPEC = specAttacking([CHECKLIST, AGENTS]);

const exemption = (
  overrides: Partial<IsolationExemption> = {},
): IsolationExemption => ({
  spec: 'sedation.e2e-spec.ts',
  checks: 'B → 404 sobre la hoja abierta de A y la hoja no cambia',
  routes: [CHECKLIST, AGENTS],
  ...overrides,
});

const files =
  (byName: Record<string, string>) =>
  (spec: string): string | undefined =>
    byName[spec];

const NONE = {
  duplicada: [],
  sinComentarioB: [],
  specInexistente: [],
  sinMarcador: [],
  marcadorSinTest: [],
  specSinRuta: [],
  marcadorHuerfano: [],
};

describe('guardia de exenciones de la matriz de aislamiento (DX-451)', () => {
  it('lee los marcadores y el último tramo fijo de la ruta', () => {
    expect(isolationCoversIn(SPEC)).toEqual([CHECKLIST, AGENTS]);
    expect(lastStaticSegment(CHECKLIST)).toBe('checklist');
    expect(lastStaticSegment('PATCH /anesthetics/:id')).toBe('anesthetics');
  });

  it('una exención con su spec, su marcador y su comentario «B → …» pasa', () => {
    expect(
      exemptionProblems([exemption()], files({ 'sedation.e2e-spec.ts': SPEC })),
    ).toEqual(NONE);
  });

  it('control: citar un fichero que no existe falla', () => {
    expect(
      exemptionProblems(
        [exemption({ spec: 'no-existe.e2e-spec.ts' })],
        files({ 'sedation.e2e-spec.ts': SPEC }),
      ),
    ).toEqual({
      ...NONE,
      specInexistente: [
        `${CHECKLIST} → no-existe.e2e-spec.ts`,
        `${AGENTS} → no-existe.e2e-spec.ts`,
      ],
    });
  });

  it('control: un nombre que no es un spec de test/ cuenta como inexistente', () => {
    const problems = exemptionProblems(
      [exemption({ spec: '../src/main.ts' })],
      files({ '../src/main.ts': SPEC }),
    );
    expect(problems.specInexistente).toHaveLength(2);
  });

  it('control: quitar el caso (y su marcador) del spec citado falla', () => {
    const withoutAgents = specAttacking([CHECKLIST]);
    expect(
      exemptionProblems(
        [exemption()],
        files({ 'sedation.e2e-spec.ts': withoutAgents }),
      ),
    ).toEqual({
      ...NONE,
      sinMarcador: [`${AGENTS} → sedation.e2e-spec.ts`],
      specSinRuta: [`${AGENTS} → sedation.e2e-spec.ts`],
    });
  });

  it('control: un marcador sin la ruta en el spec (copiado a ciegas) falla', () => {
    const markerOnly = `// ISOLATION_COVERS: ${CHECKLIST}\nit('nada', () => {});`;
    expect(
      exemptionProblems(
        [exemption({ routes: [CHECKLIST] })],
        files({ 'sedation.e2e-spec.ts': markerOnly }),
      ).specSinRuta,
    ).toEqual([`${CHECKLIST} → sedation.e2e-spec.ts`]);
  });

  it.each([
    [
      'suelto al principio del fichero',
      (spec: string) =>
        spec.replace(`  // ISOLATION_COVERS: ${AGENTS}\n`, '') +
        `\n// ISOLATION_COVERS: ${AGENTS}\nconst x = 1;`,
    ],
    [
      'encima de un it.skip',
      (spec: string) =>
        spec.replace(/(ISOLATION_COVERS: [^\n]*agents\n\s*)it\(/, '$1it.skip('),
    ],
    [
      'encima de un describe',
      (spec: string) =>
        spec.replace(
          /(ISOLATION_COVERS: [^\n]*agents\n\s*)it\(/,
          '$1describe(',
        ),
    ],
    [
      'con código en medio',
      (spec: string) =>
        spec.replace(
          /(ISOLATION_COVERS: [^\n]*agents\n)/,
          '$1  const y = 2;\n',
        ),
    ],
  ])(
    'control: un marcador %s (no encima de un test activo) falla',
    (_label, mutate) => {
      const mutated = mutate(SPEC);
      expect(mutated).not.toBe(SPEC);
      expect(
        exemptionProblems(
          [exemption()],
          files({ 'sedation.e2e-spec.ts': mutated }),
        ),
      ).toEqual({
        ...NONE,
        marcadorSinTest: [`${AGENTS} → sedation.e2e-spec.ts`],
      });
    },
  );

  it.each([
    ['vacío', ''],
    ['sin «B → »', 'el spec lo cubre'],
    ['«B → » sin decir qué', 'B → 404'],
  ])('control: una exención con comentario %s falla', (_label, checks) => {
    expect(
      exemptionProblems(
        [exemption({ checks, routes: [CHECKLIST] })],
        files({ 'sedation.e2e-spec.ts': SPEC }),
      ),
    ).toEqual({
      ...NONE,
      sinComentarioB: [`${CHECKLIST} → ${checks}`],
      marcadorHuerfano: [`sedation.e2e-spec.ts: ${AGENTS}`],
    });
  });

  it('control: una ruta exenta dos veces falla', () => {
    expect(
      exemptionProblems(
        [exemption(), exemption({ routes: [AGENTS] })],
        files({ 'sedation.e2e-spec.ts': SPEC }),
      ).duplicada,
    ).toEqual([AGENTS]);
  });

  it('control: un marcador que ninguna exención cita (la ruta pasó a la matriz) falla', () => {
    expect(
      exemptionProblems(
        [exemption({ routes: [CHECKLIST] })],
        files({ 'sedation.e2e-spec.ts': SPEC }),
      ),
    ).toEqual({
      ...NONE,
      marcadorHuerfano: [`sedation.e2e-spec.ts: ${AGENTS}`],
    });
  });
});
