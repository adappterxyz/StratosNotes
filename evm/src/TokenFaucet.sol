// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IMintable {
  function mint(address account, uint256 amount) external;
}

/// Test-token faucet for StratosNotes on Sepolia: anyone can claim a fixed
/// amount of each cross-chain test token (tUSD, tETH, tBTC, tSOL) once an hour.
/// It holds the tokens' minter role; it never holds funds.
contract TokenFaucet {
  uint256 public constant COOLDOWN = 1 hours;
  address public immutable owner;
  mapping(address token => uint256 amount) public dripAmount;
  mapping(address token => mapping(address account => uint256 at)) public lastDrip;

  event Dripped(address indexed token, address indexed to, uint256 amount);

  error UnknownToken(address token);
  error TooSoon(uint256 nextAt);
  error NotOwner();

  constructor() {
    owner = msg.sender;
  }

  function setDrip(address token, uint256 amount) external {
    if (msg.sender != owner) revert NotOwner();
    dripAmount[token] = amount;
  }

  function drip(address token) external {
    uint256 amount = dripAmount[token];
    if (amount == 0) revert UnknownToken(token);
    uint256 next = lastDrip[token][msg.sender] + COOLDOWN;
    if (lastDrip[token][msg.sender] != 0 && block.timestamp < next) revert TooSoon(next);
    lastDrip[token][msg.sender] = block.timestamp;
    IMintable(token).mint(msg.sender, amount);
    emit Dripped(token, msg.sender, amount);
  }
}
