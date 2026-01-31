import test from 'node:test';
import assert from 'node:assert/strict';
import { GameError } from '../../../lib/game-engine/errors';

test('GameError construction and serialization', () => {
  const err = new GameError('TEST_CODE', 'Something went wrong');

  assert.ok(err instanceof Error);
  assert.equal(err.name, 'GameError');
  assert.equal(err.code, 'TEST_CODE');
  assert.equal(err.message, 'Something went wrong');
  assert.deepEqual(err.toJSON(), { code: 'TEST_CODE', message: 'Something went wrong' });
});

