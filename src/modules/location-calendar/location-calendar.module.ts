import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { StorageModule } from '../../shared/storage/storage.module';
import { ImportHolidaysUseCase } from './application/import-holidays.use-case';
import {
  CreateHolidayUseCase,
  GetLocationCalendarUseCase,
  RetireHolidayUseCase,
  SetWorkingWeekdaysUseCase,
  UpdateHolidayUseCase,
} from './application/location-calendar.use-cases';
import { LOCATION_CALENDAR_REPOSITORY } from './domain/ports/location-calendar-repository.port';
import { PrismaLocationCalendarRepository } from './infrastructure/prisma-location-calendar.repository';
import { LocationCalendarController } from './presentation/location-calendar.controller';

/** DX-316: días hábiles y festivos por sede (Ajustes, solo ADMIN). */
@Module({
  imports: [JwtModule.register({}), StorageModule],
  controllers: [LocationCalendarController],
  providers: [
    GetLocationCalendarUseCase,
    SetWorkingWeekdaysUseCase,
    CreateHolidayUseCase,
    UpdateHolidayUseCase,
    RetireHolidayUseCase,
    ImportHolidaysUseCase,
    TokenService,
    TenantContextInterceptor,
    {
      provide: LOCATION_CALENDAR_REPOSITORY,
      useClass: PrismaLocationCalendarRepository,
    },
  ],
})
export class LocationCalendarModule {}
