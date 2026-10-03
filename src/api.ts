import type { RumConfig, UserContext } from './types';

export interface PublicAPI {
  init(config: RumConfig): Promise<void>;
  setUser(user: UserContext): void;
  setGlobalAttribute(key: string, value: string): void;
  removeGlobalAttribute(key: string): void;
  addError(error: unknown, context?: Record<string, string>): void;
  addAction(name: string, context?: Record<string, string>): void;
}

/** The methods the CDN snippet stub queues; equal to the keys of `PublicAPI`. */
export const PUBLIC_METHODS = [
  'init',
  'setUser',
  'setGlobalAttribute',
  'removeGlobalAttribute',
  'addError',
  'addAction',
] as const satisfies readonly (keyof PublicAPI)[];
