import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PAYMENT_RECEIPT_SUMMARY_REPOSITORY,
  type PaymentReceiptSummaryRepository,
} from '../../domain/ports/payment-receipt-summary-repository.port';
import {
  RECEIPT_SUMMARY_INVALID_PERIOD_MESSAGE,
  RECEIPT_SUMMARY_MAX_DAYS,
  RECEIPT_SUMMARY_NOTICE,
  RECEIPT_SUMMARY_PERIOD_TOO_LONG_MESSAGE,
  receiptSummaryLines,
  receiptSummaryTotals,
  receiptSummaryVoidedCount,
  type PaymentReceiptSummaryView,
  type ReceiptSummarySourceItem,
} from '../../domain/receipt-summary';
import { receiptClinicData } from '../../domain/receipt-snapshot';
import {
  checkPeriodDays,
  PERIOD_DAY_OUT_OF_RANGE_MESSAGE,
} from '../../../../shared/time/civil-day';
import { maskDocument } from '../../../../shared/privacy/mask-document';
import { documentTypeName } from '../../../patients/domain/document-type';
import { DocumentTypeNamesReader } from '../../../patients/domain/ports/document-type-names-repository.port';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  PAYMENT_CLOCK,
  type PaymentClock,
} from '../use-cases/void-payment.use-case';

export const RECEIPT_SUMMARY_PATIENT_NOT_FOUND_MESSAGE =
  'Paciente no encontrado.';

export interface ReceiptSummaryPeriod {
  from: string;
  to: string;
}

export interface LoadedReceiptSummary {
  view: PaymentReceiptSummaryView;
  /** Los recibos leídos (para saber la sede del último al enviarlo). */
  items: ReceiptSummarySourceItem[];
}

/** El período validado o el 400 en español (forma, orden, rango admitido y tope). */
export function validReceiptSummaryPeriod(
  period: ReceiptSummaryPeriod,
): ReceiptSummaryPeriod {
  const check = checkPeriodDays(period.from, period.to);
  if (!check.ok) {
    throw new BadRequestException(
      check.problem === 'OUT_OF_RANGE'
        ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
        : RECEIPT_SUMMARY_INVALID_PERIOD_MESSAGE,
    );
  }
  if (check.days > RECEIPT_SUMMARY_MAX_DAYS) {
    throw new BadRequestException(RECEIPT_SUMMARY_PERIOD_TOO_LONG_MESSAGE);
  }
  return { from: check.from, to: check.to };
}

/**
 * DX-401: resumen de los recibos de caja de un paciente en un período, para
 * verlo, imprimirlo o enviarlo. Los recibos se cuentan por el día civil de su
 * emisión en la zona de SU sede (DX-097, como la caja). Cada fila sale de la
 * foto del recibo (número, sede, forma de pago, importe), así que dice lo
 * mismo que cada recibo; los datos de la clínica y del paciente son los de
 * HOY, porque el resumen es un documento nuevo que se emite hoy. Un miembro
 * restringido a unas sedes (DX-525) recibe solo los recibos de esas sedes y
 * la vista lo dice (`restrictedToLocations`).
 */
@Injectable()
export class GetPaymentReceiptSummaryUseCase {
  constructor(
    @Inject(PAYMENT_RECEIPT_SUMMARY_REPOSITORY)
    private readonly repo: PaymentReceiptSummaryRepository,
    private readonly documentTypeNames: DocumentTypeNamesReader,
    private readonly tenantContext: TenantContextService,
    @Inject(PAYMENT_CLOCK) private readonly now: PaymentClock,
  ) {}

  async execute(
    patientId: string,
    period: ReceiptSummaryPeriod,
  ): Promise<PaymentReceiptSummaryView> {
    return (await this.load(patientId, period)).view;
  }

  async load(
    patientId: string,
    period: ReceiptSummaryPeriod,
  ): Promise<LoadedReceiptSummary> {
    const { from, to } = validReceiptSummaryPeriod(period);
    const allowed = this.tenantContext.getAllowedLocationIds();
    const locationIds = allowed === 'ALL' ? undefined : [...allowed];
    const source = await this.repo.find({ patientId, from, to, locationIds });
    if (!source) {
      throw new NotFoundException(RECEIPT_SUMMARY_PATIENT_NOT_FOUND_MESSAGE);
    }
    // El resumen abarca sedes: el nombre del documento es el de la clínica.
    const names = await this.documentTypeNames.get(null);
    const { patient } = source;
    const receipts = receiptSummaryLines(source.items);
    return {
      items: source.items,
      view: {
        patient: {
          id: patient.id,
          fullName: `${patient.firstName.trim()} ${patient.lastName.trim()}`,
          documentMasked: maskDocument(patient.docNumber),
          documentTypeName: documentTypeName(
            patient.documentType,
            patient.docTypeLabel,
            names,
          ),
          patientCode: String(patient.patientCode),
        },
        clinic: receiptClinicData(source.clinic),
        from,
        to,
        generatedAt: this.now().toISOString(),
        restrictedToLocations: locationIds !== undefined,
        receipts,
        totals: receiptSummaryTotals(receipts),
        voidedCount: receiptSummaryVoidedCount(source.items),
        notice: RECEIPT_SUMMARY_NOTICE,
      },
    };
  }
}
