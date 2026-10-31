/** El pagador de un convenio llega con su tipo genérico (DX-326, spec R4). */
import {
  mapToEntity,
  type PrismaAgreement,
} from './prisma-agreement.repository';

const AT = new Date('2026-10-29T00:00:00.000Z');

function row(type: PrismaAgreement['payer']['type']): PrismaAgreement {
  return {
    id: 'agreement-1',
    tenantId: 'tenant-1',
    name: 'Convenio Surco',
    payerId: 'payer-1',
    kind: 'PERCENT_DISCOUNT',
    percent: null,
    percentByCategory: null,
    priceListId: null,
    locationId: null,
    validFrom: null,
    validTo: null,
    active: true,
    createdById: null,
    updatedById: null,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: null,
    payer: { id: 'payer-1', name: 'Surco Salud', type },
    priceList: null,
    _count: { assignments: 0 },
  };
}

describe('mapper de convenios (DX-326)', () => {
  it('the payer of an agreement row keeps its generic type', () => {
    expect(mapToEntity(row('PUBLIC_SYSTEM')).payer).toEqual({
      id: 'payer-1',
      name: 'Surco Salud',
      type: 'PUBLIC_SYSTEM',
    });
    expect(mapToEntity(row('OTHER')).payer.type).toBe('OTHER');
  });
});
