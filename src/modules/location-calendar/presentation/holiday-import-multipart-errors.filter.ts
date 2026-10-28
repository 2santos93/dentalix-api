import {
  BadRequestException,
  Catch,
  PayloadTooLargeException,
} from '@nestjs/common';
import { MultipartErrorsFilter } from '../../patient-documents/presentation/multipart-errors.filter';
import { HOLIDAY_MESSAGES } from '../domain/holiday-rules';

/** Los errores de multer de la importación de festivos, en español y con su tope de 256 KB. */
@Catch(PayloadTooLargeException, BadRequestException)
export class HolidayImportMultipartErrorsFilter extends MultipartErrorsFilter {
  protected override readonly tooLargeMessage = HOLIDAY_MESSAGES.fileTooLarge;
}
