# Contributing to Simbolik VSCode Extension

Welcome! This guide will help you set up your development environment and understand the contribution process for the Simbolik Solidity Debugger extension.

## 🚀 Quick Start

### Prerequisites

- **Node.js** (v18 or higher)
- **npm**
- **Visual Studio Code** (latest version)
- **Git**
- **Foundry/Forge** (for testing Solidity compilation)

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

The extension has two build targets:

- **Desktop Extension:** `npm run build`

### Running & Debugging

#### Clone Test Code: simbolike-examples

Clone to the same directory as simbolik-vscode
`git clone git@github.com:runtimeverification/simbolik-examples.git`
[launch.json](.vscode/launch.json) References `$workspace/../simbolik-examples`

#### Option 1: Launch Configurations (Recommended)

Use the predefined VS Code launch configurations:

1. **"Simbolik: Client"** - Opens extension development host with `simbolik-examples` workspace
2. **"Simbolik: Client (Tests)"** - Opens with test data for debugging

Press `F5` or use the Debug panel to start.

### Project Structure

```
simbolik-vscode/
├── src/
│   ├── extension.ts          # Main extension entry point
│   ├── extension.web.ts      # Web extension entry point
│   ├── debugAdapter.ts       # Desktop debug adapter
│   ├── debugAdapter.web.ts   # Web debug adapter
│   ├── CodelensProvider.ts   # Provides "Debug" buttons
│   ├── startDebugging.ts     # Debug session logic
│   ├── foundry.ts           # Foundry/Forge integration
│   ├── utils.ts             # Utility functions
│   └── workspaceWatcher.ts   # File change detection
├── build/                   # Compiled extension (desktop)
├── build-web/              # Compiled web extension
├── .vscode/
│   └── launch.json         # Debug configurations
├── .github/workflows/
│   └── release.yml         # Automated release pipeline
└── package.json           # Extension manifest
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
npm run pretest  # Compiles + lints
npm test         # Runs test suite
```

### Testing

```bash
# Run all tests
npm test

# Compile TypeScript
npm run compile
npm run compile-web
```

## 🔧 Extension Development

### Key Components

#### 1. CodelensProvider (`CodelensProvider.ts`)

- Analyzes Solidity files
- Provides "Debug" buttons above debuggable functions
- Identifies contracts and public functions

#### 2. Debug Adapters

- **Desktop:** `debugAdapter.ts` - Full Node.js environment
- **Web:** `debugAdapter.web.ts` - Browser-compatible version

#### 3. Foundry Integration (`foundry.ts`)

- Handles `forge build` compilation
- Loads build artifacts and metadata
- Configures compilation environment

#### 4. WebSocket Communication

- Connects to Simbolik server: `wss://www.simbolik.dev`
- Handles authentication (GitHub OAuth or API key)
- Sends debug requests and receives responses

### Configuration

Extension settings are defined in `package.json` under `contributes.configuration`:

- `simbolik.api-key` - Authentication token
- `simbolik.server` - WebSocket server URL
- `simbolik.forge-path` - Path to forge executable
- `simbolik.autobuild` - Build automation settings
- `simbolik.json-rpc-url` - Ethereum JSON-RPC endpoint
- `simbolik.sourcify-url` - Sourcify server for source verification

### Adding New Features

1. **Update Extension Manifest** (`package.json`)
   - Add new commands, configurations, or menu items

2. **Implement Functionality**
   - Add logic to appropriate source files
   - Follow existing patterns for WebSocket communication

3. **Update Both Versions**
   - Ensure compatibility with both desktop and web extensions
   - Test in both environments

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

   ```

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

3. **Debug WebSocket Communication:**
   - Enable browser dev tools in web extension
   - Check Network tab for WebSocket messages

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
3. **WebSocket Issues:** Verify server URL and authentication
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
