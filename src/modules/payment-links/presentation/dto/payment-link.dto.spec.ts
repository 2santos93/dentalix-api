import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ConfirmPaymentReportDto,
  CreatePaymentLinkDto,
  SubmitPaymentReportDto,
} from './payment-link.dto';

const METHOD = '6f1c7b52-2a8e-4c4a-9d55-0d1f6b0a9a11';
const PLAN = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';

async function invalid<T extends object>(
  type: new () => T,
  body: object,
): Promise<string[]> {
  const errors = await validate(plainToInstance(type, body));
  const props = (es: typeof errors, prefix = ''): string[] =>
    es.flatMap((e) => [
      ...(e.constraints ? [`${prefix}${e.property}`] : []),
      ...props(e.children ?? [], `${prefix}${e.property}.`),
    ]);
  return props(errors);
}

/** DX-569: importes y formas que se rechazan antes de llegar al caso de uso. */
describe('DTO del enlace de pago (DX-569)', () => {
  const report = {
    paymentMethodId: METHOD,
    currency: 'ves',
    amount: 10000.5,
    paidOn: '2026-11-14',
  };

  it('el reporte admite un importe > 0 con 2 decimales y la moneda en minúsculas', async () => {
    await expect(invalid(SubmitPaymentReportDto, report)).resolves.toEqual([]);
  });

  it.each([0, -1, 10.123, Number.NaN, '10'])(
    'el reporte rechaza el importe %p',
    async (amount) => {
      await expect(
        invalid(SubmitPaymentReportDto, { ...report, amount }),
      ).resolves.toEqual(['amount']);
    },
  );

  it('el reporte exige un medio uuid y una moneda ISO 4217', async () => {
    await expect(
      invalid(SubmitPaymentReportDto, {
        ...report,
        paymentMethodId: 'x',
        currency: 'ZZZZ',
      }),
    ).resolves.toEqual(['paymentMethodId', 'currency']);
  });

  it('el enlace pide un destino uuid, un importe > 0 y un canal conocido', async () => {
    await expect(
      invalid(CreatePaymentLinkDto, {
        target: { treatmentPlanId: PLAN },
        amount: 40,
        channel: 'WHATSAPP',
      }),
    ).resolves.toEqual([]);
    await expect(
      invalid(CreatePaymentLinkDto, {
        target: { treatmentPlanId: 'x' },
        amount: 0,
        channel: 'SMS',
      }),
    ).resolves.toEqual(['target.treatmentPlanId', 'amount', 'channel']);
  });

  it('confirmar: la tasa que fija recepción es > 0 con hasta 8 decimales', async () => {
    await expect(
      invalid(ConfirmPaymentReportDto, {
        rateOverride: 250.12345678,
        rateOverrideReason: 'Tasa del banco',
      }),
    ).resolves.toEqual([]);
    await expect(
      invalid(ConfirmPaymentReportDto, { rateOverride: 0 }),
    ).resolves.toEqual(['rateOverride']);
    await expect(
      invalid(ConfirmPaymentReportDto, { rateOverride: 1.123456789 }),
    ).resolves.toEqual(['rateOverride']);
  });
});
