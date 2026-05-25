import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rating, State } from 'ts-fsrs';
import {
  nextFsrsCard,
  previewFsrs,
  ratingFromInput,
  retrievability,
  serializeCard,
} from './fsrs.ts';

const NOW = Date.UTC(2026, 4, 25, 8, 0, 0);

test('ratingFromInput accepts FSRS grade names case-insensitively', () => {
  assert.equal(ratingFromInput('again'), Rating.Again);
  assert.equal(ratingFromInput('Hard'), Rating.Hard);
  assert.equal(ratingFromInput('GOOD'), Rating.Good);
  assert.equal(ratingFromInput('easy'), Rating.Easy);
  assert.equal(ratingFromInput('manual'), null);
});

test('new card review creates durable card state', () => {
  const result = nextFsrsCard(null, NOW, Rating.Good);
  const card = serializeCard(result.card);

  assert.equal(card.reps, 1);
  assert.equal(card.lapses, 0);
  assert.notEqual(card.state, State.New);
  assert.equal(card.last_review_at, NOW);
  assert.ok(card.due_at > NOW);
  assert.ok(card.stability > 0);
  assert.ok(card.difficulty > 0);
});

test('preview exposes all four rating outcomes', () => {
  const preview = previewFsrs(null, NOW);

  assert.ok(preview.again.due_at > NOW);
  assert.ok(preview.hard.due_at > NOW);
  assert.ok(preview.good.due_at > NOW);
  assert.ok(preview.easy.due_at > NOW);
});

test('retrievability is null for new cards and numeric after review', () => {
  assert.equal(retrievability(null, NOW), null);

  const reviewed = serializeCard(nextFsrsCard(null, NOW, Rating.Good).card);
  const value = retrievability(reviewed, NOW + 60_000);
  assert.equal(typeof value, 'number');
  assert.ok(value !== null && value > 0 && value <= 1);
});
