import * as vscode from 'vscode';
import * as parser from '@solidity-parser/parser';
import {getConfigValue} from './utils';

type Location = any;
type ContractDefinition = any;
type FunctionDefinition = any;

type CodeLenseCandiate = {
  contract: ContractDefinition;
  hasConstructorParams: boolean;
  function: FunctionDefinition;
  hasFunctionParams: boolean;
};


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
    token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    const enableSymbolicExecution = getConfigValue('enable-symbolic-excution', false);

    const codeLenses = [];
    try {
      const content = document.getText();
      const ast = parser.parse(content, {loc: true});
      const codeLenseCandiates = this.getCodeLenseCandidates(ast);
      for (const codeLenseCandiate of codeLenseCandiates) {
        const loc = codeLenseCandiate.function.loc as Location;
        const range: vscode.Range = this.locToRange(loc);

        if (!codeLenseCandiate.hasConstructorParams && !codeLenseCandiate.hasFunctionParams) {
          const debugCommand = {
            title: '▷ Debug',
            tooltip: 'Start debugging',
            command: 'simbolik.startDebugging',
            arguments: [codeLenseCandiate.contract, codeLenseCandiate.function, 'RPCDriver'],
          };
          const debugLens = new vscode.CodeLens(range, debugCommand);
          codeLenses.push(debugLens);
        }
        if (!codeLenseCandiate.hasConstructorParams && enableSymbolicExecution) {
          const symbolicCommand = {
            title: 'ᗌ Symbolic',
            tooltip: 'Start symbolic debugging',
            command: 'simbolik.startDebugging',
            arguments: [codeLenseCandiate.contract, codeLenseCandiate.function, 'KontrolDriver'],
          };
          const symdebugLens = new vscode.CodeLens(range, symbolicCommand);
          codeLenses.push(symdebugLens);
        }
      }
    } catch (e) {
      if (e instanceof parser.ParserError) {
        console.error(e.errors);
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

  private getCodeLenseCandidates(ast: any): CodeLenseCandiate[] {
    const results: CodeLenseCandiate[] = [];
    parser.visit(ast, {
      ContractDefinition: contract => {
        if (!this.canBeInstantiated(contract)) {
          return;
        }
        let hasConstructorArgs = false;
        parser.visit(contract, {
          FunctionDefinition: fn => {
            if (fn.isConstructor && fn.parameters.length > 0) {
              hasConstructorArgs = true;
            }
          },
        });
        parser.visit(contract, {
          FunctionDefinition: fn => {
            if ( this.isExecutable(fn) ) {
              results.push({
                contract,
                hasConstructorParams: hasConstructorArgs,
                function: fn,
                hasFunctionParams: fn.parameters.length > 0,
              });
            }
          },
        });
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
    token: vscode.CancellationToken
  ) {
    return codeLens;
  }
}
