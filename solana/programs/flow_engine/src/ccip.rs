//! Chainlink CCIP: notes with holders on other chains.
//!
//! Inbound (`ccip_receive`): a Sepolia investor or issuer sends tokens plus a
//! payload to the CCIP router; the offramp calls the engine, which moves the
//! tokens from its inbox into the note's vault and either runs a step for the
//! sender (e.g. subscribe) or credits a role (e.g. the issuer's reserve). A
//! step that cannot run (the book closed while the message was in flight)
//! never strands funds: the process is restored and the tokens are credited to
//! the sender, who can send them back with `withdraw_remote`.
//!
//! Outbound (`withdraw_remote`): anyone moves a remote holder's balance out of
//! the vault and CPIs the router's `ccip_send`; the engine's sender PDA signs
//! and pays the CCIP fee in SOL, funded by the caller.

use anchor_lang::prelude::*;
use crate::state::Slot;

/// What the CCIP offramp passes to a receiver (CCIP's Any2SVMMessage).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Any2SVMMessage {
    pub message_id: [u8; 32],
    pub source_chain_selector: u64,
    pub sender: Vec<u8>,
    pub data: Vec<u8>,
    pub token_amounts: Vec<SVMTokenAmount>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct SVMTokenAmount {
    pub token: Pubkey,
    pub amount: u64,
}

/// The payload a remote caller puts in the message's data (Borsh).
#[derive(AnchorSerialize, AnchorDeserialize)]
pub enum CcipCall {
    /// Run a user step as the sender (e.g. subscribe); the tokens fund its deposit.
    Run { process: Pubkey, step: u16, inputs: Vec<Slot> },
    /// Credit the tokens to a role of the process (the sender, for an open role).
    Deposit { process: Pubkey, role: u8 },
}

/// The router's SVM2AnyMessage (what `ccip_send` takes).
#[derive(AnchorSerialize)]
pub struct SVM2AnyMessage {
    pub receiver: Vec<u8>,
    pub data: Vec<u8>,
    pub token_amounts: Vec<SVMTokenAmount>,
    pub fee_token: Pubkey,
    pub extra_args: Vec<u8>,
}

/// Anchor discriminator of the router's `ccip_send`.
pub const CCIP_SEND: [u8; 8] = [108, 216, 134, 191, 249, 234, 33, 84];

/// EVM destination extra args: GenericExtraArgsV2 (tag, then Borsh u128 gas limit, bool).
pub fn evm_extra_args(gas_limit: u128) -> Vec<u8> {
    let mut v = vec![0x18, 0x1d, 0xcf, 0x10];
    v.extend_from_slice(&gas_limit.to_le_bytes());
    v.push(1); // allow out-of-order execution
    v
}

/// An EVM address as CCIP expects a receiver: ABI-encoded (left-padded to 32 bytes).
pub fn evm_receiver(addr: &[u8; 20]) -> Vec<u8> {
    let mut v = vec![0u8; 12];
    v.extend_from_slice(addr);
    v
}

#[event]
pub struct CcipReceived {
    pub process: Pubkey,
    pub message_id: [u8; 32],
    pub sender: Pubkey,
    /// Base units received and how many were used by the step (the rest is credited to the sender).
    pub received: u64,
    pub used: u64,
    /// false: the step could not run; everything was credited to the sender.
    pub ran: bool,
}

#[event]
pub struct CcipSent {
    pub process: Pubkey,
    pub holder: Pubkey,
    pub asset: u8,
    pub amount: u64,
    pub dest_chain_selector: u64,
}
