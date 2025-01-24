#!/usr/bin/env node

// This script is used to intercept calls from Foundry to the Solidity compiler.
// Intercepting the calls allows us to capture the JSON standard input and write it to a file for later use.
// Run forge like this: `forge build --use /path/to/solc.js` to capture the input.
// The script does not acutally compile the contracts, it just captures the input and exits with code 0.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const outDir = path.join(process.cwd(), '.simbolik');
const stdinFilePath = path.join(outDir, 'stdin.json');
const argsFilePath = path.join(outDir, 'args.json');
const metadataFilePath = path.join(outDir, 'metadata.json');

// Create the output directory if it does not exist
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// Get the arguments
const args = process.argv.slice(2);

// Foundry calls `solc --version` to check the version of the compiler
// before invoking the compiler to verifiy that the compiler version
// matches. We intercept this call and return the version of the compiler
// that forge expects to use.
if (args.includes('--version') !== -1) {
    let version = '0.8.26';
    try {
      const resolvedVersionOut = execSync(`forge compiler resolve --json`, { cwd: process.cwd(), encoding: 'utf-8', env: process.env });
      version = JSON.parse(resolvedVersionOut)["Solidity"][0]["version"];
    } catch (e) {
    }

    console.log(`Version: ${version}`);
    // Write the version to .simbolik/metadata.json
    fs.writeFileSync(metadataFilePath, JSON.stringify({ compiler: { version } }));
}

if (args.includes('--standard-json')) {

  // Capture args and write to args file
  fs.writeFileSync(argsFilePath, JSON.stringify(args));

  // Capture and write stdin to the stdin file
  const stdin = process.stdin;
  stdin.setEncoding('utf-8');

  // Clear the stdin file
  fs.writeFileSync(stdinFilePath, '');

  stdin.on('data', (data) => {
    fs.appendFileSync(stdinFilePath, data);
  });

}