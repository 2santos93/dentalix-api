import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GetRatesQueryDto } from './get-rates-query.dto';
import { ConvertQueryDto } from './convert-query.dto';

const INVALID = 'date debe ser un día que exista, con el formato AAAA-MM-DD.';
const OUT_OF_RANGE =
  'date tiene que ser un día entre el 2000-01-01 y el 2100-12-31.';

const DTOS = [
  ['GetRatesQueryDto', (date: unknown) => ({ date }), GetRatesQueryDto],
  [
    'ConvertQueryDto',
    (date: unknown) => ({ amount: '100', from: 'usd', to: 'cop', date }),
    ConvertQueryDto,
  ],
] as const;

// BE-049 (DX-383): la fecha de `GET /exchange/rates` y `/convert` es un día
// que existe y cae en PERIOD_DAY_MIN..PERIOD_DAY_MAX; si no, 400 en español
// antes de llegar al caso de uso (y nunca al proveedor).
describe.each(DTOS)('%s: date (BE-049, DX-383)', (_name, query, Dto) => {
  async function dateErrors(date: unknown): Promise<string[]> {
    const errors = await validate(plainToInstance(Dto, query(date)));
    return errors.flatMap((e) =>
      e.property === 'date' ? Object.values(e.constraints ?? {}) : [],
    );
  }

  it.each(['2000-01-01', '2026-07-01', '2024-02-29', '2100-12-31'])(
    'acepta %s',
    async (date) => {
      expect(await dateErrors(date)).toEqual([]);
    },
  );

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2025-02-29'])(
    'un día que no existe (%s) es «día que exista»',
    async (date) => {
      expect(await dateErrors(date)).toEqual([INVALID]);
    },
  );

  it.each(['2026-7-1', 'not-a-date', '2026-07-01T00:00:00Z', '', 20260701])(
    'una forma que no es AAAA-MM-DD (%p) es «día que exista»',
    async (date) => {
      expect(await dateErrors(date)).toEqual([INVALID]);
    },
  );

  it.each(['1900-01-01', '1999-12-31', '2101-01-01', '2999-12-31'])(
    'un día fuera del rango (%s) dice el rango',
    async (date) => {
      expect(await dateErrors(date)).toEqual([OUT_OF_RANGE]);
    },
  );
});
