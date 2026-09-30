import { describe, it, expect } from "vitest";
import { stem, tokenize, queryTerms } from "../src/retrieval/text.js";

describe("stem", () => {
  // Reference outputs of the Porter algorithm.
  const cases: Record<string, string> = {
    caresses: "caress", ponies: "poni", ties: "ti", caress: "caress", cats: "cat",
    feed: "feed", agreed: "agre", plastered: "plaster", bled: "bled", motoring: "motor",
    sing: "sing", conflated: "conflat", troubled: "troubl", sized: "size", hopping: "hop",
    tanned: "tan", falling: "fall", hissing: "hiss", fizzed: "fizz", failing: "fail",
    filing: "file", happy: "happi", sky: "sky", relational: "relat", conditional: "condit",
    rational: "ration", digitizer: "digit", operator: "oper", feudalism: "feudal",
    decisiveness: "decis", hopefulness: "hope", callousness: "callous", triplicate: "triplic",
    formative: "form", electrical: "electr", hopeful: "hope", goodness: "good",
    revival: "reviv", allowance: "allow", inference: "infer", airliner: "airlin",
    adjustable: "adjust", defensible: "defens", irritant: "irrit", replacement: "replac",
    adjustment: "adjust", dependent: "depend", adoption: "adopt", communism: "commun",
    activate: "activ", homologous: "homolog", effective: "effect", bowdlerize: "bowdler",
    probate: "probat", rate: "rate", cease: "ceas", controll: "control", roll: "roll",
    generalizations: "gener", oscillators: "oscil",
    uses: "us", use: "us", running: "run", runs: "run", frameworks: "framework",
  };

  for (const [word, expected] of Object.entries(cases)) {
    it(`${word} -> ${expected}`, () => expect(stem(word)).toBe(expected));
  }

  it("leaves short, non-ASCII, and numeric words unchanged", () => {
    expect(stem("is")).toBe("is");
    expect(stem("café")).toBe("café");
    expect(stem("2026")).toBe("2026");
  });
});

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumerics, keeping Unicode letters", () => {
    expect(tokenize('Uses Hono; "web-server" v4 — café')).toEqual(["uses", "hono", "web", "server", "v4", "café"]);
  });
});

describe("queryTerms", () => {
  it("drops stopwords, stems, and de-duplicates", () => {
    expect(queryTerms("What framework does this project use? Frameworks!")).toEqual(["framework", "project"]);
  });

  it("keeps stopwords when nothing else is left", () => {
    expect(queryTerms("the")).toEqual(["the"]);
  });

  it("returns nothing for text without words", () => {
    expect(queryTerms("?! --")).toEqual([]);
  });
});
