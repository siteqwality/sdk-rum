// Port of core-rs `common::rum::stack` and `fingerprint` (the parts the SDK needs): frame
// locations, the normalised path, the onerror type split and error_key. rum-vectors.json pins both.
import { fnv1a32 } from './hash';

export interface Frame {
  fn?: string;
  file: string;
  line?: number;
}

const MAX_FRAMES = 100;
const MAX_LINE = 2048;

/** ASCII space, tab and carriage return only, as the Rust side trims. */
const trim = (s: string): string => s.replace(/^[ \t\r]+|[ \t\r]+$/g, '');

function splitNumber(s: string): [string, number] | null {
  const m = /^([\s\S]*):(\d{1,9})$/.exec(s);
  return m ? [m[1], Number(m[2])] : null;
}

/** `file:line:column` or `file:line`. */
function splitLineCol(loc: string): [string, number?] {
  const last = splitNumber(loc);
  if (!last) return [loc];
  const prev = splitNumber(last[0]);
  return prev ? [prev[0], prev[1]] : [last[0], last[1]];
}

function isMarker(file: string): boolean {
  const f = trim(file);
  return (
    f === 'native' ||
    f === 'unknown location' ||
    f === '[native code]' ||
    /^<[a-z ]+>$/.test(f) ||
    /^index \d+$/.test(f)
  );
}

export const hasLocation = (file: string): boolean => trim(file) !== '' && !isMarker(file);

function schemeOf(s: string): string | undefined {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(s);
  return m ? m[1].toLowerCase() : undefined;
}

function matchingOpen(s: string): number {
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === ')') depth++;
    else if (s[i] === '(') {
      if (--depth < 0) return -1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function v8Line(line: string): Frame | null {
  const t = trim(line);
  if (!t.startsWith('at ')) return null;
  const rest = trim(t.slice(3));
  if (!rest) return null;
  let fn: string | undefined;
  let loc: string;
  if (rest.endsWith(')')) {
    let open = matchingOpen(rest);
    let skip = 1;
    if (open < 0) {
      open = rest.indexOf(' (');
      skip = 2;
    }
    if (open < 0) loc = rest;
    else {
      fn = trim(rest.slice(0, open)) || undefined;
      loc = rest.slice(open + skip, rest.length - 1);
    }
  } else {
    loc = rest.startsWith('async ') ? rest.slice(6) : rest;
  }
  loc = trim(loc);
  if (loc.startsWith('eval at ')) {
    const origin = loc.slice(8);
    const close = origin.indexOf(')');
    const open = close < 0 ? -1 : origin.lastIndexOf('(', close);
    if (open >= 0) loc = origin.slice(open + 1, close);
  }
  const [file, ln] = splitLineCol(loc);
  return (ln !== undefined && file !== '') || isMarker(file) ? { fn, file, line: ln } : null;
}

function startsLikeLocation(rest: string): boolean {
  const r = trim(rest);
  return (
    r === '' ||
    r[0] === '/' ||
    r.startsWith('./') ||
    r.startsWith('../') ||
    r.startsWith('[native code]') ||
    schemeOf(r) !== undefined
  );
}

function atSign(line: string): number {
  for (let i = line.indexOf('@'); i >= 0; i = line.indexOf('@', i + 1)) {
    if (startsLikeLocation(line.slice(i + 1))) return i;
  }
  const head = splitNumber(line);
  if (!head) return -1;
  const at = line.indexOf('@');
  return at >= 0 && at < head[0].length ? at : -1;
}

function atSignLine(raw: string): Frame | null {
  const line = trim(raw);
  const at = atSign(line);
  if (at < 0) return null;
  let head = line.slice(0, at);
  const loc = trim(line.slice(at + 1));
  const star = head.lastIndexOf('*');
  if (star >= 0) head = head.slice(star + 1);
  const fn = trim(head) || undefined;
  if (!loc) return fn && !fn.includes('@') ? { fn, file: '' } : null;
  let [file, ln] = splitLineCol(loc);
  // Firefox eval frames: `url line 12 > eval`, judged at the first " line ".
  const lineAt = file.indexOf(' line ');
  const ev = lineAt < 0 ? null : /^(\d{1,9}) > /.exec(file.slice(lineAt + 6));
  if (ev) {
    ln = Number(ev[1]);
    file = file.slice(0, lineAt);
  }
  return (ln !== undefined && file !== '') || file === '[native code]' ? { fn, file, line: ln } : null;
}

/** Frames innermost first; total and never throws. */
export function parseStack(stack: string): Frame[] {
  if (typeof stack !== 'string' || !stack) return [];
  const lines = stack.split('\n').filter((l) => l.length <= MAX_LINE);
  const v8 = lines.some((l) => v8Line(l) !== null);
  const out: Frame[] = [];
  for (const l of lines) {
    const f = v8 ? v8Line(l) : atSignLine(l);
    if (f && out.push(f) >= MAX_FRAMES) break;
  }
  return out;
}

/** The first frame with a source location (6.3). */
export const topFrame = (frames: Frame[]): Frame | undefined => frames.find((f) => hasLocation(f.file));

function looksLikeHash(t: string): boolean {
  return /^[A-Za-z0-9_-]{8}$/.test(t) && (/\d/.test(t) || /[A-Z]/.test(t.slice(1)) || /^[A-Z]{8}$/.test(t));
}

function stripHashes(segment: string): string {
  const s = segment.replace(/[.-][0-9a-f]{8,}(?=[.-]|$)/g, '');
  const dot = s.lastIndexOf('.');
  if (dot < 0) return s;
  const stem = s.slice(0, dot);
  const ext = s.slice(dot);
  if (!/^\.[A-Za-z0-9]{1,5}$/.test(ext)) return s;
  if (stem.length >= 9) {
    const name = stem.slice(0, -8);
    if (/[.-]$/.test(name) && looksLikeHash(stem.slice(-8))) return name.slice(0, -1) + ext;
  }
  const hexStem = stem.length >= 8 && /^[0-9a-fA-F]+$/.test(stem) && /\d/.test(stem);
  return (stem.length === 8 && looksLikeHash(stem)) || hexStem ? `[hash]${ext}` : s;
}

/** The grouping path (5.7): no origin, query, fragment, `.` segments or content hashes. */
export function normalisePath(raw: string): string {
  const file = trim(raw);
  if (!hasLocation(file)) return file;
  const scheme = schemeOf(file);
  if (scheme === 'blob') return '<blob>';
  if (scheme === 'data') return '<data>';
  const cutAt = file.search(/[?#]/);
  const f = cutAt < 0 ? file : file.slice(0, cutAt);
  let path = f;
  if (scheme && f.slice(scheme.length + 1, scheme.length + 3) === '//') {
    const rest = f.slice(scheme.length + 3);
    const slash = rest.indexOf('/');
    path = slash < 0 ? '/' : rest.slice(slash);
  }
  let absolute = path[0] === '/';
  let segs = path.split('/').filter((s) => s !== '.');
  if (absolute) segs.shift();
  else while (segs[0] === '..') segs.shift();
  const nm = segs.lastIndexOf('node_modules');
  if (nm >= 0) {
    segs = segs.slice(nm + 1);
    absolute = false;
  }
  return (absolute ? '/' : '') + segs.map(stripHashes).join('/');
}

export const topFramePath = (frames: Frame[]): string => {
  const f = topFrame(frames);
  return f ? normalisePath(f.file) : '';
};

/** `onerror` message to [type, message], as core-rs `split_error_message`. */
export function splitErrorMessage(raw: string): [string, string] {
  let s = raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (s.startsWith('Uncaught ')) s = s.slice(9);
  if (s.startsWith('(in promise) ')) s = s.slice(13);
  const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(s);
  const id = m ? m[0] : '';
  if (id.length <= 64 && /(Error|Exception)$/.test(id)) {
    const rest = s.slice(id.length);
    if (!rest) return [id, ''];
    if (rest.startsWith(': ')) return [id, rest.slice(2)];
  }
  return ['Error', s];
}

/** The string error_key hashes: type, first line with digit runs as 0, top frame path. */
export function errorKeyInput(type: string, message: string, path: string): string {
  const line = message.split(/[\n\r]/, 1)[0];
  return `${type}|${line.replace(/[0-9]+/g, '0')}|${path}`;
}

export const errorKey = (type: string, message: string, path: string): number =>
  fnv1a32(errorKeyInput(type, message, path));
