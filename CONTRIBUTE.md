# Contributing to Simbolik VSCode Extension

Welcome! This guide will help you set up your development environment and understand the contribution process for the Simbolik Solidity Debugger extension.

## 🚀 Quick Start

### Prerequisites

- **Node.js** (v18 or higher)
- **npm**
- **Visual Studio Code** (latest version)
- **Git**
- **Foundry/Forge** (for testing Solidity compilation)
- **kontrol-node** (the default execution engine; install with `kup install kontrol-node`)

### Development Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/runtimeverification/simbolik-vscode.git
   cd simbolik-vscode
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Build the extension:**
   ```bash
   npm run build
   ```

4. **Open in VS Code:**
   ```bash
   code .
   ```

## 🏗️ Development Workflow

### Building

- `npm run build`: bundles the extension (`build/extension.js`, CommonJS) and
  the debug server (`build/server.mjs`, ESM) with esbuild.
- `npm run build:dev`: builds the `packages/` workspaces, type-checks the
  extension and bundles the server with source maps.
- `npm run typecheck`: type-checks the packages and the server.

### Running & Debugging

#### Clone Test Code: simbolik-examples
Clone it next to simbolik-vscode:
`git clone git@github.com:runtimeverification/simbolik-examples.git`
[launch.json](.vscode/launch.json) references `$workspace/../simbolik-examples`.

#### Option 1: Launch Configurations (Recommended)

Use the predefined VS Code launch configurations:

1. **"Simbolik: Client"** - Opens extension development host with `simbolik-examples` workspace
2. **"Simbolik: Client (Tests)"** - Opens with test data for debugging

Press `F5` or use the Debug panel to start.

### Project Structure

```
simbolik-vscode/
├── src/
│   ├── extension.ts          # Extension entry point
│   ├── DebugAdapter.ts       # Debug adapter factory (inline / tcp)
│   ├── serverBridge.ts       # Loads the ESM debug server from the extension
│   ├── server.ts             # Debug server entry point (build/server.mjs)
│   ├── resolver/             # Turns launch/attach args into a debug session
│   ├── nodeManager.ts        # Starts an execution node per debug session
│   ├── nodeSetup.ts          # Locates kontrol-node / anvil, explains problems
│   ├── CodelensProvider.ts   # Provides "Debug" buttons
│   ├── TestAdapter.ts        # Test explorer integration (run, coverage, debug)
│   ├── startDebugging.ts     # Builds the launch configuration
│   ├── foundry.ts            # Foundry/Forge integration
│   └── utils.ts              # Utility functions
├── packages/                 # The debug server (see packages/README.md)
├── build/                    # Bundled extension and debug server
├── .vscode/
│   └── launch.json           # Debug configurations
├── .github/workflows/
│   ├── release.yml           # Automated release pipeline
│   └── test.yml              # CI tests
└── package.json              # Extension manifest
```

### Code Quality

#### Linting & Formatting

We use **Google TypeScript Style (gts)**:

```bash
# Check for lint errors
npm run lint

# Auto-fix lint errors
npm run fix

# Clean build artifacts
npm run clean
```

#### Pre-commit Checks

Before committing, ensure:

```bash
npm run typecheck  # Type-checks packages and the server
npm run lint       # Lints
npm test           # Runs the test suite
```

### Testing

```bash
# Run all tests (Vitest)
npm test

# Run the integration test against a live kontrol-node
npm run test:live
```

## 🔧 Extension Development

### Key Components

#### 1. CodelensProvider (`CodelensProvider.ts`)
- Analyzes Solidity files
- Provides "Debug" buttons above debuggable functions
- Identifies contracts and public functions

#### 2. Debug Adapter (`DebugAdapter.ts`)
- Populates the launch configuration (build, method signature, arguments)
- Starts an execution node for the session (`nodeManager.ts`)
- Hosts the debug server in-process (`inline`, default) or as a child
  process over TCP (`tcp`), selected by `simbolik.adapterMode`

#### 3. Foundry Integration (`foundry.ts`)
- Handles `forge build` compilation
- Loads build artifacts and metadata
- Configures compilation environment

#### 4. Debug Server (`server.ts`, `resolver/`, `packages/`)
- `launch`: deploys the contract on the execution node, runs `setUp()`,
  calls the method and fetches its trace
- `attach`: replays an already-mined transaction, fetching sources from Sourcify
- Answers DAP requests over the recorded trace

### Configuration

Extension settings are defined in `package.json` under `contributes.configuration`:

- `simbolik.forge-path` - Path to forge executable
- `simbolik.autobuild` - Build automation settings
- `simbolik.rpc-node-type` - Execution node: `kontrol-node` (default) or `anvil`
- `simbolik.auto-start-node` - Start a fresh node per debug session
- `simbolik.kontrol-node-path` / `simbolik.kontrol-node-dir` - kontrol-node
  executable, or a development checkout
- `simbolik.anvil-path` - Path to anvil executable
- `simbolik.json-rpc-url` - Ethereum JSON-RPC endpoint (when not auto-starting)
- `simbolik.sourcify-url` - Sourcify server for source verification
- `simbolik.adapterMode` - Host the debug server `inline` or over `tcp`

### Adding New Features

1. **Update Extension Manifest** (`package.json`)
   - Add new commands, configurations, or menu items

2. **Implement Functionality**
   - Add logic to appropriate source files
   - Keep `src/server.ts` and `src/resolver/` free of `vscode` imports: they
     also run as a standalone Node process

## 📦 Release Process

### Version Management

Use the provided npm scripts:

```bash
# Patch release (10.0.2 → 10.0.3)
npm run version:patch

# Minor release (10.0.2 → 10.1.0)  
npm run version:minor

# Major release (10.0.2 → 11.0.0)
npm run version:major
```

### Release Checklist

1. **Update Version:**
   On your feature branch, or as an admin on master:
   ```bash
   npm run version:patch  # or minor/major
   ```

2. **Update Changelog:**
   - Add entry to `CHANGELOG.md`
   - Follow existing format: `## [x.y.z] - YYYY-MM-DD`

3. **Test & Commit:**
   ```bash
   npm run build
   npm test
   git add package.json CHANGELOG.md
   git commit -m "Version bump to x.y.z"
   ```

4. **Push Changes to Master:**
   ```bash
   git push origin master
   ```

5. **Create PR & Merge**

6. **Trigger Release:**
   - Go to GitHub Actions
   - Run "Publish VS Code Extension" workflow manually
   - This will create release, publish to marketplace, and attach `.vsix`

## 🛠️ Development Tips

### Debugging Extension Issues

1. **Check Extension Host Console:**
   - Help → Toggle Developer Tools (in Extension Host)

2. **View Extension Logs:**
   - Open Output panel → "Simbolik Solidity Debugger"

3. **Inspect the Execution Node and Debug Server:**
   - Open Output panel → "Simbolik Node" for the node's log
   - The debug console shows the JSON-RPC calls made while launching

### Working with Foundry Projects

For testing, you'll need a Foundry project structure:

```
test-project/
├── foundry.toml
├── src/
│   └── Contract.sol
└── test/
    └── Contract.t.sol
```

The extension expects:
- `foundry.toml` configuration file
- Contracts in `src/` directory
- Build artifacts in `out/` directory (created by `forge build`)

### Common Issues

1. **Build Errors:** Ensure all dependencies are installed
2. **Extension Not Loading:** Check console for TypeScript errors
3. **Execution Node Not Found:** Install kontrol-node (`kup install kontrol-node`)
   or set `simbolik.kontrol-node-path`
4. **Foundry Integration:** Ensure `forge` is in PATH

## 🤝 Contributing Guidelines

### Pull Request Process

1. **Fork & Branch:**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Develop & Test:**
   - Write code following existing patterns
   - Add tests if applicable
   - Ensure linting passes

3. **Commit & Push:**
   - Use descriptive commit messages
   - Reference issues if applicable

4. **Create Pull Request:**
   - Provide clear description
   - Include testing instructions
   - Link related issues

### Code Style

- Follow **Google TypeScript Style** (enforced by gts)
- Use meaningful variable/function names
- Add JSDoc comments for public APIs
- Keep functions focused and testable

### Issue Reporting

When reporting bugs, please include:
- VS Code version
- Extension version
- Operating system
- Minimal reproduction steps
- Error messages/logs

## 📚 Additional Resources

- [VS Code Extension API](https://code.visualstudio.com/api)
- [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)
- [Foundry Documentation](https://book.getfoundry.sh/)
- [Simbolik Documentation](https://docs.runtimeverification.com/simbolik)

## 💬 Getting Help

- **Discord:** https://discord.gg/jnvEeDxW
- **Telegram:** https://t.me/rv_simbolik
- **Issues:** GitHub Issues for bug reports and feature requests

---

Thank you for contributing to Simbolik! 🎉 