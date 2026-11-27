import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { createAppValidationPipe } from '../../../../shared/validation/app-validation-pipe';
import { VoidToothRecordDto } from './void-tooth-record.dto';

const META: ArgumentMetadata = { type: 'body', metatype: VoidToothRecordDto };
const REQUIRED = 'El motivo de la anulación es obligatorio';

async function badRequest(body: unknown): Promise<{
  message: string[];
  fields: { field: string; code: string; message: string }[];
}> {
  try {
    await createAppValidationPipe('reject').transform(body, META);
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as never;
  }
  throw new Error('se esperaba un 400');
}

describe('VoidToothRecordDto (DX-132: un solo mensaje por motivo)', () => {
  it.each([
    ['cuerpo {}', {}],
    ['motivo null', { reason: null }],
    ['motivo que no es texto', { reason: 42 }],
    ['motivo vacío', { reason: '' }],
    ['motivo solo con espacios', { reason: '   ' }],
  ])('%s: un único error, «obligatorio»', async (_label, body) => {
    const res = await badRequest(body);
    expect(res.message).toEqual([REQUIRED]);
    expect(res.fields).toHaveLength(1);
    expect(res.fields[0]).toMatchObject({ field: 'reason', message: REQUIRED });
  });

  it('un motivo de más de 500 caracteres: solo el tope', async () => {
    const res = await badRequest({ reason: 'x'.repeat(501) });
    expect(res.message).toEqual(['El motivo admite como mucho 500 caracteres']);
    expect(res.fields).toHaveLength(1);
  });

  it('un motivo válido pasa', async () => {
    await expect(
      createAppValidationPipe('reject').transform(
        { reason: 'Registrado en el diente equivocado' },
        META,
      ),
    ).resolves.toMatchObject({ reason: 'Registrado en el diente equivocado' });
  });
});
