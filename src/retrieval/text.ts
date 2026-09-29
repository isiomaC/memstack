// Tokenizing and stemming for Core lexical retrieval. Kept dependency-free
// so recall behaves the same on every storage adapter.

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does", "for", "from",
  "how", "i", "in", "is", "it", "its", "me", "my", "of", "on", "or", "our", "that", "the",
  "this", "to", "was", "we", "were", "what", "when", "where", "which", "who", "why",
  "with", "you", "your",
  // Verbs that frame a question ("what do we use?") without saying what it is about.
  "can", "could", "has", "have", "should", "use", "used", "uses", "using", "would",
]);

/** Lowercased words, split on anything that is not a letter or digit. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Stemmed query terms, without stopwords unless the query has nothing else. */
export function queryTerms(text: string): string[] {
  const words = [...new Set(tokenize(text))];
  const meaningful = words.filter((w) => !STOPWORDS.has(w));
  return [...new Set((meaningful.length > 0 ? meaningful : words).map(stem))];
}

/** Stemmed document terms, stopwords included so term frequencies stay honest. */
export function documentTerms(text: string): string[] {
  return tokenize(text).map(stem);
}

// Porter stemmer (M. F. Porter, 1980), for ASCII English words. Words with
// other characters, and words shorter than three letters, are returned as-is.

const STEP2: Record<string, string> = {
  ational: "ate", tional: "tion", enci: "ence", anci: "ance", izer: "ize", bli: "ble",
  alli: "al", entli: "ent", eli: "e", ousli: "ous", ization: "ize", ation: "ate",
  ator: "ate", alism: "al", iveness: "ive", fulness: "ful", ousness: "ous", aliti: "al",
  iviti: "ive", biliti: "ble", logi: "log",
};

const STEP3: Record<string, string> = {
  icate: "ic", ative: "", alize: "al", iciti: "ic", ical: "ic", ful: "", ness: "",
};

// The lazy prefix makes the regex strip the longest matching suffix.
const STEP4 = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;

const C = "[^aeiou]";
const V = "[aeiouy]";
const CS = `${C}[^aeiouy]*`;
const VS = `${V}[aeiou]*`;
const MGR0 = new RegExp(`^(${CS})?${VS}${CS}`);
const MEQ1 = new RegExp(`^(${CS})?${VS}${CS}(${VS})?$`);
const MGR1 = new RegExp(`^(${CS})?${VS}${CS}${VS}${CS}`);
const HAS_VOWEL = new RegExp(`^(${CS})?${V}`);
const CVC = new RegExp(`^${CS}${V}[^aeiouwxy]$`);

export function stem(word: string): string {
  if (word.length < 3 || !/^[a-z]+$/.test(word)) return word;

  let w = word;
  const firstY = w[0] === "y";
  if (firstY) w = "Y" + w.slice(1);

  // Step 1a
  if (/(ss|i)es$/.test(w)) w = w.slice(0, -2);
  else if (/[^s]s$/.test(w)) w = w.slice(0, -1);

  // Step 1b
  let m: RegExpMatchArray | null;
  if ((m = w.match(/^(.+?)eed$/))) {
    if (MGR0.test(m[1])) w = w.slice(0, -1);
  } else if ((m = w.match(/^(.+?)(ed|ing)$/))) {
    const base = m[1];
    if (HAS_VOWEL.test(base)) {
      w = base;
      if (/(at|bl|iz)$/.test(w)) w += "e";
      else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1);
      else if (CVC.test(w)) w += "e";
    }
  }

  // Step 1c
  if ((m = w.match(/^(.+?)y$/)) && HAS_VOWEL.test(m[1])) w = m[1] + "i";

  // Step 2
  if ((m = w.match(/^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/))) {
    if (MGR0.test(m[1])) w = m[1] + STEP2[m[2]];
  }

  // Step 3
  if ((m = w.match(/^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/))) {
    if (MGR0.test(m[1])) w = m[1] + STEP3[m[2]];
  }

  // Step 4
  if ((m = w.match(STEP4))) {
    if (MGR1.test(m[1])) w = m[1];
  } else if ((m = w.match(/^(.+?)(s|t)(ion)$/))) {
    const base = m[1] + m[2];
    if (MGR1.test(base)) w = base;
  }

  // Step 5
  if ((m = w.match(/^(.+?)e$/))) {
    const base = m[1];
    if (MGR1.test(base) || (MEQ1.test(base) && !CVC.test(base))) w = base;
  }
  if (/ll$/.test(w) && MGR1.test(w)) w = w.slice(0, -1);

  if (firstY) w = "y" + w.slice(1);
  return w;
}
