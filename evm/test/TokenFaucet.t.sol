// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {BurnMintERC20} from "@chainlink/contracts/src/v0.8/shared/token/ERC20/BurnMintERC20.sol";
import {TokenFaucet} from "../src/TokenFaucet.sol";

contract TokenFaucetTest is Test {
  BurnMintERC20 token;
  TokenFaucet faucet;
  address alice = address(0xA11CE);

  function setUp() public {
    token = new BurnMintERC20("StratosNotes Test USD", "tUSD", 6, 0, 0);
    faucet = new TokenFaucet();
    token.grantMintAndBurnRoles(address(faucet));
    faucet.setDrip(address(token), 2_000e6);
    vm.warp(1_800_000_000);
  }

  function test_dripsOncePerHour() public {
    vm.prank(alice);
    faucet.drip(address(token));
    assertEq(token.balanceOf(alice), 2_000e6);
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(TokenFaucet.TooSoon.selector, block.timestamp + 1 hours));
    faucet.drip(address(token));
    vm.warp(block.timestamp + 1 hours);
    vm.prank(alice);
    faucet.drip(address(token));
    assertEq(token.balanceOf(alice), 4_000e6);
  }

  function test_rejectsUnknownTokensAndStrangers() public {
    vm.expectRevert(abi.encodeWithSelector(TokenFaucet.UnknownToken.selector, address(0xBEEF)));
    faucet.drip(address(0xBEEF));
    vm.prank(alice);
    vm.expectRevert(TokenFaucet.NotOwner.selector);
    faucet.setDrip(address(token), 1);
  }
}
