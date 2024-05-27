# Solidity Debugger for Visual Studio Code

> [!IMPORTANT]
> This extension is currently in beta. If you encounter any issues, please report them on [GitHub](https://github.com/runtimeverification/simbolik-vscode/issues).
> You need to have a free API key from the [Simbolik Website](https://simbolik.runtimeverification.com) to use this extension, see below for more information.

## Overview

Simbolik is a powerful extension that allows developers to debug their Solidity smart contracts directly within Visual Studio Code.
With this extension, you can easily set breakpoints, inspect variables, step through code, and debug your Solidity contracts with ease.

## Features

- **Step-by-step debugging**: Debug your Solidity smart contracts line by line.
- **Inspect EVM state**: View the current state of the EVM while debugging.
- **Breakpoints**: Set breakpoints in your Solidity code to pause execution and inspect the state.
- **Bytecode debugging**: Debug the compiled bytecode of your Solidity contracts.

## Coming Soon

- **Variable inspection**: View the current values of variables while debugging.
- **Foundry Cheatcodes**: Use Foundry's cheatcodes to quickly find bugs in your Solidity code.
- **Symbolic Execution**: Enter an advanced symbolic execution mode to explore all possible paths through your Solidity code. You can get a sneak-peek of this feature at [try.simbolik.runtimeverification.com](try.simbolik.runtimeverification.com).

## Requirements

To use the Solidity Debugger for Visual Studio Code, you need Foundry installed on your machine.
Furthermore, you need a free API key from the Simbolik Website.

### Setup Foundry

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

### Get a free API key

1. Go to the [Simbolik Website](https://simbolik.runtimeverification.com) and login with GitHub, Metamask or Google.
2. Copy the API key from the dashboard.
3. Open the settings in Visual Studio Code and search for "Simbolik API Key".
4. Paste the API key into the input field.

## Usage

1. Open your Foundry project in Visual Studio Code. If you don't have a project at hand, you can clone our [example project](https://github.com/runtimeverification/simbolik-examples).
2. Set breakpoints in your Solidity code by clicking on the gutter area next to the line numbers.
3. Click the "Debug" button above any parameterless public/external function in your Solidity contract.
5. Use the debug toolbar to step through your code, inspect variables, and control the debugging process.

For more detailed instructions and troubleshooting tips, please refer to the [documentation](https://docs.runtimeverification.com/simbolik).

## Contribution

Contributions are welcome! If you find any issues or have suggestions for improvements, please feel free to open an issue or submit a pull request on [GitHub](https://github.com/runtimeverification/simbolik-vscode).
