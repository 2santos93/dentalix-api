import { procedureRecallUpdates } from './recall-from-procedure';

// DX-015-bis (D9/D10): lo que el PATCH del ítem devuelve en `recallUpdates`.
describe('procedureRecallUpdates (DX-015-bis)', () => {
  const perio = {
    recallId: 'r-perio',
    recallTypeId: 't-perio',
    recallTypeName: 'Mantenimiento periodontal',
    dueAt: '2027-07-10',
    changed: true,
  };
  const replacedBy = {
    recallId: 'r-perio',
    recallTypeId: 't-perio',
    recallTypeName: 'Mantenimiento periodontal',
  };

  it('sin exclusión: los del procedimiento con deactivated false', () => {
    expect(procedureRecallUpdates({ recalls: [perio], excluded: [] })).toEqual([
      {
        recallId: 'r-perio',
        recallTypeId: 't-perio',
        recallTypeName: 'Mantenimiento periodontal',
        dueAt: '2027-07-10',
        deactivated: false,
        replacedBy: null,
      },
    ]);
  });

  it('los desactivados van detrás, con el tipo que los sustituye', () => {
    const out = procedureRecallUpdates({
      recalls: [perio],
      excluded: [
        {
          recallId: 'r-higiene',
          recallTypeId: 't-higiene',
          recallTypeName: 'Higiene',
          dueAt: '2027-10-10',
          replacedBy,
        },
      ],
    });
    expect(out).toEqual([
      expect.objectContaining({ recallId: 'r-perio', deactivated: false }),
      {
        recallId: 'r-higiene',
        recallTypeId: 't-higiene',
        recallTypeName: 'Higiene',
        dueAt: '2027-10-10',
        deactivated: true,
        replacedBy: {
          recallTypeId: 't-perio',
          recallTypeName: 'Mantenimiento periodontal',
        },
      },
    ]);
  });

  it('uno del procedimiento que la exclusión desactiva sale una vez, desactivado', () => {
    const higiene = {
      recallId: 'r-higiene',
      recallTypeId: 't-higiene',
      recallTypeName: 'Higiene',
      dueAt: '2027-10-10',
      changed: true,
    };
    const out = procedureRecallUpdates({
      recalls: [higiene, perio],
      excluded: [{ ...higiene, replacedBy }],
    });
    expect(out.map((u) => [u.recallId, u.deactivated])).toEqual([
      ['r-higiene', true],
      ['r-perio', false],
    ]);
  });
});
