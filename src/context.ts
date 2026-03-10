import type { RumConfig, UserContext } from './types';

export class ContextManager {
  private user: UserContext = {};
  private globalAttributes: Record<string, string> = {};
  readonly service?: string;
  readonly version?: string;
  readonly env?: string;

  constructor(options: RumConfig) {
    this.service = options.service;
    this.version = options.version;
    this.env = options.env;
  }

  setUser(user: UserContext): void {
    this.user = { ...user };
  }

  getUser(): UserContext {
    return this.user;
  }

  setGlobalAttribute(key: string, value: string): void {
    this.globalAttributes[key] = value;
  }

  getGlobalAttributes(): Record<string, string> {
    return { ...this.globalAttributes };
  }
}
