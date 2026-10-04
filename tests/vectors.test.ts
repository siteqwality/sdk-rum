import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fnv1a32, sampledIn } from '../src/core/hash';
import {
  parseStack,
  normalisePath,
  topFramePath,
  splitErrorMessage,
  errorKey,
  errorKeyInput,
} from '../src/core/stack';

// tests/fixtures/rum-vectors.json is byte-identical to core-rs common/src/rum/testdata/.
const raw = readFileSync(join(__dirname, 'fixtures/rum-vectors.json'), 'utf8');
const v = JSON.parse(raw);

describe('shared RUM vectors (SDK side)', () => {
  it('is version 1 of the contract', () => {
    expect(v.version).toBe(1);
  });

  it.each(v.fnv1a32.map((c: { input: string; hash: number }) => [c.input, c.hash]))('fnv1a32(%j)', (input, hash) => {
    expect(fnv1a32(input as string)).toBe(hash);
  });

  it('rule sampling', () => {
    for (const c of v.rule_sampling) {
      const key = `${c.session_id}:${c.rule_id}`;
      expect(fnv1a32(key), key).toBe(c.hash);
      expect(sampledIn(key, c.sample_rate), key).toBe(c.sampled);
    }
  });

  it('splits onerror messages', () => {
    for (const c of v.split_error_message) {
      expect(splitErrorMessage(c.input), c.input).toEqual([c.error_type, c.message]);
    }
  });

  it('normalises paths', () => {
    for (const c of v.normalise_path) expect(normalisePath(c.input), c.input).toBe(c.output);
  });

  it('computes error keys', () => {
    for (const c of v.error_key) {
      expect(errorKeyInput(c.error_type, c.message, c.top_frame_path)).toBe(c.key_input);
      expect(errorKey(c.error_type, c.message, c.top_frame_path)).toBe(c.error_key);
    }
  });

  it('parses every stack in the corpus to the same frames, top frame and error key', () => {
    expect(v.stacks.length).toBeGreaterThanOrEqual(200);
    for (const c of v.stacks) {
      const frames = parseStack(c.stack);
      const want = c.frames.map((f: { function?: string; file: string; line?: number }) => ({
        fn: f.function,
        file: f.file,
        line: f.line,
      }));
      expect(frames.map((f) => ({ fn: f.fn, file: f.file, line: f.line })), c.name).toEqual(want);
      expect(topFramePath(frames), c.name).toBe(c.top_frame_path);
      expect(errorKey(c.error_type, c.message, topFramePath(frames)), c.name).toBe(c.error_key);
    }
  });

  it('gives one error key to the same bug across bundle hashes', () => {
    const stack = (hash: string) =>
      `TypeError: x is null\n    at save (https://app.example.com/assets/app-${hash}.js:4:24)`;
    const key = (hash: string) => errorKey('TypeError', 'x is null', topFramePath(parseStack(stack(hash))));
    expect(key('BKjK5o9P')).toBe(key('Dz9_q1Lm'));
  });
});
