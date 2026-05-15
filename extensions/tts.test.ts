import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSpeechText} from './tts.js';

void test('normalizeSpeechText strips double-asterisks', () => {
  assert.equal(normalizeSpeechText('**bold**'), 'bold');
  assert.equal(normalizeSpeechText('hello **world**'), 'hello world');
  assert.equal(
    normalizeSpeechText('hello **world**  and  **more**'),
    'hello world and more',
  );
  assert.equal(normalizeSpeechText(' **bold** '), 'bold');
});

void test('normalizeSpeechText does not strip single asterisks', () => {
  assert.equal(normalizeSpeechText('hello *world*'), 'hello *world*');
});
