import { stackFrames, stackWithoutMessage } from './safe-stack';

function errorWithStack(name: string, stack: string): Error {
  const error = new Error('ignorado');
  error.name = name;
  error.stack = stack;
  return error;
}

describe('safe-stack', () => {
  // El mensaje de un error puede ocupar varias líneas (Prisma imprime la
  // query con sus argumentos): solo los marcos "at ..." son seguros.
  const MULTILINE = errorWithStack(
    'PrismaClientValidationError',
    [
      'PrismaClientValidationError: ',
      'Invalid `prisma.patient.create()` invocation:',
      '{ data: { fullName: "Juan Pérez" } }',
      '    at Rn (node_modules/@prisma/client/runtime/library.js:29:1363)',
      '    at async PatientsRepo.create (src/patients.repo.ts:12:5)',
    ].join('\n'),
  );

  it('stackFrames devuelve solo los marcos', () => {
    expect(stackFrames(MULTILINE)).toEqual([
      '    at Rn (node_modules/@prisma/client/runtime/library.js:29:1363)',
      '    at async PatientsRepo.create (src/patients.repo.ts:12:5)',
    ]);
  });

  it('stackWithoutMessage: el nombre del error y los marcos, sin el mensaje', () => {
    const stack = stackWithoutMessage(MULTILINE);
    expect(stack).toBe(
      [
        'PrismaClientValidationError',
        '    at Rn (node_modules/@prisma/client/runtime/library.js:29:1363)',
        '    at async PatientsRepo.create (src/patients.repo.ts:12:5)',
      ].join('\n'),
    );
    expect(stack).not.toContain('Juan');
  });

  it('acepta una cabecera propia (p. ej. el mensaje ya redactado)', () => {
    expect(stackWithoutMessage(MULTILINE, 'Cabecera: segura')).toMatch(
      /^Cabecera: segura\n {4}at Rn/,
    );
  });

  it('sin stack queda solo la cabecera', () => {
    const error = new Error('x');
    error.stack = undefined;
    expect(stackWithoutMessage(error)).toBe('Error');
  });
});
