/**
 * Excepción G5.3 (DX-334): tipos de pagador anteriores a DX-326.
 *
 * El pagador de un convenio llega con su tipo genérico (spec R4).
 */
import {
  mapToEntity,
  type PrismaAgreement,
} from './prisma-agreement.repository';

const AT = new Date('2026-10-29T00:00:00.000Z');

function row(type: PrismaAgreement['payer']['type']): PrismaAgreement {
  return {
    id: 'agreement-1',
    tenantId: 'tenant-1',
    name: 'Convenio Sura',
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
    payer: { id: 'payer-1', name: 'Sura EPS', type },
    priceList: null,
    _count: { assignments: 0 },
  };
}

describe('mapper de convenios (DX-326, fase 1)', () => {
  it('legacy code in an agreement row maps to its generic type', () => {
    expect(mapToEntity(row('EPS_CO')).payer).toEqual({
      id: 'payer-1',
      name: 'Sura EPS',
      type: 'PUBLIC_SYSTEM',
    });
    expect(mapToEntity(row('OTRO')).payer.type).toBe('OTHER');
  });
});
