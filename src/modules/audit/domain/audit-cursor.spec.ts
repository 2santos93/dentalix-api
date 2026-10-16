import { randomUUID } from 'node:crypto';
import { decodeAuditCursor, encodeAuditCursor } from './audit-cursor';

describe('cursor de auditoría (DX-009)', () => {
  it('ida y vuelta: instante (ms) e id', () => {
    const cursor = {
      occurredAt: new Date('2026-10-16T14:03:11.412Z'),
      id: randomUUID(),
    };
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
  });

  it('es opaco y apto para una URL', () => {
    const encoded = encodeAuditCursor({
      occurredAt: new Date(),
      id: randomUUID(),
    });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['basura', 'no-es-base64!!'],
    [
      'sin separador',
      Buffer.from('2026-10-16T14:03:11.412Z').toString('base64url'),
    ],
    [
      'fecha inválida',
      Buffer.from(`nope|${randomUUID()}`).toString('base64url'),
    ],
    [
      'id que no es uuid',
      Buffer.from('2026-10-16T14:03:11.412Z|1 OR 1=1').toString('base64url'),
    ],
  ])('un cursor manipulado (%s) se rechaza', (_name, raw) => {
    expect(decodeAuditCursor(raw)).toBeNull();
  });
});
