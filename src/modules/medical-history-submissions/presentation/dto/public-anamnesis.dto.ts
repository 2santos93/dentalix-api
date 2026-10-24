import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { YES_NO_UNKNOWN } from '../../domain/anamnesis-questionnaire';

// Respuesta de GET /public/medical-history/:token (DX-099). Solo el
// cuestionario, la marca de la clínica y el nombre de pila: ni apellidos, ni
// documento, ni ningún dato de salud anterior.

class PublicAnamnesisClinicDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) logoUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) primaryColor!: string | null;
}

class AnswerLabelsDto {
  @ApiProperty({ example: 'Sí' }) SI!: string;
  @ApiProperty({ example: 'No' }) NO!: string;
  @ApiProperty({ example: 'No sé' }) NO_SE!: string;
}

class OptionDto {
  @ApiProperty() value!: string;
  @ApiProperty() label!: string;
}

class QuestionnaireLimitsDto {
  @ApiProperty() text!: number;
  @ApiProperty() note!: number;
  @ApiProperty() listItems!: number;
  @ApiProperty() weeks!: number;
  @ApiProperty() perDay!: number;
}

class FollowUpDto {
  @ApiProperty({
    enum: [
      'ALLERGY_LIST',
      'MEDICATION_LIST',
      'SURGERY_LIST',
      'TEXT',
      'NUMBER',
      'NOTE',
    ],
    enumName: 'AnamnesisFollowUpKind',
  })
  kind!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ description: 'Al contestar «Sí» hay que llenarlo' })
  required!: boolean;
}

class QuestionDto {
  @ApiProperty({
    description:
      'Clave de la respuesta: allergies, condition:<codigo>, anticoagulants, medications, habits.tabaquismo, habits.alcohol, habits.bruxismo, pregnancy, surgeries',
  })
  key!: string;
  @ApiProperty() label!: string;
  @ApiPropertyOptional() help?: string;
  @ApiPropertyOptional({ type: FollowUpDto }) followUp?: FollowUpDto;
}

class SectionDto {
  @ApiProperty({
    enum: [
      'allergies',
      'conditions',
      'medications',
      'habits',
      'pregnancy',
      'surgeries',
    ],
    enumName: 'AnamnesisSectionKey',
  })
  key!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty({ type: [QuestionDto] }) questions!: QuestionDto[];
}

export class AnamnesisQuestionnaireDto {
  @ApiProperty({ example: '2026-10-v1' }) version!: string;
  @ApiProperty({
    enum: YES_NO_UNKNOWN,
    enumName: 'AnamnesisAnswer',
    isArray: true,
  })
  answers!: string[];
  @ApiProperty({ type: AnswerLabelsDto }) answerLabels!: AnswerLabelsDto;
  @ApiProperty({ type: [OptionDto] }) allergyTypes!: OptionDto[];
  @ApiProperty({ type: [OptionDto] }) allergySeverities!: OptionDto[];
  @ApiProperty({ type: QuestionnaireLimitsDto })
  limits!: QuestionnaireLimitsDto;
  @ApiProperty({ description: 'Texto de la casilla de veracidad' })
  declaration!: string;
  @ApiProperty({ type: [SectionDto] }) sections!: SectionDto[];
}

class PublicPolicyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ description: 'Texto de la casilla SENSITIVE_HEALTH (DX-037)' })
  sensitiveHealthText!: string;
  @ApiProperty({ description: 'Política completa (aviso de privacidad)' })
  policyText!: string;
}

class PublicConsentDto {
  @ApiProperty({
    description:
      'El paciente no tiene vigente la autorización SENSITIVE_HEALTH: se pide antes del cuestionario.',
  })
  required!: boolean;
  @ApiProperty({ type: PublicPolicyDto, nullable: true })
  policy!: PublicPolicyDto | null;
}

export class PublicAnamnesisDto {
  @ApiProperty({ type: PublicAnamnesisClinicDto })
  clinic!: PublicAnamnesisClinicDto;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Solo el nombre de pila',
  })
  patientFirstName!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: Date;
  @ApiProperty({ type: AnamnesisQuestionnaireDto })
  questionnaire!: AnamnesisQuestionnaireDto;
  @ApiProperty({ type: PublicConsentDto }) consent!: PublicConsentDto;
}

export class PublicAnamnesisSubmittedDto {
  @ApiProperty({ type: String, format: 'date-time' }) submittedAt!: Date;
}
