import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileDirectory } from '../dist/profile.js';

test('two station profiles use independent settings and encrypted token stores', () => {
  assert.notEqual(profileDirectory('app-data', 'food'), profileDirectory('app-data', 'drinks'));
  assert.equal(profileDirectory('app-data', ''), 'app-data');
  assert.throws(() => profileDirectory('app-data', '../other'));
});
