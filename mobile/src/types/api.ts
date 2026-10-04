export type OccupiedTable = {
  tableId: number;
  number: number;
  activeSessionCount: number;
};

export type SessionResponse = {
  sessionToken: string;
  session: { id: number; pseudo: string; tableId: number };
};

export type MeResponse = {
  id: number;
  pseudo: string;
  tableId: number;
  status: string;
};

export type MessageDto = {
  id: number;
  kind: 'predefined' | 'freetext';
  predefinedCode: string | null;
  content: string;
  senderSessionId: number;
  createdAt: string;
};

export type SendMessageResponse = {
  status: 'sent' | 'pending_approval';
  contactId: number;
  message?: MessageDto;
};

export type RespondResponse = {
  status: 'accepted' | 'refused';
};

export type ContactRequestEvent = {
  contactId: number;
  fromTableId: number;
  fromTableNumber: number;
};

export type ContactResolvedEvent = {
  contactId: number;
  status: 'accepted' | 'refused';
};

export type MessageNewEvent = {
  contactId: number;
  message: MessageDto;
};
