# Change Log

All notable changes to the "Simbolik VSCode" extension will be documented in this file.

## [11.0.1] - 2025-07-16
- This version enables experimental cheatcode support for debugging Foundry tests

## [11.0.0] - 2025-07-09
- This version replaces the custom in-memory file system with VSCode's native tmp file system provider.
- We now allow downloading and debugging tarballs of Solidity projects.

## [10.0.4] - 2025-07-08
- Modifying the websocket target from www.simbolik.dev > code.simbolik.dev

## [10.0.3] - 2025-07-01
- Updated contributor docs

## [10.0.2] - 2025-07-01
- Modifying the websocket target from beta.simbolik.runtimeverification.com > simbolik.dev

## [10.0.1] - 2025-05-07

- This update drastically improves the start-up performance of the debugger for large projects.
  This is archived by reducing the compilation time and the size of the compilation units.

## [10.0.0] - 2025-04-18

- This introduces an experimental new URL pattern to the in-browser version of Simbolik that allows users \
  to debug transactions against the configured JSON RPC node and Sourcify server.
- Fixes a bug introduced in v9.0.0 that made compilation artifacts mandatory for debugging transactions.

## [9.0.0] - 2025-04-17

- Added support for projects that require multiple compilation passes with different solc versions.
- Experimental support for incremental compilation.
- Improved memory footprint for large projects.
- Added option to abort a debugging session early.
- Added progress indicator when sending large compitation units.

## [8.0.1] - 2025-03-28

- This realease ensures that the web extension is laoded with a higher priotity to ensure the virtual simbolik-file system is ready when a debugging session starts.

## [8.0.0] - 2025-03-27

- This is maintenance release that prepare the extension for online transaction debugging
  against arbitrary Ethereum networks and for simulating transactions.

## [7.0.0] - 2025-03-06

- Removed support for the `stop-at-first-opcode` option in the extension settings. \
  With time-travel debugging there is a simpler way to achieve the same effect.

## [6.0.2] - 2025-03-03

- Automatically prompts users without API keys to authenticate via GitHub

## [6.0.1] - 2025-02-20

- Fixed several spelling and grammar issues in the README file.

## [6.0.0] - 2025-02-20

- Users can now authenticate via GitHub in addition to Simbolik API keys

## [5.0.0] - 2025-01-13

- Simbolik only recompiles the contracts if the source code has changed

## [4.1.0] - 2024-12-19

- The web version now offers experimental support for debugging transactions from BuildBear sandboxes.

## [4.0.1] - 2024-11-11

- Show progress updates while starting a debugging session
- Hide build task output when the project compiles successfully

## [4.0.0] - 2024-11-09

- Fixed the web extension.

## [3.1.1] - 2024-30-10

- Communication with the Simbolik API is now done over HTTPS and WSS

## [3.1.0] - 2024-16-10

- Added `chainId` option to attach-configurations

## [3.0.0] - 2024-11-10

- Compatibility with the latest version of the Simbolik API
- Compatibility with the latest version of Foundry
- Improved path mapping between local and remote file systems

## [2.0.3] - 2024-05-28

- Fixed a bug in the TOML parser

## [2.0.2] - 2024-05-27

- Added information about the Simbolik API.

## [2.0.1] - 2024-05-27

- Updated README.md with more detailed instructions and troubleshooting tips

## [2.0.0] - 2024-05-27

- Public Beta release of the extension