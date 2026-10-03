import type { RumConfig, UserContext } from './types';

export interface PublicAPI {
  init(config: RumConfig): Promise<void>;
  setUser(user: UserContext): void;
  setGlobalAttribute(key: string, value: string): void;
  removeGlobalAttribute(key: string): void;
  addError(error: Error, context?: Record<string, string>): void;
  addAction(name: string, context?: Record<string, string>): void;
}
