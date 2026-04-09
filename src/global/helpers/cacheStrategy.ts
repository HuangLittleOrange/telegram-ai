export function collectRecentIds(ids: number[], limit: number) {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  return Array.from(new Set(ids)).sort((left, right) => left - right).slice(-normalizedLimit);
}

export function collectMessageIdsToCache<T extends { id: number }>(
  messagesById: Record<number, T>,
  shouldInclude: (message: T) => boolean,
  limit: number,
) {
  const ids = Object.values(messagesById)
    .filter(shouldInclude)
    .map(({ id }) => id);

  return collectRecentIds(ids, limit);
}
