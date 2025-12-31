import * as vscode from 'vscode';
import { forgeTestSingle, forgeCoverageSingle, testFiles } from './foundry';

import * as parser from '@solidity-parser/parser';


export function createTestController() : vscode.TestController {
    const testController = vscode.tests.createTestController(
        'simbolik-test-controller',
        'Foundry Tests'
    );

    const foundryProfile = testController.createRunProfile(
        'Run Foundry Tests',
        vscode.TestRunProfileKind.Run,
        async (request, token) => {
            const run = testController.createTestRun(request);
            for (const item of request.include ?? []) {
                if (token.isCancellationRequested) {
                    break;
                } 
                if (!item.parent?.parent?.parent) {
                    // Only run leaf tests
                    // We know it's a leaf test if it has a grandgrandparent
                    // because we maintain the following hierarchy:
                    // Workspace -> File -> Contract -> Test
                    continue;
                }
                run.started(item);
                const testMethod = item.label;
                const contract = item.parent.label;
                const fileName = item.parent.parent.label;
                try {
                    const report = await forgeTestSingle(
                        fileName,
                        contract,
                        testMethod
                    );
                    const testResults = Object.values(report[`${fileName}:${contract}`]?.test_results) ?? [];
                    const testResult = testResults[0];
                    if (testResult.status === 'Success') {
                        run.passed(item);
                    } else if (testResult.status === 'Failure') {
                        const message = new vscode.TestMessage(
                            `Test failed: ${testResult.reason ?? 'Unknown error'}`
                        );
                        run.failed(item, message);
                    } else {
                        const message = new vscode.TestMessage(
                            `Test status: ${testResult.status}`
                        );
                        run.errored(item, message);
                    }
                } catch (e) {
                    const message = new vscode.TestMessage(
                        (e as Error).message
                    );
                    run.errored(item, message);
                }
                run.end();
            }
        }
    );

    const debugProfile = testController.createRunProfile(
        'Debug Foundry Tests',
        vscode.TestRunProfileKind.Debug,
        async (request, token) => {
            vscode.window.showInformationMessage('Debugging Foundry tests is not yet implemented.');
        }
    );

    const coverageCache: WeakMap<vscode.FileCoverage, vscode.StatementCoverage[]> = new WeakMap();
    const coverageProfile = testController.createRunProfile(
        'Run Foundry Tests with Coverage',
        vscode.TestRunProfileKind.Coverage,
        async (request, token) => {
            const run = testController.createTestRun(request);
            for (const item of request.include ?? []) {
                if (token.isCancellationRequested) {
                    break;
                } 
                if (!item.parent?.parent?.parent) {
                    // Only run leaf tests
                    // We know it's a leaf test if it has a grandgrandparent
                    // because we maintain the following hierarchy:
                    // Workspace -> File -> Contract -> Test
                    continue;
                }
                run.started(item);
                const testMethod = item.label;
                const contract = item.parent.label;
                const fileName = item.parent.parent.label;
                const workspaceFolder = item.parent.parent.parent.uri;
                try {
                    const [report, lcovRecords] = await forgeCoverageSingle(
                        fileName,
                        contract,
                        testMethod
                    );
                    // Process test result (failed/passed)
                    const testResults = Object.values(report[`${fileName}:${contract}`]?.test_results) ?? [];
                    const testResult = testResults[0];
                    if (testResult.status === 'Success') {
                        run.passed(item);
                    } else if (testResult.status === 'Failure') {
                        const message = new vscode.TestMessage(
                            `Test failed: ${testResult.reason ?? 'Unknown error'}`
                        );
                        run.failed(item, message);
                    } else {
                        const message = new vscode.TestMessage(
                            `Test status: ${testResult.status}`
                        );
                        run.errored(item, message);
                    }
                    // Process coverage information
                    if (!workspaceFolder) {
                        continue;
                    }
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
                        const fileUri = vscode.Uri.joinPath(workspaceFolder, ...lcovRecord.file.split('/'));
                        const fileCoverage = vscode.FileCoverage.fromDetails(
                            fileUri,
                            lineCoverages
                        );
                        run.addCoverage(fileCoverage);
                        coverageCache.set(fileCoverage, lineCoverages);
                    }
                } catch (e) {
                    const message = new vscode.TestMessage(
                        (e as Error).message
                    );
                    run.errored(item, message);
                }
                run.end();
            }
        }
    );

    coverageProfile.loadDetailedCoverage = (
        testRun: vscode.TestRun,
        fileCoverage: vscode.FileCoverage,
        token: vscode.CancellationToken
    ): Thenable<vscode.FileCoverageDetail[]> => {
        const cached = coverageCache.get(fileCoverage);
        return Promise.resolve(cached ?? []);
    }

    testController.refreshHandler = () => {
        discoverTests(testController);
    };

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
        discoverTests(testController);
    });

    // Initial discovery
    discoverTests(testController);

    return testController;
}


async function discoverTests(
    testController: vscode.TestController,
) : Promise<void> {
    testController.items.replace([]);
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    for (const workspaceFolder of workspaceFolders) {
        const workspaceTestItem = testController.createTestItem(
            workspaceFolder.uri.toString(),
            workspaceFolder.name,
            workspaceFolder.uri
        );
        testController.items.add(workspaceTestItem);
        const files = await testFiles(workspaceFolder.uri);
        for (const file of files) {
            const fileItem = testController.createTestItem(
                file.toString(),
                vscode.workspace.asRelativePath(file),
                file
            );
            workspaceTestItem.children.add(fileItem);
            const content = await vscode.workspace.fs.readFile(file);
            const text = new TextDecoder().decode(content);
            const ast = parser.parse(text, {loc: true});
            parser.visit(ast, {
                ContractDefinition: contract => {
                    const uri = file.with({fragment: `L${contract.loc?.start.line}`})
                    const contractTestItem = testController.createTestItem(
                        uri.toString(),
                        contract.name,
                        uri
                    );
                    fileItem.children.add(contractTestItem);
                    parser.visit(contract, {
                        FunctionDefinition: func => {
                            if (func.isConstructor || func.isFallback || func.isReceiveEther) {
                                return;
                            }
                            if (func.visibility !== 'public' && func.visibility !== 'external') {
                                return;
                            }
                            if (!func.name || !func.name.startsWith('test')) {
                                return;
                            } 
                            const testItem = testController.createTestItem(
                                file.with({fragment: `L${func.loc?.start.line}`}).toString(),
                                func.name,
                                file
                            );
                            if (func.loc) {
                                testItem.range = new vscode.Range(
                                    new vscode.Position(func.loc.start.line - 1, func.loc.start.column),
                                    new vscode.Position(func.loc.start.line - 1, func.loc.start.column)
                                );
                            }
                            contractTestItem.children.add(testItem);
                        }
                    });
                }
            });
        }
    }
}