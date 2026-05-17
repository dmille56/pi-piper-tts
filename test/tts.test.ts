import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSpeechText,
  removeStreamFlagFromArgs,
  parseVolume,
  buildFfplayArgs,
} from '../extensions/tts.js';

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

void test('parseVolume returns empty object for undefined', () => {
  assert.deepEqual(parseVolume(undefined), {});
});

void test('parseVolume accepts 0 and 1 (inclusive)', () => {
  assert.equal(parseVolume(0).value, 0);
  assert.equal(parseVolume(1).value, 1);

  assert.equal(parseVolume('0').value, 0);
  assert.equal(parseVolume('1').value, 1);
});

void test('parseVolume accepts fractional values', () => {
  assert.equal(parseVolume('0.5').value, 0.5);
});

void test('parseVolume rejects negative and >1 values', () => {
  assert.equal(parseVolume(-0.01).value, undefined);
  assert.ok(parseVolume(-0.01).error);

  assert.equal(parseVolume(1.01).value, undefined);
  assert.ok(parseVolume(1.01).error);
});

void test('parseVolume rejects non-numeric values', () => {
  assert.equal(parseVolume('nope').value, undefined);
  assert.ok(parseVolume('nope').error);
});

void test('buildFfplayArgs includes no volume filter when volume is undefined', () => {
  assert.deepEqual(buildFfplayArgs({wavPath: '/tmp/a.wav'}), [
    '-nodisp',
    '-autoexit',
    '-loglevel',
    'quiet',
    '/tmp/a.wav',
  ]);
});

void test('buildFfplayArgs includes volume filter when volume is provided', () => {
  assert.deepEqual(buildFfplayArgs({volume: 0, wavPath: '/tmp/a.wav'}), [
    '-nodisp',
    '-autoexit',
    '-loglevel',
    'quiet',
    '-af',
    'volume=0',
    '/tmp/a.wav',
  ]);

  assert.deepEqual(buildFfplayArgs({volume: 1, wavPath: '/tmp/a.wav'}), [
    '-nodisp',
    '-autoexit',
    '-loglevel',
    'quiet',
    '-af',
    'volume=1',
    '/tmp/a.wav',
  ]);
});
