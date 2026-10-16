import { ArgumentsHost, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PrismaExceptionFilter,
  conflictMessageForTarget,
} from './prisma-exception.filter';
import { requestContext } from '../observability/request-context';

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

function p2002(
  target: string | string[],
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
    meta: { target },
  });
}

describe('conflictMessageForTarget', () => {
  it('maps the per-location inventory name index (DX-042)', () => {
    expect(
      conflictMessageForTarget('inventory_items_tenant_location_name_key'),
    ).toBe('Ya existe un insumo con ese nombre en esta sede.');
  });

  it('maps the inventory expression index by its reported columns', () => {
    expect(
      conflictMessageForTarget(['tenantId', 'locationId', 'lower(name)']),
    ).toBe('Ya existe un insumo con ese nombre en esta sede.');
  });

  it('maps the odontogram mirror index (DX-042)', () => {
    expect(conflictMessageForTarget('tooth_records_source_plan_item_key')).toBe(
      'Ese procedimiento ya está registrado en el odontograma.',
    );
  });

  it('maps a concurrent privacy-policy publish (index name or columns) to a reload hint', () => {
    expect(
      conflictMessageForTarget('privacy_policy_versions_tenant_version_key'),
    ).toMatch(/política se publicó a la vez/);
    expect(conflictMessageForTarget(['tenantId', 'version'])).toMatch(
      /política se publicó a la vez/,
    );
  });

  it('maps the patient doc index (by constraint name) to a doc message', () => {
    expect(conflictMessageForTarget('patients_tenant_doc_key')).toMatch(
      /documento/i,
    );
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
    expect(json).toHaveBeenCalledTimes(1);
    const [[body]] = json.mock.calls as [
      [{ statusCode: number; message: string }],
    ];
    expect(body.statusCode).toBe(409);
    expect(body.message).toMatch(/documento/i);
  });

  // Forma real (Prisma 6, ORM) de una violación de CHECK / desbordamiento:
  // UnknownRequestError SIN code/meta, con el SQLSTATE y el DETAIL de Postgres
  // (la fila entera, con datos del paciente) dentro de `message`.
  function unknownPg(code: string, message: string, detail: string) {
    return new Prisma.PrismaClientUnknownRequestError(
      `\nInvalid \`tx.payment.create()\` invocation:\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${code}", message: "${message}", severity: "ERROR", detail: Some("${detail}"), column: None, hint: None }), transient: false })`,
      { clientVersion: '6.19.3' },
    );
  }

  const SECRET_DETAIL =
    'Failing row contains (1, Ana Pérez, CC 1234567, -1.00, USD)';

  function bodyOf(json: jest.Mock): Record<string, unknown> {
    const [[body]] = json.mock.calls as [[Record<string, unknown>]];
    return body;
  }

  it('turns a CHECK violation (23514) into a generic 400 without the Postgres DETAIL', () => {
    const filter = new PrismaExceptionFilter();
    const { host, status, json } = mockHost();
    const logSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    filter.catch(
      unknownPg(
        '23514',
        'new row for relation \\"payments\\" violates check constraint \\"payments_amount_positive\\"',
        SECRET_DETAIL,
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Los datos enviados no cumplen las reglas de la clínica.',
    });
    const serialized = JSON.stringify(bodyOf(json));
    expect(serialized).not.toMatch(/Failing row|payments|constraint|23514/);
    // El log identifica la constraint, pero nunca lleva la fila (datos clínicos).
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('payments_amount_positive');
    expect(logged).not.toContain('Ana Pérez');
    logSpy.mockRestore();
  });

  it('turns a numeric overflow (22003) into a 400 instead of a 500', () => {
    const filter = new PrismaExceptionFilter();
    const { host, status, json } = mockHost();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    filter.catch(
      unknownPg(
        '22003',
        'numeric field overflow',
        'A field with precision 14, scale 2 must round to an absolute value less than 10^12.',
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(bodyOf(json)).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Un importe o una cantidad supera el máximo permitido.',
    });
    jest.restoreAllMocks();
  });

  it('turns a FK violation (P2003) into a generic 409 without constraint names', () => {
    const filter = new PrismaExceptionFilter();
    const { host, status, json } = mockHost();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    filter.catch(
      new Prisma.PrismaClientKnownRequestError(
        'Foreign key constraint violated on the constraint: `payments_currency_fkey`',
        {
          code: 'P2003',
          clientVersion: '6.19.3',
          meta: { modelName: 'Payment', constraint: 'payments_currency_fkey' },
        },
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(409);
    expect(bodyOf(json)).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message:
        'La operación hace referencia a datos que no existen o que están en uso.',
    });
    jest.restoreAllMocks();
  });

  it('turns a trigger restrict_violation (23001: signed or immutable record) into a generic 409', () => {
    const filter = new PrismaExceptionFilter();
    const { host, status, json } = mockHost();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    filter.catch(
      unknownPg(
        '23001',
        'el plan está aceptado y firmado: sus ítems no se modifican',
        SECRET_DETAIL,
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(409);
    expect(bodyOf(json)).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'El registro está cerrado o firmado y ya no admite ese cambio.',
    });
    jest.restoreAllMocks();
  });

  it.each([
    ['23514', 400],
    ['23503', 409],
    ['22003', 400],
  ])(
    'maps a raw-query error (P2010, SQLSTATE %s) the same way',
    (sqlState, expected) => {
      const filter = new PrismaExceptionFilter();
      const { host, status, json } = mockHost();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      filter.catch(
        new Prisma.PrismaClientKnownRequestError(
          `Raw query failed. Code: \`${sqlState}\`. Message: \`${SECRET_DETAIL}\``,
          {
            code: 'P2010',
            clientVersion: '6.19.3',
            meta: { code: sqlState, message: SECRET_DETAIL },
          },
        ),
        host,
      );

      expect(status).toHaveBeenCalledWith(expected);
      expect(JSON.stringify(bodyOf(json))).not.toContain('Failing row');
      jest.restoreAllMocks();
    },
  );

  it('an unknown driver error stays a generic 500 and is logged without the Postgres DETAIL', () => {
    const filter = new PrismaExceptionFilter();
    const { host, status, json } = mockHost();
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    filter.catch(unknownPg('XX000', 'internal error', SECRET_DETAIL), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(bodyOf(json)).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Ocurrió un error procesando la solicitud.',
    });
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('XX000');
    expect(logged).not.toContain('Ana Pérez');
    errorSpy.mockRestore();
  });

  // Un 500 tiene que seguir siendo diagnosticable: el log conserva el mensaje
  // de Prisma/Postgres, pero sin el DETAIL (la fila con datos del paciente).
  it('a 500 keeps the diagnostic message in the log, with the DETAIL redacted', () => {
    const filter = new PrismaExceptionFilter();
    const { host } = mockHost();
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    filter.catch(
      unknownPg(
        'XX000',
        'could not read block 12 in file base/16384/2619',
        `${SECRET_DETAIL} \\"quoted\\"`,
      ),
      host,
    );
    filter.catch(
      new Prisma.PrismaClientKnownRequestError(
        'Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms.',
        { code: 'P2028', clientVersion: '6.19.3' },
      ),
      host,
    );
    filter.catch(
      new Prisma.PrismaClientKnownRequestError(
        'Raw query failed. Code: `23505`. Message: `ERROR: duplicate key value violates unique constraint "users_email_key"\nDETAIL: Key (email)=(ana@paciente.test) already exists.`',
        { code: 'P2010', clientVersion: '6.19.3', meta: { code: '23505' } },
      ),
      host,
    );

    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('could not read block 12');
    expect(logged).toContain('Transaction already closed');
    expect(logged).toContain('duplicate key value');
    expect(logged).not.toMatch(/Ana Pérez|1234567|quoted|ana@paciente/);
    errorSpy.mockRestore();
  });

  // DX-023: el 500 lleva el request id para cruzarlo con el log, y el log
  // lleva el stack (para diagnosticar) sin el DETAIL ni el mensaje crudo.
  it('a 500 inside a request carries the request id and logs a redacted stack', () => {
    const filter = new PrismaExceptionFilter();
    const { host, json } = mockHost();
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    requestContext.run({ requestId: 'req-prisma-0001' }, () =>
      filter.catch(unknownPg('XX000', 'internal error', SECRET_DETAIL), host),
    );

    expect(bodyOf(json)).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Ocurrió un error procesando la solicitud.',
      requestId: 'req-prisma-0001',
    });
    const [[, stack]] = errorSpy.mock.calls as [[string, string]];
    expect(stack).toMatch(/^PrismaClientUnknownRequestError: .*XX000/);
    expect(stack).toMatch(/\n\s+at /);
    expect(stack).not.toMatch(/Ana Pérez|1234567/);
    errorSpy.mockRestore();
  });

  it('leaves other Prisma errors as a 500 (does not masquerade them as conflicts)', () => {
    const filter = new PrismaExceptionFilter();
    const { host, status, json } = mockHost();
    const notFound = new Prisma.PrismaClientKnownRequestError(
      'Record not found',
      {
        code: 'P2025',
        clientVersion: '6.19.3',
      },
    );

    filter.catch(notFound, host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500 }),
    );
  });
});
