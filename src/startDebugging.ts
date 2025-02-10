import {
  ContractDefinition,
  FunctionDefinition,
  TypeName,
  VariableDeclaration,
} from '@solidity-parser/parser/dist/src/ast-types';
import * as vscode from 'vscode';
import { getConfigValue } from './utils';
import { forgeStdInput, foundryRoot, CompilerInput } from './foundry';
import { WorkspaceWatcher } from './WorkspaceWatcher';

export async function startDebugging(
  contract: ContractDefinition,
  method: FunctionDefinition,
  workspaceWatcher: WorkspaceWatcher
) {
  return await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Simbolik"
  }, async (progress) => {
    const activeTextEditor = vscode.window.activeTextEditor;
    if (!activeTextEditor) {
      throw new Error('No active text editor.');
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(
      activeTextEditor.document.uri
    );
    if (!workspaceFolder) {
      throw new Error('No workspace folder.');
    }

    const parameters = method.parameters.flatMap((param: VariableDeclaration) => {
      if (param.typeName === null) {
        console.error(
          `Missing TypeName for parameter ${param} in method ${method} in contract ${contract}`
        );
        return [];
      }
      const typeName: TypeName = param.typeName;
      if (!('name' in typeName)) {
        console.error(
          `Missing name for TypeName for parameter ${param} in method ${method} in contract ${contract}`
        );
        return [];
      }
      if (typeof typeName.name !== 'string') {
        console.error(
          `Unexpected type for name of TypeName for parameter ${param} in method ${method} in contract ${contract}`
        );
        return [];
      }
      return [typeName.name];
    });

    const file = activeTextEditor.document.uri.toString();
    const contractName = contract['name'];
    const methodSignature = `${method['name']}(${parameters.join(',')})`;
    const stopAtFirstOpcode = getConfigValue('stop-at-first-opcode', true);
    const showSourcemaps = getConfigValue('show-sourcemaps', false);
    const debugConfigName = `${contractName}.${methodSignature}`;
    const jsonRpcUrl = getConfigValue('json-rpc-url', 'http://localhost:8545');
    const sourcifyUrl = getConfigValue('sourcify-url', 'http://localhost:5555');

    let compilerInput : CompilerInput;
    // Auto build if needed
    // Notice, that if autobuild is set to 'on-change' and the project is not built, the project will be built
    // This case is handled after this block
    progress.report({ message: "Compiling" });
    try {
      compilerInput = await forgeStdInput(activeTextEditor.document.uri);
    } catch (e) {
      vscode.window.showErrorMessage('Failed to build project.');
      return;
    }

    const myFoundryRoot = await foundryRoot(activeTextEditor.document.uri);
    const myDebugConfig = debugConfig(
      debugConfigName,
      file,
      contractName,
      methodSignature,
      stopAtFirstOpcode,
      showSourcemaps,
      jsonRpcUrl,
      sourcifyUrl,
      compilerInput.metadata,
      compilerInput.stdin,
      myFoundryRoot
    );
    progress.report({message: "Launching testnet"});
    const session = await vscode.debug.startDebugging(
      workspaceFolder,
      myDebugConfig
    );
  });
}

function completed(tastkExecution: vscode.TaskExecution): Promise<void> {
  return new Promise((resolve, reject) => {
    const disposable = vscode.tasks.onDidEndTaskProcess(e => {
      if ((e.execution as any)._id !== (tastkExecution as any)._id) return;
      if (e.exitCode !== 0) {
        reject();
      } else {
        resolve();
      }
      disposable.dispose();
    });
  });
}

function debugConfig(
  name: string,
  file: string,
  contractName: string,
  methodSignature: string,
  stopAtFirstOpcode: boolean,
  showSourcemaps: boolean,
  jsonRpcUrl: string,
  sourcifyUrl: string,
  metadata: string,
  stdin: string,
  clientMount: vscode.Uri
) {
  return {
    name: name,
    type: 'solidity',
    request: 'launch',
    file: file,
    contractName: contractName,
    methodSignature: methodSignature,
    stopAtFirstOpcode: stopAtFirstOpcode,
    showSourcemaps: showSourcemaps,
    jsonRpcUrl: jsonRpcUrl,
    sourcifyUrl: sourcifyUrl,
    metadata: metadata,
    stdin: stdin,
    clientMount: clientMount,
    node: 'anvil'
  };
}

export async function startAIDebugging(contract: ContractDefinition, method: FunctionDefinition) {
  const activeTextEditor = vscode.window.activeTextEditor;
  if (!activeTextEditor) {
    throw new Error('No active text editor.');
  }
  const content = activeTextEditor.document.getText();
  const craftedPrompt = [
      ...aiContext(),
      vscode.LanguageModelChatMessage.User(
        `Create a debugging smart contract to debug the ${method.name} function in the ${contract.name} contract.
        The debugging contract MUST NOT have a construtor.
        All initialization logic MUST happen in \`setUp\` function.
        The setUp function MUST have the following signature: \`function setUp() external\`.
        If a contract depends on other contracts, you MUST deploy them in the correct order.
        Be intelligent about the contract you inject as dependencies.
        First use an implementation candidate from the given code base.
        If there is none, define and inject a mock contract.
        Never inject hardcoded addresses as contracts dependencies.
        The debugging function MUST NOT have any parameters.
        Be intelligent about setting up the debugging contract properly.
        For example, when a user wants to debug a transfer function, you must ensure that the user has enough tokens to transfer, for example by calling the mint function if available.
        A different example is debugging a swap oepration on a decentralized exchange. You must ensure that the exchange has sufficient liquidity to perform the swap.
        If you don't know how to perform these actions, put a code comment instead.

        You must import any necessary libraries and contracts, and you must not inline any code from the source file.
        Always use import {name} from 'file.sol' syntax for imports. Never use import 'file.sol'.

        Prefer the usage of actor contracts instead of hardcoded addresses and over global addresses such as msg.sender and address(this).
        Of course, you can use msg.sender and address(this) if necessary.

        Only respond with Solidity code. No comments (unlesss code commments), no explanations, no markdown markup.
  
        Here is the source file containing the contract and function to debug:

        ~~~solidity
        ${content}
        `
      ),
  ];
  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
    if (models.length === 0) {
      vscode.window.showErrorMessage('No chat models available');
      return;
    }
    const model = models[0];
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Generating Debug Scenario ✨",
      cancellable: true
    }, async (progress, token) => {
      const response = await model.sendRequest(craftedPrompt, {}, token);
      let responseText = '';
      for await (const fragment of response.text) {
        responseText += fragment;
      }
      // Replace markdown markers with empty strings
      responseText = responseText.replace(/```solidity/g, '').replace(/```/g, '');

      vscode.workspace.openTextDocument({
        content: responseText,
        language: 'solidity',
      })
    });
  } catch (err) {
    // Making the chat request might fail because
    // - model does not exist
    // - user consent not given
    // - quota limits were exceeded
    if (err instanceof vscode.LanguageModelError) {
      console.log(err.message, err.code, err.cause);
    } else {
      // add other error handling logic
      throw err;
    }
  }
}

function aiContext() {
  return [
    vscode.LanguageModelChatMessage.User(
      `Your task is to create the boilerplate code to start debugging smart contracts with Simbolik.

      Simbolik is a debugger designed to make Solidity debugging as easy as possible.
      In this spirit it automates much of the repetitive work, including compiling contracts, creating and deploying to a local testnet, and simulating user transactions.
      Whenever feasible, Simbolik can launch a debugging session with a single click.
      However, there are cases where some manual setup is required, such as when debugging complex systems with multiple interacting contracts or scenarios involving user interactions.
      
      You are responsible for creating the boilerplate code to start debugging.

      The boilerplate code needed for debugging smart contract is similar to the boilerplate code for unit tests, and you may use your knowledge about unit tests to create the debugging code.
      However, debugging contracts cannot use cheat codes, and they typicall don't have any assertions.

      All configuration happens in Solidity, you never have to switch to another language.

      ## Example Scenario

      Assume a user wants to debug the following Solidity code:

      ~~~solidity
      // SPDX-License-Identifier: UNLICENSED
      pragma solidity ^0.8.13;

      contract CPAMM {
          IERC20 public token0;
          IERC20 public token1;

          uint256 public reserve0;
          uint256 public reserve1;

          uint256 public totalSupply;
          mapping(address => uint256) public balanceOf;

          constructor(address _token0, address _token1) {
              token0 = IERC20(_token0);
              token1 = IERC20(_token1);
          }

          function _mint(address _to, uint256 _amount) private {
              balanceOf[_to] += _amount;
              totalSupply += _amount;
          }

          function _burn(address _from, uint256 _amount) private {
              balanceOf[_from] -= _amount;
              totalSupply -= _amount;
          }

          function _update(uint256 _reserve0, uint256 _reserve1) private {
              reserve0 = _reserve0;
              reserve1 = _reserve1;
          }

          function swap(address _tokenIn, uint256 _amountIn)
              external
              returns (uint256 amountOut)
          {
              require(
                  _tokenIn == address(token0) || _tokenIn == address(token1),
                  "invalid token"
              );
              require(_amountIn > 0, "amount in = 0");
              bool isToken0 = _tokenIn == address(token0);
              (IERC20 tokenIn, IERC20 tokenOut, uint256 reserveIn, uint256 reserveOut)
              = isToken0
                  ? (token0, token1, reserve0, reserve1)
                  : (token1, token0, reserve1, reserve0);
              tokenIn.transferFrom(msg.sender, address(this), _amountIn);
              uint256 amountInWithFee = (_amountIn * 997) / 1000;
              amountOut =
                  (reserveOut * amountInWithFee) / (reserveIn + amountInWithFee);
              tokenOut.transfer(msg.sender, amountOut);
              _update(
                  token0.balanceOf(address(this)), token1.balanceOf(address(this))
              );
          }

          function addLiquidity(uint256 _amount0, uint256 _amount1)
              external
              returns (uint256 shares)
          {
              token0.transferFrom(msg.sender, address(this), _amount0);
              token1.transferFrom(msg.sender, address(this), _amount1);
              if (reserve0 > 0 || reserve1 > 0) {
                  require(
                      reserve0 * _amount1 == reserve1 * _amount0, "x / y != dx / dy"
                  );
              }
              if (totalSupply == 0) {
                  shares = _sqrt(_amount0 * _amount1);
              } else {
                  shares = _min(
                      (_amount0 * totalSupply) / reserve0,
                      (_amount1 * totalSupply) / reserve1
                  );
              }
              require(shares > 0, "shares = 0");
              _mint(msg.sender, shares);
              _update(
                  token0.balanceOf(address(this)), token1.balanceOf(address(this))
              );
          }

          function removeLiquidity(uint256 _shares)
              external
              returns (uint256 amount0, uint256 amount1)
          {
              uint256 bal0 = token0.balanceOf(address(this));
              uint256 bal1 = token1.balanceOf(address(this));
              amount0 = (_shares * bal0) / totalSupply;
              amount1 = (_shares * bal1) / totalSupply;
              require(amount0 > 0 && amount1 > 0, "amount0 or amount1 = 0");
              _burn(msg.sender, _shares);
              _update(bal0 - amount0, bal1 - amount1);
              token0.transfer(msg.sender, amount0);
              token1.transfer(msg.sender, amount1);
          }

          function _sqrt(uint256 y) private pure returns (uint256 z) {
              if (y > 3) {
                  z = y;
                  uint256 x = y / 2 + 1;
                  while (x < z) {
                      z = x;
                      x = (y / x + x) / 2;
                  }
              } else if (y != 0) {
                  z = 1;
              }
          }

          function _min(uint256 x, uint256 y) private pure returns (uint256) {
              return x <= y ? x : y;
          }
      }

      interface IERC20 {
          function totalSupply() external view returns (uint256);
          function balanceOf(address account) external view returns (uint256);
          function transfer(address recipient, uint256 amount)
              external
              returns (bool);
          function allowance(address owner, address spender)
              external
              view
              returns (uint256);
          function approve(address spender, uint256 amount) external returns (bool);
          function transferFrom(address sender, address recipient, uint256 amount)
              external
              returns (bool);
      }
      ~~~

      Specifically, we'll simulate what happens when Alice, a liquidity provider, adds liquidity to the market and when Bob, a trader, swaps tokens.
      
      The AMM contract depends on two ERC20 tokens representing tradeable assets.
      
      These contracts must be deployed first. It's your job to figure out the dependecies and deploy them in the correct order.
      
      The deployment happens inside Solidity.
      In Simbolik, deployment scripts are just standard Solidity smart contracts, designed to be self-contained:
      
      ~~~solidity
      contract DebugCPAMM {
          ERC20 public token0;
          ERC20 public token1;
          CPAMM public cpamm;
      
          function setUp() external {
              token0 = new ERC20("token0", "TK0", 0);
              token1 = new ERC20("token1", "TK1", 0);
              cpamm = new CPAMM(address(token0), address(token1));
          }
      }
      ~~~

      ## Simulating User Behavior
      
      To observe how Alice and Bob interact with the market, we could manually set up accounts and send transactions.
      In Simbolik, we use "digital actors"—smart contracts that simulate human users.
      Just like deployment scripts digital actors are plain-old Solidity contracts.

      You are responsible for creating the digital actors and simulating the user interactions.

      Here’s what an actor for a liquidity provider might look like:
      
      ~~~solidity
      contract LiquidityProvider {
          CPAMM cpamm;
      
          constructor(CPAMM _cpamm) {
              cpamm = _cpamm;
          }
      
          function addLiquidity(uint256 amountA, uint256 amountB) external returns (uint256) {
              cpamm.token0().approve(address(cpamm), amountA);
              cpamm.token1().approve(address(cpamm), amountB);
              return cpamm.addLiquidity(amountA, amountB);
          }
      
          function removeLiquidity(uint256 amount) external {
              cpamm.removeLiquidity(amount);
          }
      }
      ~~~
  
      Adding liquidity involves three steps: approving the AMM to spend the tokens and then calling the addLiquidity function.
      
      ## Deploying the Complete System
      
      We deploy the ERC20 tokens, the AMM, and the digital actors in one script and fund the actors to prepare for interactions:
      
      ~~~solidity
      contract DebugCPAMM {
          ERC20 public token0;
          ERC20 public token1;
          CPAMM public cpamm;
          LiquidityProvider public alice;
          Swapper public bob;
      
          function setUp() external {
              token0 = new ERC20("token0", "TK0", 0);
              token1 = new ERC20("token1", "TK1", 0);
              cpamm = new CPAMM(address(token0), address(token1));
              alice = new LiquidityProvider(cpamm);
              bob = new Swapper(cpamm);
      
              // Fund Alice and Bob with tokens
              token0.mint(address(alice), 1000);
              token1.mint(address(alice), 1000);
              token0.mint(address(bob), 1000);
              token1.mint(address(bob), 1000);
          }
      }
      
      ## Creating Debugging Scenarios
      
      Now that the system is deployed, we can create debugging scenarios. Here’s a scenario where Alice adds liquidity.
      A scneario is just plain-old Solidity functions.
      
      ~~~solidity
      contract DebugCPAMM {
          // ... setUp code ...
      
          function debugAddLiquidity() public {
              uint256 aliceShares = alice.addLiquidity(100, 100);
          }
      }
      ~~~
  
      The following debugSwap function outlines a more complex scenario where Alice adds liquidity, Bob swaps tokens, and Alice eventually withdraws her liquidity.
      We also check balances before and after these operations to understand how the market actions impact users:
      
      ~~~solidity
      contract DebugCPAMM {
          // ... setUp code ...
      
          function debugSwap() public {
              // Balances before operations
              uint256 alice0Before = token0.balanceOf(address(alice));
              uint256 alice1Before = token1.balanceOf(address(alice));
              uint256 bob0Before = token0.balanceOf(address(bob));
              uint256 bob1Before = token1.balanceOf(address(bob));
          
              // Alice adds liquidity
              uint256 aliceShares = alice.addLiquidity(100, 100);
          
              // Bob swaps 50 tokens
              bob.swap(address(token0), 50);
          
              // Alice removes liquidity
              alice.removeLiquidity(aliceShares);
          
              // Balances after operations
              uint256 alice0After = token0.balanceOf(address(alice));
              uint256 alice1After = token1.balanceOf(address(alice));
              uint256 bob0After = token0.balanceOf(address(bob));
              uint256 bob1After = token1.balanceOf(address(bob));
          }
      ~~~

      ---

      The following message explains in detail how to handle specific scenarios when debugging with Simbolik.
      You must follow the same approach.

      ---

      Simbolik has certain restrictions about the functions you can debug.
      By default, it only allows you to debug parameterless public and external functions of contracts without constructor parameters.
      This is a soft limitation and does not mean you cannot debug internal functions or functions with parameters - but it requires some boilerplate code.

      Generating the boilerplate code is your responsibility.

      Here are some examples of how to debug functions that don't fall under the aforementioned restrictions:

      ## How to debug functions with parameters?
  
      Let's assume you want to debug a function Greeter.greet(string memory phrase).
      This function takes a parameter, so the ▷ Debug button will not appear.
      Simbolik does not know the value you will pass to the greet function.
      The simplest way to tell Simbolik is by defining a new entry point smart contract and a new debuggable function that calls the original greet function, passing down the parameters:

      ~~~solidity
      contract DebugGreeter is Greeter {
          function debug_greet() external {
              greet("Hello World!");
          }
      }
      ~~~
  
      The wrapping function takes no parameters, so the ▷ Debug will show up and can jump right into it.

      ## How to debug internal functions?

      Internal functions cannot be called directly from a transaction, but we can use the same pattern as above to make them debuggable. We define a new entry point smart contract and a new external function calling the internal function:

      ~~~solidity
      contract DebugContract is MyContract {

        function debug_my_internal_function() external {
            my_internal_function();
        }
      }
      ~~~

      ## How to debug private functions?
      
      We're afraid debugging private functions is currently not supported.

      ## How to debug contracts with constructor parameters?
  
      When your smart contract takes constructor arguments, Simbolik must know the values used to deploy it.
      The pattern is the same as above: We define a new entry-point debugging contract that inherits from the original contract, fixing all deployment parameters of the inherited contract.

      ~~~solidity
      contract DebugContact is MyContract("Hello, World") {

        function debug_my_function() external {
            my_function();
        }

      }
      ~~~

      Instead of inheriting, you can also deploy the original contract inside the constructor of the entry point smart contract.

      ~~~solidity
      contract DebugContract {

          MyContract myContract;

          function setUp() external {
              myContract = new MyContract("Hello, World!");    
          }

          function debug_my_function() external {
              myContract.my_function();
          }

      }
      ~~~

      ## How to debug multi-contract systems?
      
      Most real-world smart contracts do not operate in isolation but depend on other smart contracts to operate. Let's assume you have two contracts ContractA and ContractB, where ContractB depends on ContractA.

      The pattern is the same as above: Define a new entry point DebugContract and a new debuggable function:

      ~~~solidity
      contract DebugContract {

          MyContractA myContractA;
          MyContractB myContractB;

          function setUp() external {
              myContractA = new MyContractA();
              myContractB = new MyContractB(address(myContractA));    
          }
          
          function debug_my_function() external {
              myContractB.my_function();
          }

      }
      ~~~
    `)
  ]
}