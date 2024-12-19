# Solidity Debugger for Visual Studio Code

> [!IMPORTANT]
> Please follow the instructions in our [Getting Started Guide](https://docs.runtimeverification.com/simbolik/overview/getting-started) to set up the extension correctly.

> [!IMPORTANT]
> The extension connects to the Simbolik API to provide debugging capabilities, and it transfers your compilation artifacts to our servers.
> The data is deleted after the debugging session is finished.

## Overview

Simbolik is a powerful extension that allows developers to debug their Solidity smart contracts directly within Visual Studio Code.
With this extension, you can easily set breakpoints, inspect variables, step through code, and debug your Solidity contracts with ease.

Do you have questions, or need help?

Visit our Documentation: https://docs.runtimeverification.com/simbolik 
Join our Discord: https://discord.gg/jnvEeDxW
Join our TG group: https://t.me/rv_simbolik

## Features

- **Step-by-step debugging**: Debug your Solidity smart contracts line by line.
- **Variable inspection**: View the current values of variables while debugging.
- **Inspect EVM state**: View the current state of the EVM while debugging.
- **Breakpoints**: Set breakpoints in your Solidity code to pause execution and inspect the state.
- **Bytecode debugging**: Debug the compiled bytecode of your Solidity contracts.

## Coming Soon

- **Foundry Cheatcodes**: Use Foundry's cheatcodes to quickly find bugs in your Solidity code.
- **Symbolic Execution**: Enter an advanced symbolic execution mode to explore all possible paths through your Solidity code. You can get a sneak-peek of this feature at [try.simbolik.runtimeverification.com](try.simbolik.runtimeverification.com).

## Getting started

For detailed instructions and troubleshooting tips, please refer to our [Getting Started Guide](https://docs.runtimeverification.com/simbolik/overview/getting-started).
Here is the quick version:

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
