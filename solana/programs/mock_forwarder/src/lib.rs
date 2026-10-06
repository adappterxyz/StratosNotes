//! Local stand-in for Chainlink's keystone forwarder (tests only). The real
//! forwarder verifies the DON's signatures over a report, then CPIs into the
//! receiver's `on_report(metadata, report)` signing as the PDA
//! ["forwarder", state, receiver_program]. This mock skips the signature check
//! and keeps the exact CPI shape, so the engine's receiver path is tested as it
//! runs on devnet.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke_signed};

declare_id!("E5yD9T1GUpnrkWqiDgmqQVq621Ydc4LSnhrcnYwTuNoX");

#[program]
pub mod mock_forwarder {
    use super::*;

    pub fn init_state(_ctx: Context<InitState>) -> Result<()> {
        Ok(())
    }

    /// Deliver `report` to `receiver`'s on_report; remaining accounts are the receiver's.
    pub fn forward<'info>(ctx: Context<'_, '_, '_, 'info, Forward<'info>>, metadata: Vec<u8>, report: Vec<u8>) -> Result<()> {
        let state = ctx.accounts.state.key();
        let receiver = ctx.accounts.receiver.key();
        let (authority, bump) = Pubkey::find_program_address(&[b"forwarder", state.as_ref(), receiver.as_ref()], &crate::ID);
        require_keys_eq!(authority, ctx.accounts.authority.key());

        let mut data = anchor_lang::solana_program::hash::hash(b"global:on_report").to_bytes()[..8].to_vec();
        metadata.serialize(&mut data)?;
        report.serialize(&mut data)?;
        let mut metas = vec![AccountMeta::new_readonly(state, false), AccountMeta::new_readonly(authority, true)];
        let mut infos = vec![ctx.accounts.state.to_account_info(), ctx.accounts.authority.to_account_info()];
        for a in ctx.remaining_accounts {
            metas.push(if a.is_writable { AccountMeta::new(a.key(), a.is_signer) } else { AccountMeta::new_readonly(a.key(), a.is_signer) });
            infos.push(a.clone());
        }
        infos.push(ctx.accounts.receiver.to_account_info());
        invoke_signed(&Instruction { program_id: receiver, accounts: metas, data }, &infos, &[&[b"forwarder", state.as_ref(), receiver.as_ref(), &[bump]]])?;
        Ok(())
    }
}

#[account]
pub struct ForwarderState {}

#[derive(Accounts)]
pub struct InitState<'info> {
    #[account(init, payer = payer, space = 8)]
    pub state: Account<'info, ForwarderState>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Forward<'info> {
    pub state: Account<'info, ForwarderState>,
    /// CHECK: this program's PDA for (state, receiver); checked in the handler.
    pub authority: UncheckedAccount<'info>,
    /// CHECK: the receiver program (CPI target).
    pub receiver: UncheckedAccount<'info>,
}
