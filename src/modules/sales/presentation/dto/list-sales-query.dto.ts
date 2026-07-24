import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';

// Unlike ListAppointmentsQueryDto, `from`/`to` are OPTIONAL here -- listing
// sales with no range at all is a valid request (ListSalesUseCase /
// SaleRepository.listByRange both treat an absent from/to as "no lower/
// upper bound", see prisma-sale.repository.ts). The window, when given, is
// half-open `[from, to)` on `paidAt` -- same convention as the totals query
// below and as ListSalesByRangeParams.
export class ListSalesQueryDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'Inclusive lower bound on paidAt (half-open range [from, to)).',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'Exclusive upper bound on paidAt (half-open range [from, to)).',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  patientId?: string;
}
