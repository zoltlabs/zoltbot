// A8: fuzzy search over model and provider names. Higher scores rank first; 0 means no match.

/** How well one query word matches one text: word start, anywhere, or letters in order. */
function wordScore(word: string, text: string): number {
  const at = text.indexOf(word);
  if (at === 0) return 4;
  if (at > 0) return /[\s\-_./:(]/.test(text[at - 1] ?? "") ? 3 : 2;
  let from = 0;
  for (const char of word) {
    from = text.indexOf(char, from) + 1;
    if (from === 0) return 0;
  }
  return 1;
}

/**
 * Scores a model for a query. Every word must match the model's name or its provider's name.
 * Name matches count double, so "son" ranks a Sonnet model above a provider that merely
 * contains the letters.
 */
export function modelSearchScore(query: string, name: string, provider = ""): number {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const label = name.toLowerCase();
  const group = provider.toLowerCase();
  let total = 0;
  for (const word of words) {
    const score = Math.max(wordScore(word, label) * 2, wordScore(word, group));
    if (score === 0) return 0;
    total += score;
  }
  // A name that starts with the whole query is the likeliest pick.
  return label.startsWith(query.trim().toLowerCase()) ? total + 2 : total;
}
