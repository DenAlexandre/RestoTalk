import { MessageDto, MessageNewEvent } from '../types/api';

export function appendMessageIfNew(messages: MessageDto[], incoming: MessageDto): MessageDto[] {
  if (messages.some((m) => m.id === incoming.id)) {
    return messages;
  }
  return [...messages, incoming];
}

export function belongsToContact(contactId: number, event: MessageNewEvent): boolean {
  return event.contactId === contactId;
}

export function stripOptimisticMessages(messages: MessageDto[]): MessageDto[] {
  return messages.filter((m) => m.id >= 0);
}
