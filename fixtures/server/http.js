import fs from 'node:fs';
import path from 'node:path';

export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

export function readBody(req, limit = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function send(res, status, body = '', headers = {}) {
  if (res.headersSent || res.destroyed) return;
  const isJson = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...(isJson ? { 'Content-Type': 'application/json' } : {}),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export const contentType = (file) => TYPES[path.extname(file)] || 'application/octet-stream';

// Resolves a request path inside root, refusing traversal.
export function resolveInside(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const file = path.resolve(root, `.${decoded}`);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

export function serveFile(res, file, headers = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  send(res, 200, fs.readFileSync(file), { 'Content-Type': contentType(file), ...headers });
  return true;
}
