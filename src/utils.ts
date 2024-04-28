import * as vscode from 'vscode';

/**
 * Get a configuration value from the extension configuration.
 *
 * If the value is not set, return the fallback value.
 */
export function getConfigValue<T = string>(key: string, fallback: T): T {
  const config = vscode.workspace.getConfiguration('simbolik');
  const value = config.get<T>(key);
  if (value === undefined || value === '') {
    return fallback;
  }
  return value;
}
