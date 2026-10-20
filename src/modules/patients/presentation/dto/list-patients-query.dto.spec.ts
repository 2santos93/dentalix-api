import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListPatientsQueryDto } from './list-patients-query.dto';
import { PATIENTS_MAX_PAGE } from '../../application/use-cases/list-patients.use-case';

async function errorsFor(query: Record<string, string>) {
  const dto = plainToInstance(ListPatientsQueryDto, query);
  return validate(dto);
}

describe('ListPatientsQueryDto (DX-043: tope de page)', () => {
  it('acepta page hasta el tope', async () => {
    expect(await errorsFor({ page: String(PATIENTS_MAX_PAGE) })).toEqual([]);
  });

  it('rechaza page por encima del tope con un mensaje en español', async () => {
    const errors = await errorsFor({ page: String(PATIENTS_MAX_PAGE + 1) });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('page');
    expect(Object.values(errors[0].constraints ?? {})).toEqual([
      `page admite hasta ${PATIENTS_MAX_PAGE}.`,
    ]);
  });

  it('rechaza page no entera o menor que 1 en español', async () => {
    const [notInt] = await errorsFor({ page: '1.5' });
    expect(Object.values(notInt.constraints ?? {})).toContain(
      'page debe ser un número entero.',
    );
    const [zero] = await errorsFor({ page: '0' });
    expect(Object.values(zero.constraints ?? {})).toContain(
      'page empieza en 1.',
    );
  });

  it('no rechaza un pageSize grande: el caso de uso lo recorta (contrato existente)', async () => {
    expect(await errorsFor({ pageSize: '500' })).toEqual([]);
  });

  it('rechaza un término de búsqueda desmesurado', async () => {
    const errors = await errorsFor({ query: 'x'.repeat(101) });
    expect(errors[0].property).toBe('query');
    expect(Object.values(errors[0].constraints ?? {})).toEqual([
      'La búsqueda admite como mucho 100 caracteres.',
    ]);
  });

  describe('payerId (DX-153)', () => {
    it('acepta un UUID v4 o ningún valor', async () => {
      expect(
        await errorsFor({ payerId: '3f0c2d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f' }),
      ).toEqual([]);
      expect(await errorsFor({})).toEqual([]);
    });

    it.each(['no-es-uuid', '123', '3f0c2d4e-5b6a-1c7d-8e9f-0a1b2c3d4e5f'])(
      'rechaza %s con un mensaje en español',
      async (payerId) => {
        const errors = await errorsFor({ payerId });
        expect(errors[0].property).toBe('payerId');
        expect(Object.values(errors[0].constraints ?? {})).toEqual([
          'payerId debe ser un UUID.',
        ]);
      },
    );
  });
});
