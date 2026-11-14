import { PickType } from '@nestjs/swagger';
import { ReceivablesAgingQueryDto } from './receivables-aging-query.dto';

// GET /receivables/credit-balances (DX-430): la sede, la moneda y la página de
// la cartera por antigüedad; ninguno de sus filtros de deuda aplica aquí.
export class CreditBalancesQueryDto extends PickType(ReceivablesAgingQueryDto, [
  'locationId',
  'currency',
  'page',
  'pageSize',
] as const) {}
