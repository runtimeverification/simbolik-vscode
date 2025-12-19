import * as vscode from 'vscode';

/**
 * Create a debugging closure for a given function.
 * Closures are needed when a function requires additional inputs.
 * For example, a function with parameters cannot be directly debugged.
 * The closure provides a way to wrap the function call with the necessary inputs.
 * Similarly, if the contract requires constructor arguments, a closure can be used
 * to instantiate the contract with the required arguments before calling the function.
 * Last but not least, if the function is not public or external, a closure is needed
 * to expose the function for debugging.
 * 
 * When a user attempts to debug a function that requires a closure, they will be prompted
 * to open an existing closure file or create a new one.
 * 
 * Closures are always stored in the defined `test` directory.
 * Their naming convention is as follows:
 * - For a function `myFunction` in contract `MyContract`, the first closure file will be named
 *   `01_DebugMyContract_myFunction.sol`.
 * - Subsequent closures for the same function will be named `02_DebugMyContract_myFunction.sol`, etc.
 * 
 */
export function createDebuggingClosure(file: vscode.Uri, contractName: string, functionName: string): void {

}


function isTestFile(file: vscode.Uri): boolean {

}

function createInlineSnippet(functionName: string) : string {
    const snippet = `
    function debug_${functionName}() public {
        ${functionName}($1);
    }
    `;
    return snippet;
}

function createStandaloneSnippet(sourceFile: string, contractName: string, functionName: string) : string {
    const snippet = `// SPDX-License-Identifier: UNLICENSED
    pragma solidity ^0.8.0;
    
    import "../${vscode.workspace.asRelativePath(sourceFile)}";
    
    contract Debug${contractName}_${functionName} is ${contractName} {
        constructor() {
            super($1);
        }

        function debug_${functionName}() public {
            ${functionName}($2);
        }
    }
    `;
    return snippet;
}