import { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PrismaExceptionFilter,
  conflictMessageForTarget,
} from './prisma-exception.filter';

function mockHost(): {
  host: ArgumentsHost;
  status: jest.Mock;
  json: jest.Mock;
} {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

function p2002(target: string | string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
    meta: { target },
  });
}

describe('conflictMessageForTarget', () => {
  it('maps the patient doc index (by constraint name) to a doc message', () => {
    expect(conflictMessageForTarget('patients_tenant_doc_key')).toMatch(/documento/i);
  });

  it('maps by raw column list too (array target)', () => {
    expect(conflictMessageForTarget(['tenantId', 'email'])).toMatch(/correo/i);
  });

  it('falls back to a generic message for an unknown target', () => {
    expect(conflictMessageForTarget('some_other_key')).toBe(
      'Ya existe un registro con esos datos.',
    );
    expect(conflictMessageForTarget(undefined)).toBe(
      'Ya existe un registro con esos datos.',
    );
  });
});

describe('PrismaExceptionFilter', () => {
  it('turns a P2002 unique violation into a 409 with a friendly message', () => {
    const filter = new PrismaExceptionFilter();
    const { host, status, json } = mockHost();

    filter.catch(p2002('catalog_tenant_code_key'), host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      statusCode: 409,
      error: 'Conflict',
      message: 'Ya existe un ítem del catálogo con ese código.',
    });
  });

  it('maps an array target (raw columns) to the right message', () => {
    const filter = new PrismaExceptionFilter();
    const { host, status, json } = mockHost();

    filter.catch(p2002(['tenantId', 'docNumber']), host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 409, message: expect.stringMatching(/documento/i) }),
    );
  });

  it('leaves other Prisma errors as a 500 (does not masquerade them as conflicts)', () => {
    const filter = new PrismaExceptionFilter();
    const { host, status, json } = mockHost();
    const notFound = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: '6.19.3',
    });

    filter.catch(notFound, host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500 }),
    );
  });
});
