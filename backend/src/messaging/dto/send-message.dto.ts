export class SendMessageDto {
  toTableId: number;
  kind: 'predefined' | 'freetext';
  predefinedCode?: string;
  content: string;
}
