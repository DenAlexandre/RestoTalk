import { appendMessageIfNew, belongsToContact } from './chatMessages';
import { MessageDto } from '../types/api';

const baseMessage: MessageDto = {
  id: 1,
  kind: 'freetext',
  predefinedCode: null,
  content: 'Salut',
  senderSessionId: 10,
  createdAt: '2026-10-04T10:00:00.000Z',
};

describe('appendMessageIfNew', () => {
  it('appends a message with a new id', () => {
    const result = appendMessageIfNew([], baseMessage);
    expect(result).toEqual([baseMessage]);
  });

  it('does not duplicate a message with an id already present', () => {
    const result = appendMessageIfNew([baseMessage], { ...baseMessage, content: 'edited' });
    expect(result).toEqual([baseMessage]);
  });
});

describe('belongsToContact', () => {
  it('returns true when the event contactId matches', () => {
    expect(belongsToContact(7, { contactId: 7, message: baseMessage })).toBe(true);
  });

  it('returns false when the event contactId does not match', () => {
    expect(belongsToContact(7, { contactId: 9, message: baseMessage })).toBe(false);
  });
});
