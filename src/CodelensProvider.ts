import * as vscode from 'vscode';
import * as parser from '@solidity-parser/parser';
import { getConfigValue } from './utils';

type Location = any;
type ContractDefinition = any;
type FunctionDefinition = any;

/**
 * CodelensProvider
 */
export class CodelensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> =
    this._onDidChangeCodeLenses.event;

  constructor() {
    vscode.workspace.onDidChangeConfiguration(() => {
      this._onDidChangeCodeLenses.fire();
    });
  }

  public async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    const codeLenses = [];
    try {
      const content = document.getText();
      const ast = parser.parse(content, { loc: true });
      const functions = this.getFunctions(ast);
      for (const [contract, f] of functions) {
        const loc = f.loc as Location;
        const range: vscode.Range = this.locToRange(loc);
        const debugCommand = {
          title: '▷ Debug',
          tooltip: 'Start symbolic debugging',
          command: 'simbolik.startDebugging',
          arguments: [contract, f],
        };
        const debugLens = new vscode.CodeLens(range, debugCommand);
        codeLenses.push(debugLens);
      }
    } catch (error) {
      if (error instanceof parser.ParserError) {
        console.error(error.errors);
      }
      return [];
    }
    return codeLenses;
  }

  private locToRange(loc: Location): vscode.Range {
    const start = new vscode.Position(loc.start.line - 1, loc.start.column);
    const end = new vscode.Position(loc.end.line - 1, loc.end.column);
    return new vscode.Range(start, end);
  }

  private getFunctions(ast: any): [ContractDefinition, FunctionDefinition][] {
    const results: [ContractDefinition, FunctionDefinition][] = [];
    parser.visit(ast, {
      ContractDefinition: (contract) => {
        if (!this.canBeInstantiated(contract)) {
          return;
        }
        let hasConstructorArgs = false;
        parser.visit(contract, {
          FunctionDefinition: (fn) => {
            if (fn.isConstructor && fn.parameters.length > 0) {
              hasConstructorArgs = true;
            }
          },
        });
        if (!hasConstructorArgs) {
          parser.visit(contract, {
            FunctionDefinition: (fn) => {
              if (this.isExecutable(fn) && fn.parameters.length === 0) {
                results.push([contract, fn]);
              }
            },
          });
        }
      },
    });
    return results;
  }

  private canBeInstantiated(contract: ContractDefinition): boolean {
    return contract.kind === 'contract';
  }

  private isExecutable(fn: FunctionDefinition): boolean {
    if (fn.isConstructor) return false;
    if (fn.isVirtual) return false;
    if (fn.isFallback) return false;
    return ['external', 'public', 'default'].includes(fn.visibility);
  }

  public resolveCodeLens(
    codeLens: vscode.CodeLens,
    token: vscode.CancellationToken,
  ) {
    return codeLens;
  }
}
