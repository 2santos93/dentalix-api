import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class UpdateNameDto {
  @ApiProperty({ example: 'Ana Gómez' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName!: string;
}
