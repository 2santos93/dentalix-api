import {
  compareExclusionCandidates,
  pickExclusionWinners,
  type ExclusionCandidate,
} from './recall-exclusion-rules';

// DX-015-bis (D9): de los recalls que un cambio deja activos, cuál se queda en
// cada grupo de exclusión. El mismo orden que el relleno único.
const candidate = (
  over: Partial<ExclusionCandidate> & { recallId: string },
): ExclusionCandidate => ({
  recallTypeId: `tipo-${over.recallId}`,
  recallTypeName: 'Tipo',
  exclusionGroup: 'HYGIENE_PERIO',
  lastDoneAt: '2027-04-10',
  intervalMonths: 6,
  ...over,
});

describe('exclusión entre tipos de recall (DX-015-bis, D9)', () => {
  it('un solo candidato con grupo gana su grupo; sin grupo no cuenta', () => {
    const perio = candidate({ recallId: 'r-perio', intervalMonths: 3 });
    const control = candidate({ recallId: 'r-control', exclusionGroup: null });
    const winners = pickExclusionWinners([control, perio]);
    expect([...winners.entries()]).toEqual([['HYGIENE_PERIO', perio]]);
  });

  it('en el mismo grupo: la base más reciente; con la misma, el intervalo más corto (perio); luego el id', () => {
    const higiene = candidate({ recallId: 'r-b', intervalMonths: 6 });
    const perio = candidate({ recallId: 'r-c', intervalMonths: 3 });
    expect(pickExclusionWinners([higiene, perio]).get('HYGIENE_PERIO')).toBe(
      perio,
    );

    const reciente = candidate({
      recallId: 'r-z',
      intervalMonths: 6,
      lastDoneAt: '2027-05-01',
    });
    expect(pickExclusionWinners([perio, reciente]).get('HYGIENE_PERIO')).toBe(
      reciente,
    );

    const gemelo = candidate({ recallId: 'r-a', intervalMonths: 3 });
    expect(pickExclusionWinners([perio, gemelo]).get('HYGIENE_PERIO')).toBe(
      gemelo,
    );
    expect(compareExclusionCandidates(gemelo, gemelo)).toBe(0);
  });

  it('cada grupo tiene su ganador', () => {
    const a = candidate({ recallId: 'r-1', exclusionGroup: 'A' });
    const b = candidate({ recallId: 'r-2', exclusionGroup: 'B' });
    const winners = pickExclusionWinners([b, a]);
    expect(winners.get('A')).toBe(a);
    expect(winners.get('B')).toBe(b);
  });

  it('sin candidatos, ningún ganador', () => {
    expect(pickExclusionWinners([]).size).toBe(0);
  });
});
