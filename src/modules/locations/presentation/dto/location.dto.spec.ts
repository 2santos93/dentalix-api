import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { UpdateLocationDto } from './location.dto';

function flatten(errors: ValidationError[]): string[] {
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

// Igual que la ValidationPipe global (whitelist + transform).
async function check(plain: object) {
  const dto = plainToInstance(UpdateLocationDto, plain);
  const errors = await validate(dto, { whitelist: true });
  return { dto, messages: flatten(errors) };
}

describe('UpdateLocationDto · nº de registro sanitario (DX-319)', () => {
  it('acepta texto libre recortado, null y el booleano de impresión', async () => {
    const { dto, messages } = await check({
      healthRegistrationNumber: '  NRS 28/1234-AB  ',
      showHealthRegistrationNumber: true,
    });
    expect(messages).toEqual([]);
    expect(dto.healthRegistrationNumber).toBe('NRS 28/1234-AB');
    expect(dto.showHealthRegistrationNumber).toBe(true);
    expect((await check({ healthRegistrationNumber: null })).messages).toEqual(
      [],
    );
  });

  it('hasta 64 caracteres tras recortar', async () => {
    expect(
      (await check({ healthRegistrationNumber: ` ${'A'.repeat(64)} ` }))
        .messages,
    ).toEqual([]);
    expect(
      (await check({ healthRegistrationNumber: 'A'.repeat(65) })).messages,
    ).toEqual(['El nº de registro sanitario admite hasta 64 caracteres.']);
  });

  it('rechaza tipos que no son texto o booleano', async () => {
    expect(
      (await check({ healthRegistrationNumber: 1234 })).messages,
    ).toContain('El nº de registro sanitario debe ser un texto.');
    expect(
      (await check({ showHealthRegistrationNumber: 'sí' })).messages,
    ).toContain('«Mostrar en los documentos» debe ser verdadero o falso.');
  });

  it('el código REPS ya no existe: enviarlo es un 400, no un 200 mudo', async () => {
    for (const value of ['110010123401', null, '']) {
      expect((await check({ repsHabilitationCode: value })).messages).toEqual([
        'El código REPS ya no existe: usa healthRegistrationNumber (nº de registro sanitario).',
      ]);
    }
    expect((await check({ name: 'Sede' })).messages).toEqual([]);
  });
});
