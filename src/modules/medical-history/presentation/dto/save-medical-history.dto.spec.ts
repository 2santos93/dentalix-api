import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { SaveMedicalHistoryDto } from './save-medical-history.dto';

const pipe = new ValidationPipe({ whitelist: true, transform: true });
const meta: ArgumentMetadata = {
  type: 'body',
  metatype: SaveMedicalHistoryDto,
  data: '',
};
const parse = (body: unknown) =>
  pipe.transform(body, meta) as Promise<SaveMedicalHistoryDto>;

describe('SaveMedicalHistoryDto — hábitos y embarazo tri-estado', () => {
  it('acepta la forma tri-estado y quita lo desconocido', async () => {
    const dto = await parse({
      pregnancy: 'DESCONOCE',
      habits: {
        tabaquismo: { estado: 'SI', porDia: 5, extra: 'x' },
        alcohol: { estado: 'NO' },
        sustancias: 'DESCONOCE',
        bruxismo: 'NO',
        higieneOral: { cepilladoPorDia: 2, hilo: 'SI', enjuague: 'DESCONOCE' },
      },
    });
    expect(dto.pregnancy).toBe('DESCONOCE');
    expect(JSON.parse(JSON.stringify(dto.habits))).toEqual({
      tabaquismo: { estado: 'SI', porDia: 5 },
      alcohol: { estado: 'NO' },
      sustancias: 'DESCONOCE',
      bruxismo: 'NO',
      higieneOral: { cepilladoPorDia: 2, hilo: 'SI', enjuague: 'DESCONOCE' },
    });
  });

  it('traduce los booleanos de un cliente anterior (true «Sí», false «No»)', async () => {
    const dto = await parse({
      habits: {
        tabaquismo: { activo: true, porDia: 3 },
        alcohol: { activo: false },
        bruxismo: true,
        sustancias: false,
        higieneOral: { hilo: false, cremaConFluor: true },
      },
    });
    expect(JSON.parse(JSON.stringify(dto.habits))).toEqual({
      tabaquismo: { estado: 'SI', porDia: 3 },
      alcohol: { estado: 'NO' },
      bruxismo: 'SI',
      sustancias: 'NO',
      higieneOral: { hilo: 'NO', cremaConFluor: 'SI' },
    });
  });

  it.each([
    [{ pregnancy: 'TAL_VEZ' }],
    [{ pregnancy: true }],
    [{ habits: { bruxismo: 'tal vez' } }],
    [{ habits: { tabaquismo: { porDia: 3 } } }],
    [{ habits: { tabaquismo: { estado: 'SI', porDia: -1 } } }],
  ])('rechaza %j', async (body) => {
    await expect(parse(body)).rejects.toBeDefined();
  });
});
