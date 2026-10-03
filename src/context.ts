import { cut } from './text';
import type { RumConfig, UserContext } from './types';

export const MAX_GLOBAL_ATTRIBUTES = 50;
export const MAX_ATTRIBUTE_KEY_LENGTH = 128;
export const MAX_ATTRIBUTE_VALUE_LENGTH = 1024;

export class ContextManager {
  private user: UserContext = {};
  private globalAttributes = new Map<string, string>();
  readonly service?: string;
  readonly version?: string;
  readonly env?: string;

  constructor(options: RumConfig) {
    this.service = options.service;
    this.version = options.version;
    this.env = options.env;
  }

  setUser(user: UserContext): void {
    this.user = normalizeUser(user);
  }

  getUser(): UserContext {
    return this.user;
  }

  /** Ignores invalid input and anything past the caps; a long value is cut. */
  setGlobalAttribute(key: string, value: string): void {
    if (typeof key !== 'string' || typeof value !== 'string') return;
    if (key.trim() === '' || key.length > MAX_ATTRIBUTE_KEY_LENGTH) return;
    if (
      !this.globalAttributes.has(key) &&
      this.globalAttributes.size >= MAX_GLOBAL_ATTRIBUTES
    ) {
      return;
    }
    this.globalAttributes.set(key, cut(value, MAX_ATTRIBUTE_VALUE_LENGTH));
  }

  removeGlobalAttribute(key: string): void {
    if (typeof key === 'string') this.globalAttributes.delete(key);
  }

  getGlobalAttributes(): Record<string, string> {
    return Object.fromEntries(this.globalAttributes);
  }
}

// Untyped callers pass numeric ids; the intake only accepts strings.
function normalizeUser(user: UserContext | null | undefined): UserContext {
  const out: UserContext = {};
  if (!user || typeof user !== 'object') return out;
  for (const key of ['id', 'email', 'name'] as const) {
    const value: unknown = user[key];
    if (typeof value === 'string' && value !== '') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = String(value);
    }
  }
  return out;
}
