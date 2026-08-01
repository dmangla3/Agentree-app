export interface FuzzyMatchResult<T> {
    item: T;
    score: number;
}

export function getFuzzyMatchScore(query: string, target: string): number | null {
    const normalizedQuery = query.trim().toLowerCase();
    const normalizedTarget = target.trim().toLowerCase();

    if (!normalizedQuery) return 0;
    if (!normalizedTarget) return null;

    const contiguousIndex = normalizedTarget.indexOf(normalizedQuery);
    if (contiguousIndex !== -1) {
        return contiguousIndex;
    }

    let queryIndex = 0;
    let score = normalizedTarget.length;
    let lastMatchedIndex = -1;

    for (let i = 0; i < normalizedTarget.length && queryIndex < normalizedQuery.length; i += 1) {
        if (normalizedTarget[i] !== normalizedQuery[queryIndex]) continue;

        score += lastMatchedIndex === -1 ? i : i - lastMatchedIndex - 1;
        lastMatchedIndex = i;
        queryIndex += 1;
    }

    if (queryIndex !== normalizedQuery.length) {
        return null;
    }

    return score;
}

export function fuzzyFilterAndSort<T>(
    items: T[],
    query: string,
    getSearchText: (item: T) => string
): T[] {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return items;

    return items
        .map((item) => {
            const score = getFuzzyMatchScore(normalizedQuery, getSearchText(item));
            return score === null ? null : { item, score } satisfies FuzzyMatchResult<T>;
        })
        .filter((result): result is FuzzyMatchResult<T> => result !== null)
        .sort((a, b) => a.score - b.score || getSearchText(a.item).localeCompare(getSearchText(b.item)))
        .map((result) => result.item);
}
