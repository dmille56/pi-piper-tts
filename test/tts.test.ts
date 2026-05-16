import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSpeechText, removeStreamFlagFromArgs} from '../extensions/tts.js';

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

void test('removeStreamFlagFromArgs removes --stream flags', () => {
  assert.deepEqual(removeStreamFlagFromArgs(['--foo']), ['--foo']);
  assert.deepEqual(
    removeStreamFlagFromArgs(['--stream', '--foo', '--stream=1', '--bar']),
    ['--foo', '--bar'],
  );
});
