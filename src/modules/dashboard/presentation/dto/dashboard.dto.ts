import { ApiProperty } from '@nestjs/swagger';
import { AppointmentStatus } from '@prisma/client';

// Response shapes for `GET /dashboard` -- documents GetDoctorDashboardResult
// for Swagger (same convention as SalesTotalsDto/ListPatientsResponseDto:
// these classes exist purely for `@ApiProperty` docs, not input validation
// -- the use case already returns values shaped exactly like this, see
// ../../application/use-cases/get-doctor-dashboard.use-case.ts).

export class DashboardPeriodDto {
  @ApiProperty({ type: String, format: 'date-time' })
  from!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  to!: Date;
}

// Mirrors GetSalesTotalsResult (see
// ../../../sales/application/use-cases/get-sales-totals.use-case.ts) --
// duplicated here rather than importing SalesTotalsDto so the dashboard's
// presentation layer stays self-contained (Swagger-only doc classes, no
// cross-module presentation coupling).
export class DashboardSalesDto {
  @ApiProperty({ type: String, format: 'date-time' })
  from!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  to!: Date;

  @ApiProperty({ example: 'USD', description: 'ISO 4217 currency code' })
  currency!: string;

  @ApiProperty({
    example: 1250.5,
    description:
      "Sum of every active sale's total in the range, each converted to " +
      "`currency` using ITS OWN paidAt date (never today's rate).",
  })
  totalConverted!: number;

  @ApiProperty({
    example: 12,
    description: 'Number of active sales in the range, any currency.',
  })
  count!: number;

  @ApiProperty({
    example: { COP: 500000, USD: 30 },
    description:
      "Breakdown of the ORIGINAL (unconverted) totals grouped by each sale's own currency.",
  })
  byCurrency!: Record<string, number>;
}

export class DashboardLowStockItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  unit!: string;

  @ApiProperty()
  stock!: number;

  @ApiProperty()
  minStock!: number;
}

export class DashboardLowStockDto {
  @ApiProperty({ example: 3, description: 'Number of items at or below minStock.' })
  count!: number;

  @ApiProperty({ type: [DashboardLowStockItemDto] })
  items!: DashboardLowStockItemDto[];
}

export class DashboardUpcomingAppointmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ format: 'uuid' })
  providerId!: string;

  @ApiProperty({ format: 'date-time' })
  start!: Date;

  @ApiProperty({ format: 'date-time' })
  end!: Date;

  @ApiProperty({ enum: AppointmentStatus })
  status!: AppointmentStatus;
}

export class DashboardDto {
  @ApiProperty({ type: DashboardPeriodDto })
  period!: DashboardPeriodDto;

  @ApiProperty({ type: DashboardSalesDto })
  sales!: DashboardSalesDto;

  @ApiProperty({ type: DashboardLowStockDto })
  lowStockItems!: DashboardLowStockDto;

  @ApiProperty({
    type: [DashboardUpcomingAppointmentDto],
    description: 'Next N appointments (start >= now), ascending by start.',
  })
  upcomingAppointments!: DashboardUpcomingAppointmentDto[];

  @ApiProperty({ example: 42, description: 'Total patient count.' })
  patientCount!: number;
}
