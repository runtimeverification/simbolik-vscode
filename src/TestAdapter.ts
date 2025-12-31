import * as vscode from 'vscode';
import { forgeTest, forgeListTests, ForgeTestSuite, ForgeTestSuiteReport, forgeTestSingle, forgeCoverageSingle } from './foundry';


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


async function discoverTests(testController: vscode.TestController) : Promise<void> {
    testController.items.replace([]);
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    for (const workspaceFolder of workspaceFolders) {
        const workspaceTestItem = testController.createTestItem(
            workspaceFolder.uri.toString(),
            workspaceFolder.name,
            workspaceFolder.uri
        );
        testController.items.add(workspaceTestItem);
        const suite = await forgeListTests(workspaceFolder.uri);

        for (const [fileName, contracts] of Object.entries(suite)) {
            const fileTestItem = testController.createTestItem(
                `${workspaceFolder.uri.toString()}/${fileName}`,
                fileName,
                vscode.Uri.joinPath(workspaceFolder.uri, fileName)
            );
            workspaceTestItem.children.add(fileTestItem);

            for (const [contractName, tests] of Object.entries(contracts)) {
                const contractTestItem = testController.createTestItem(
                    `${fileTestItem.id}:${contractName}`,
                    contractName
                );
                fileTestItem.children.add(contractTestItem);
                for (const testName of tests) {
                    const testItem = testController.createTestItem(
                        `${contractTestItem.id}.${testName}`,
                        testName
                    );
                    contractTestItem.children.add(testItem);
                }
            }
        }
    }
}
