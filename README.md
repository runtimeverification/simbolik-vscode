# Solidity Debugger for Visual Studio Code

## Overview

Simbolik is a powerful extension that allows developers to debug their Solidity smart contracts directly within Visual Studio Code.
With this extension, you can easily set breakpoints, inspect variables, step through code, and debug your Solidity contracts with ease.

## Features

- **Step-by-step debugging**: Debug your Solidity smart contracts line by line.
- **Breakpoints**: Set breakpoints in your Solidity code to pause execution and inspect the state.
- **Variable inspection**: View the current values of variables while debugging.
- **Bytecode debugging**: Debug the compiled bytecode of your Solidity contracts.

## Requirements

To use the Solidity Debugger for Visual Studio Code, you need:

- [Foundry](https://book.getfoundry.sh/) and a Foundry project.
- [Simbolik Server](https://simbolik.runtimeverification.com/).

```
curl -L https://foundry.paradigm.xyz | bash
foundryup
pip3 install simbolik
```

## Usage

1. Open your Solidity project in Visual Studio Code.
2. Set breakpoints in your Solidity code by clicking on the gutter area next to the line numbers.
3. Click the "Debug" button above any parameterless public/external function in your Solidity contract.
5. Use the debug toolbar to step through your code, inspect variables, and control the debugging process.

For more detailed instructions and troubleshooting tips, please refer to the [documentation](https://docs.runtimeverification.com/simbolik).

## Contribution

Contributions are welcome! If you find any issues or have suggestions for improvements, please feel free to open an issue or submit a pull request on [GitHub](https://github.com/runtimeverification/simbolik-vscode).
