import * as vscode from 'vscode';
import {
  testFiles,
  forgeTest,
  forgeCoverage,
  ForgeTestOptions,
  ForgeTestSuiteReport,
} from './foundry';

import * as parser from '@solidity-parser/parser';
import {
  ContractDefinition,
  FunctionDefinition,
} from '@solidity-parser/parser/dist/src/ast-types';
import {startDebugging} from './startDebugging';
import {LcovRecord} from './lcov';

export async function createTestController(): Promise<vscode.TestController> {
  const testController = vscode.tests.createTestController(
    'simbolik-test-controller',
    'Foundry Tests'
  );

  let testTree: IndexedTestTree = await createTestTree(testController);

  const debugProfile = testController.createRunProfile(
    'Debug Foundry Tests',
    vscode.TestRunProfileKind.Debug,
    async (request, token) => {
      for (const item of request.include ?? []) {
        const {workspaceFolder, file, contract, method}: TestContext =
          testTree.items.get(item) ?? {};
        if (!contract || !method) {
          vscode.window.showErrorMessage(
            'Can only debug individual test methods.'
          );
          continue;
        }
        startDebugging(file!, contract, method);
      }
    },
    false,
    tag('debug')
  );

  const runProfile = createFoundryProfile(
    testController,
    testTree,
    vscode.TestRunProfileKind.Run
  );
  const coverageCache: WeakMap<
    vscode.FileCoverage,
    vscode.StatementCoverage[]
  > = new WeakMap();
  const coverageProfile = createFoundryProfile(
    testController,
    testTree,
    vscode.TestRunProfileKind.Coverage,
    coverageCache
  );

  coverageProfile.loadDetailedCoverage = (
    testRun: vscode.TestRun,
    fileCoverage: vscode.FileCoverage,
    token: vscode.CancellationToken
  ): Thenable<vscode.FileCoverageDetail[]> => {
    const cached = coverageCache.get(fileCoverage);
    return Promise.resolve(cached ?? []);
  };

  testController.refreshHandler = async () => {
    testTree = await createTestTree(testController);
  };

  vscode.workspace.onDidChangeWorkspaceFolders(async () => {
    testTree = await createTestTree(testController);
  });

  return testController;
}

type TestContext = {
  workspaceFolder?: vscode.WorkspaceFolder;
  file?: vscode.Uri;
  contract?: ContractDefinition;
  method?: FunctionDefinition;
};

function testContextToTestOptions(context: TestContext): ForgeTestOptions {
  const options: ForgeTestOptions = {};
  if (context.file) {
    options.path = vscode.workspace.asRelativePath(context.file, false);
  }
  if (context.contract) {
    options.contract = context.contract.name;
  }
  if (context.method && context.method.name) {
    options.test = context.method.name;
  }
  return options;
}

class IndexedTestTree {
  public items = new Map<vscode.TestItem, TestContext>();

  matchLeafs(
    context: TestContext
  ): Map<vscode.TestItem, Required<TestContext>> {
    const results = new Map<vscode.TestItem, Required<TestContext>>();
    for (const [item, ctx] of this.items) {
      if (ctx.method === undefined) {
        continue;
      }
      if (
        context.workspaceFolder &&
        context.workspaceFolder !== ctx.workspaceFolder
      ) {
        continue;
      }
      if (context.file && context.file !== ctx.file) {
        continue;
      }
      if (context.contract && context.contract !== ctx.contract) {
        continue;
      }
      if (context.method && context.method !== ctx.method) {
        continue;
      }
      results.set(item, ctx as Required<TestContext>);
    }
    return results;
  }
}

function createFoundryProfile(
  testController: vscode.TestController,
  testTree: IndexedTestTree,
  profileKind: vscode.TestRunProfileKind,
  coverageCache?: WeakMap<vscode.FileCoverage, vscode.StatementCoverage[]>
) {
  return testController.createRunProfile(
    profileKind === vscode.TestRunProfileKind.Run
      ? 'Run Foundry Tests'
      : 'Run Foundry Tests with Coverage',
    profileKind,
    async (request, token) => {
      const run = testController.createTestRun(request);
      for (const item of request.include ?? []) {
        if (token.isCancellationRequested) {
          break;
        }
        const testContext = testTree.items.get(item) ?? {};
        const {workspaceFolder, file, contract, method} = testContext;
        if (!workspaceFolder) {
          run.errored(
            item,
            new vscode.TestMessage(
              'Cannot determine workspace folder for test item.'
            )
          );
          continue;
        }

        const leafs = testTree.matchLeafs({
          workspaceFolder,
          file,
          contract,
          method,
        });

        for (const [item, context] of leafs) {
          if (!item.tags.some(t => t.id === 'run')) {
            continue;
          }
          run.started(item);
        }

        try {
          const testOptions: ForgeTestOptions =
            testContextToTestOptions(testContext);
          let report: ForgeTestSuiteReport;
          let lcovRecords: LcovRecord[] = [];
          if (profileKind === vscode.TestRunProfileKind.Run) {
            report = await forgeTest(workspaceFolder.uri, testOptions);
          } else {
            [report, lcovRecords] = await forgeCoverage(
              workspaceFolder.uri,
              testOptions
            );
          }
          processCoverageReport(
            lcovRecords,
            workspaceFolder,
            run,
            coverageCache
          );
          processTestReport(leafs, report, run);
        } catch (e) {
          const message = new vscode.TestMessage((e as Error).message);
          run.errored(item, message);
        }
        run.end();
      }
    },
    false,
    profileKind === vscode.TestRunProfileKind.Run ? tag('run') : tag('coverage')
  );
}

function processTestReport(
  leafs: Map<vscode.TestItem, Required<TestContext>>,
  report: ForgeTestSuiteReport,
  run: vscode.TestRun
) {
  for (const [item, context] of leafs) {
    if (!item.tags.some(t => t.id === 'run')) {
      continue;
    }
    const {workspaceFolder, file, contract, method} = context;
    const resultKey = `${vscode.workspace.asRelativePath(file, false)}:${contract.name}`;
    const reportEntry = report[resultKey];

    const testResult = Object.entries(reportEntry?.test_results).find(
      ([id, tr]) => id.startsWith(method.name + '(')
    );
    if (!testResult) {
      const message = new vscode.TestMessage(
        `Test not found in report: ${method.name}`
      );
      run.errored(item, message);
      continue;
    }
    const [_, tr] = testResult;
    if (tr.status === 'Failure') {
      const message = new vscode.TestMessage(
        `Test failed: ${tr.reason ?? 'Unknown error'}`
      );
      run.failed(item, message);
    } else if (tr.status === 'Success') {
      run.passed(item);
    } else {
      const message = new vscode.TestMessage(`Test status: ${tr.status}`);
      run.errored(item, message);
    }
  }
}

function processCoverageReport(
  lcovRecords: LcovRecord[],
  workspaceFolder: vscode.WorkspaceFolder,
  run: vscode.TestRun,
  coverageCache:
    | WeakMap<vscode.FileCoverage, vscode.StatementCoverage[]>
    | undefined
) {
  for (const lcovRecord of lcovRecords) {
    const lineCoverages = lcovRecord.lines.details.map(detail => {
      return new vscode.StatementCoverage(
        detail.hit,
        new vscode.Position(detail.line - 1, 0)
      );
    });
    if (!lcovRecord.file) {
      continue;
    }
    const fileUri = vscode.Uri.joinPath(
      workspaceFolder.uri,
      ...lcovRecord.file.split('/')
    );
    const fileCoverage = vscode.FileCoverage.fromDetails(
      fileUri,
      lineCoverages
    );
    run.addCoverage(fileCoverage);
    if (coverageCache) {
      coverageCache.set(fileCoverage, lineCoverages);
    }
  }
}

async function createTestTree(
  testController: vscode.TestController
): Promise<IndexedTestTree> {
  const testTree = new IndexedTestTree();
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  for (const workspaceFolder of workspaceFolders) {
    const workspaceItem = await createWorkspaceTestItem(
      testController,
      workspaceFolder
    );
    testTree.items.set(workspaceItem, {workspaceFolder});
    testController.items.add(workspaceItem);
    const files = await testFiles(workspaceFolder.uri);
    for (const file of files) {
      const fileItem = await createFileTestItem(testController, file);
      testTree.items.set(fileItem, {workspaceFolder, file});
      workspaceItem.children.add(fileItem);
      const content = await vscode.workspace.fs.readFile(file);
      const text = new TextDecoder().decode(content);
      const ast = parser.parse(text, {loc: true});
      parser.visit(ast, {
        ContractDefinition: async contract => {
          const contractItem = await createContractTestItem(
            testController,
            file,
            contract
          );
          testTree.items.set(contractItem, {workspaceFolder, file, contract});
          fileItem.children.add(contractItem);
          parser.visit(contract, {
            FunctionDefinition: async func => {
              const methodItem = await createMethodTestItem(
                testController,
                file,
                func
              );
              if (methodItem) {
                testTree.items.set(methodItem, {
                  workspaceFolder,
                  file,
                  contract,
                  method: func,
                });
                contractItem.children.add(methodItem);
              }
            },
          });
        },
      });
    }
  }
  return testTree;
}

async function createWorkspaceTestItem(
  testController: vscode.TestController,
  workspaceFolder: vscode.WorkspaceFolder
): Promise<vscode.TestItem> {
  const workspaceItem = testController.createTestItem(
    workspaceFolder.uri.toString(),
    workspaceFolder.name,
    workspaceFolder.uri
  );
  workspaceItem.tags = [tag('run'), tag('coverage')];
  return workspaceItem;
}

async function createFileTestItem(
  testController: vscode.TestController,
  file: vscode.Uri
): Promise<vscode.TestItem> {
  const fileItem = testController.createTestItem(
    file.toString(),
    vscode.workspace.asRelativePath(file),
    file
  );
  fileItem.tags = [tag('run'), tag('coverage')];
  return fileItem;
}

async function createContractTestItem(
  testController: vscode.TestController,
  file: vscode.Uri,
  contract: ContractDefinition
): Promise<vscode.TestItem> {
  const uri = file.with({fragment: `L${contract.loc?.start.line}`});
  const contractName = contract.name;
  const contractItem = testController.createTestItem(
    uri?.toString() ?? '',
    contractName,
    file
  );
  contractItem.tags = [tag('run'), tag('coverage')];
  if (contract.loc) {
    contractItem.range = new vscode.Range(
      new vscode.Position(
        contract.loc.start.line - 1,
        contract.loc.start.column
      ),
      new vscode.Position(
        contract.loc.start.line - 1,
        contract.loc.start.column
      )
    );
  }
  return contractItem;
}

async function createMethodTestItem(
  testController: vscode.TestController,
  file: vscode.Uri,
  method: FunctionDefinition
): Promise<vscode.TestItem | undefined> {
  if (method.isConstructor || method.isFallback || method.isReceiveEther) {
    return undefined;
  }
  if (method.visibility !== 'public' && method.visibility !== 'external') {
    return undefined;
  }
  if (!method.name) {
    return undefined;
  }
  const methodItem = testController.createTestItem(
    file.with({fragment: `L${method.loc?.start.line}`}).toString() ?? '',
    method.name,
    file
  );
  if (method.name.startsWith('test')) {
    methodItem.tags = [tag('run'), tag('coverage'), tag('debug')];
  }
  if (method.name === 'setUp') {
    methodItem.tags = [tag('debug')];
  }
  if (method.loc) {
    methodItem.range = new vscode.Range(
      new vscode.Position(method.loc.start.line - 1, method.loc.start.column),
      new vscode.Position(method.loc.start.line - 1, method.loc.start.column)
    );
  }
  return methodItem;
}

function tag(name: string): vscode.TestTag {
  return new vscode.TestTag(name);
}
