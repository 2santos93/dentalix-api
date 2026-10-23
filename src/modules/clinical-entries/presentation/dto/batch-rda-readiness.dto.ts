import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { RdaReadinessDto } from './rda-readiness.dto';

export class BatchRdaReadinessQueryDto {
  @ApiProperty({
    type: String,
    description: 'De 1 a 50 UUID de evoluciones separados por comas.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  ids!: string[];
}

export class BatchRdaReadinessDto extends RdaReadinessDto {
  @ApiProperty({ format: 'uuid' })
  entryId!: string;
}
