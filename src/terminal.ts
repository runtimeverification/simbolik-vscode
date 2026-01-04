import * as vscode from 'vscode';

/**
 * This module provides utilities for executing commands in VSCode terminals.
 * 
 * Running subprocesses in VSCode terminals ensures that the commands
 * are executed in the same environment as the user would have
 * when using the integrated terminal.
 * 
 * Additionally, the terminal can be shown to the user if an error occurs,
 * allowing them to see the error output directly.
 * 
 * VSCode tasks offer similar functionality, but they don't allow capturing
 * the command output programmatically.
 */

/**
 * Run a command in a VSCode terminal and capture its output.
 * 
 * @param cmd The command to execute.
 * @param options Terminal options such as cwd and env.
 * @param revealOnError Whether to reveal the terminal if the command fails.
 * @returns The standard output of the command (with terminal control sequences stripped).
 */
export
async function executeInTerminal(cmd: string, options: vscode.TerminalOptions = {}, revealOnError: boolean = false): Promise<string> {
  const terminal = await createTerminal({ name: options.name ?? cmd, hideFromUser: true, ...options });
  const done = await executeCommand(cmd, terminal);
  const outputStream = done.execution.read();
  if (done.exitCode !== 0) {
    if (revealOnError) {
      terminal.show();
    } else {
      terminal.dispose();
    }
    throw new Error(`${cmd} failed with exit code ${done.exitCode}`);
  }
  const rawOutput = await streamToString(outputStream);
  const filteredOutput = stripTerminalControlSequences(rawOutput);
  terminal.dispose();
  return filteredOutput;
}

/**
 * Create a VSCode terminal and wait for shell integration to be ready.
 * 
 * @param options Terminal options.
 * @returns A promise that resolves to the created terminal once shell integration is ready.
 */
export
function createTerminal(options: vscode.TerminalOptions = {}): Promise<vscode.Terminal> {
  const terminal = vscode.window.createTerminal(options);
  const done = new Promise<vscode.Terminal>((resolve, reject) => {
    const disposible = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal !== terminal) {
        return;
      }
      disposible.dispose();
      resolve(terminal);
    });
  });
  return done;
}

/**
 * Execute a command in a given VSCode terminal and wait for it to finish.
 * 
 * @param cmd The command to execute.
 * @param terminal The terminal in which to execute the command.
 * @returns A promise that resolves to the terminal shell execution end event.
 */
export
function executeCommand(cmd: string, terminal: vscode.Terminal): Promise<vscode.TerminalShellExecutionEndEvent> {
  const done = new Promise<vscode.TerminalShellExecutionEndEvent>((resolve, reject) => {
    const execution = terminal.shellIntegration!.executeCommand(cmd);
    const didStop = vscode.window.onDidEndTerminalShellExecution(async (e) => {
      if (e.execution !== execution) {
        return;
      }
      didStop.dispose();
      resolve(e);
    });
  });
  return done;
}

/**
 * Convert an async iterable stream of strings into a single concatenated string.
 * 
 * @param stream The async iterable stream of strings to convert.
 * @returns A promise that resolves to the concatenated string.
 */
async function streamToString(stream: AsyncIterable<string>): Promise<string> {
  let result = '';
  for await (const chunk of stream) {
    result += chunk;
  }
  return result;
}

/**
 * Remove terminal control sequences from a string.
 * 
 * @param input The string from which to remove terminal control sequences.
 * @returns The input string with terminal control sequences removed.
 */
function stripTerminalControlSequences(input: string): string {
  // OSC: ESC ] ... BEL  OR  ESC ] ... ESC \
  const osc = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

  // CSI: ESC [ ... (covers colors, cursor moves, erase, etc.)
  const csi = /\x1b\[[0-?]*[ -/]*[@-~]/g;

  // DCS: ESC P ... ESC \
  const dcs = /\x1bP[^\x1b]*(?:\x1b\\)/g;

  // Other single-char ESC sequences (less common, but cheap to remove)
  const esc = /\x1b[@-Z\\-_]/g;

  return input
    .replace(osc, '')
    .replace(dcs, '')
    .replace(csi, '')
    .replace(esc, '');
}