import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import test from "node:test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Fixture paths relative to this file
const FIXTURE_DIR = join(__dirname, "fixtures", "eval");

interface RetrievalQualityCase {
  id: string;
  question: string;
  expectedFiles: string[];
  expectedAnswerContains: string;
  difficulty: "easy" | "standard" | "hard";
  tags: string[];
}

interface RoutingChoiceCase {
  id: string;
  question: string;
  expectedIntent: string;
  expectedDepth: string;
  expectedProfile: string;
  difficulty: "easy" | "standard" | "hard";
  tags: string[];
}

interface AnswerGroundingCase {
  id: string;
  question: string;
  expectedAnswerContains: string[];
  minCitations: number;
  difficulty: "easy" | "standard" | "hard";
  tags: string[];
}

function loadJsonCases<T>(filename: string): T[] {
  const path = join(FIXTURE_DIR, filename);
  const raw = readFileSync(path, { encoding: "utf8" });
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed), `${filename} must be a JSON array`);
  return parsed as T[];
}

test("eval fixtures: retrieval-quality.json is valid and well-formed", () => {
  const cases = loadJsonCases<RetrievalQualityCase>("retrieval-quality.json");
  assert.ok(cases.length >= 10, `Expected at least 10 retrieval cases, got ${cases.length}`);

  for (const c of cases) {
    assert.ok(c.id, `Case missing id: ${JSON.stringify(c)}`);
    assert.ok(c.question && c.question.length > 5, `Case ${c.id}: question too short`);
    assert.ok(Array.isArray(c.expectedFiles) && c.expectedFiles.length > 0, `Case ${c.id}: expectedFiles must be non-empty array`);
    assert.ok(typeof c.expectedAnswerContains === "string", `Case ${c.id}: expectedAnswerContains must be string`);
    assert.ok(["easy", "standard", "hard"].includes(c.difficulty), `Case ${c.id}: invalid difficulty`);
    assert.ok(Array.isArray(c.tags) && c.tags.length > 0, `Case ${c.id}: tags must be non-empty array`);
  }

  const ids = new Set(cases.map((c) => c.id));
  assert.equal(ids.size, cases.length, "All retrieval case ids must be unique");
});

test("eval fixtures: routing-choices.json is valid and well-formed", () => {
  const cases = loadJsonCases<RoutingChoiceCase>("routing-choices.json");
  assert.ok(cases.length >= 10, `Expected at least 10 routing cases, got ${cases.length}`);

  for (const c of cases) {
    assert.ok(c.id, `Case missing id: ${JSON.stringify(c)}`);
    assert.ok(c.question && c.question.length > 5, `Case ${c.id}: question too short`);
    assert.ok(c.expectedIntent, `Case ${c.id}: expectedIntent missing`);
    assert.ok(c.expectedDepth, `Case ${c.id}: expectedDepth missing`);
    assert.ok(c.expectedProfile, `Case ${c.id}: expectedProfile missing`);
    assert.ok(["easy", "standard", "hard"].includes(c.difficulty), `Case ${c.id}: invalid difficulty`);
    assert.ok(Array.isArray(c.tags) && c.tags.length > 0, `Case ${c.id}: tags must be non-empty array`);
  }

  const ids = new Set(cases.map((c) => c.id));
  assert.equal(ids.size, cases.length, "All routing case ids must be unique");
});

test("eval fixtures: answer-grounding.json is valid and well-formed", () => {
  const cases = loadJsonCases<AnswerGroundingCase>("answer-grounding.json");
  assert.ok(cases.length >= 10, `Expected at least 10 grounding cases, got ${cases.length}`);

  for (const c of cases) {
    assert.ok(c.id, `Case missing id: ${JSON.stringify(c)}`);
    assert.ok(c.question && c.question.length > 5, `Case ${c.id}: question too short`);
    assert.ok(Array.isArray(c.expectedAnswerContains) && c.expectedAnswerContains.length > 0, `Case ${c.id}: expectedAnswerContains must be non-empty array`);
    assert.ok(typeof c.minCitations === "number" && c.minCitations >= 0, `Case ${c.id}: minCitations must be non-negative number`);
    assert.ok(["easy", "standard", "hard"].includes(c.difficulty), `Case ${c.id}: invalid difficulty`);
    assert.ok(Array.isArray(c.tags) && c.tags.length > 0, `Case ${c.id}: tags must be non-empty array`);
  }

  const ids = new Set(cases.map((c) => c.id));
  assert.equal(ids.size, cases.length, "All grounding case ids must be unique");
});

test("eval fixtures: fixtures can be loaded via the eval repo schema", () => {
  // Verify each fixture file's shape is compatible with EvalCaseRecord fields
  const retrievalCases = loadJsonCases<RetrievalQualityCase>("retrieval-quality.json");
  const routingCases = loadJsonCases<RoutingChoiceCase>("routing-choices.json");
  const groundingCases = loadJsonCases<AnswerGroundingCase>("answer-grounding.json");

  assert.ok(retrievalCases.length >= 10, "Need at least 10 retrieval quality cases");
  assert.ok(routingCases.length >= 10, "Need at least 10 routing choice cases");
  assert.ok(groundingCases.length >= 10, "Need at least 10 answer grounding cases");

  // Each case maps to a valid eval case shape for addCase()
  for (const c of retrievalCases) {
    const evalCaseShape = {
      question: c.question,
      expectedFiles: c.expectedFiles,
      expectedAnswerContains: c.expectedAnswerContains,
      difficulty: c.difficulty,
      tags: c.tags,
    };
    assert.ok(typeof evalCaseShape.question === "string", "question must be string");
    assert.ok(Array.isArray(evalCaseShape.expectedFiles), "expectedFiles must be array");
    assert.ok(Array.isArray(evalCaseShape.tags), "tags must be array");
  }
});
