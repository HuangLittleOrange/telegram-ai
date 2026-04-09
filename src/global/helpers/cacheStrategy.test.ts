import { collectMessageIdsToCache } from './cacheStrategy';

describe('cacheStrategy', () => {
  it('keeps the most recent loaded topic messages up to the cache limit', () => {
    const messagesById = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => {
        const messageId = index + 1;
        return [
          messageId,
          {
            id: messageId,
            chatId: 'chat-1',
          },
        ];
      }),
    ) as Record<number, { id: number; chatId: string }>;

    expect(collectMessageIdsToCache(
      messagesById,
      (message) => message.chatId === 'chat-1',
      120,
    )).toEqual(Array.from({ length: 120 }, (_, index) => index + 81));
  });
});
