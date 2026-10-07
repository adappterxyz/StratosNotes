//! Local stand-in for Chainlink's keystone forwarder (tests only). The real
//! forwarder verifies the DON's signatures over a report, then CPIs into the
//! receiver's `on_report(metadata, report)` signing as the PDA
//! ["forwarder", state, receiver_program]. This mock skips the signature check
//! and keeps the exact CPI shape, so the engine's receiver path is tested as it
//! runs on devnet.
//!
//! It also stands in for Chainlink CCIP (tests only), acting as both router
//! and offramp: `init_allowed_offramp` creates the router's allowed-offramp PDA,
//! `deliver` CPIs a receiver's `ccip_receive` signing as the offramp's
//! external-execution PDA, and `ccip_send` takes the router's exact arguments
//! and accounts, pulls the approved tokens as the fee-billing signer and the
//! fee in SOL from the authority, and records the message.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke_signed};
use anchor_spl::token::{self, Transfer};

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

    /// CCIP router: allow this program as the offramp for `selector`.
    pub fn init_allowed_offramp(_ctx: Context<InitAllowedOfframp>, _selector: u64) -> Result<()> {
        Ok(())
    }

    /// CCIP offramp: call `receiver`'s ccip_receive with `message` (Borsh Any2SVMMessage).
    /// Remaining accounts: the receiver's accounts (listed in the message's extra args).
    pub fn deliver<'info>(ctx: Context<'_, '_, '_, 'info, Deliver<'info>>, message: Vec<u8>) -> Result<()> {
        let receiver = ctx.accounts.receiver.key();
        let (authority, bump) = Pubkey::find_program_address(&[b"external_execution_config", receiver.as_ref()], &crate::ID);
        require_keys_eq!(authority, ctx.accounts.authority.key());
        let mut data = anchor_lang::solana_program::hash::hash(b"global:ccip_receive").to_bytes()[..8].to_vec();
        data.extend_from_slice(&message);
        let mut metas = vec![
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new_readonly(crate::ID, false),
            AccountMeta::new_readonly(ctx.accounts.allowed_offramp.key(), false),
        ];
        let mut infos = vec![ctx.accounts.authority.to_account_info(), ctx.accounts.this_program.to_account_info(), ctx.accounts.allowed_offramp.to_account_info()];
        for a in ctx.remaining_accounts {
            metas.push(if a.is_writable { AccountMeta::new(a.key(), a.is_signer) } else { AccountMeta::new_readonly(a.key(), a.is_signer) });
            infos.push(a.clone());
        }
        infos.push(ctx.accounts.receiver.to_account_info());
        invoke_signed(&Instruction { program_id: receiver, accounts: metas, data }, &infos, &[&[b"external_execution_config", receiver.as_ref(), &[bump]]])?;
        Ok(())
    }

    /// CCIP router `ccip_send` (same discriminator, arguments and fixed accounts).
    /// Accounts used: [3] authority (signer, pays `FEE` lamports to [8]), [9] fee-billing
    /// signer (this program's PDA, the token delegate), [18] the authority's token
    /// account; the tokens go to the last remaining account (a sink for tests).
    pub fn ccip_send<'info>(ctx: Context<'_, '_, '_, 'info, CcipSend>, dest_chain_selector: u64, message: SVM2AnyMessage, token_indexes: Vec<u8>) -> Result<()> {
        let r = ctx.remaining_accounts;
        require!(r.len() >= 20 && r[3].is_signer && token_indexes == vec![0u8] && message.token_amounts.len() == 1, MockError::BadSend);
        let (fbs, bump) = Pubkey::find_program_address(&[b"fee_billing_signer"], &crate::ID);
        require_keys_eq!(r[9].key(), fbs);
        // Router layout: [4] is the system program; the token program is among the token's accounts.
        let token_program = r.iter().find(|a| a.key() == token::ID).ok_or(MockError::BadSend)?;
        anchor_lang::system_program::transfer(CpiContext::new(r[4].clone(), anchor_lang::system_program::Transfer {
            from: r[3].clone(), to: r[8].clone(),
        }), FEE)?;
        let sink = r.last().unwrap();
        token::transfer(CpiContext::new_with_signer(token_program.clone(), Transfer {
            from: r[18].clone(), to: sink.clone(), authority: r[9].clone(),
        }, &[&[b"fee_billing_signer", &[bump]]]), message.token_amounts[0].amount)?;
        emit!(MockCcipSent { dest_chain_selector, receiver: message.receiver, token: message.token_amounts[0].token, amount: message.token_amounts[0].amount, extra_args: message.extra_args });
        Ok(())
    }
}

pub const FEE: u64 = 5_000_000;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SVMTokenAmount {
    pub token: Pubkey,
    pub amount: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SVM2AnyMessage {
    pub receiver: Vec<u8>,
    pub data: Vec<u8>,
    pub token_amounts: Vec<SVMTokenAmount>,
    pub fee_token: Pubkey,
    pub extra_args: Vec<u8>,
}

#[event]
pub struct MockCcipSent {
    pub dest_chain_selector: u64,
    pub receiver: Vec<u8>,
    pub token: Pubkey,
    pub amount: u64,
    pub extra_args: Vec<u8>,
}

#[error_code]
pub enum MockError {
    #[msg("ccip_send accounts or arguments do not have the router's shape")]
    BadSend,
}

#[account]
pub struct AllowedOfframp {}

#[derive(Accounts)]
#[instruction(selector: u64)]
pub struct InitAllowedOfframp<'info> {
    #[account(init, payer = payer, space = 8, seeds = [b"allowed_offramp", selector.to_le_bytes().as_ref(), crate::ID.as_ref()], bump)]
    pub allowed_offramp: Account<'info, AllowedOfframp>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deliver<'info> {
    /// CHECK: this program's external-execution PDA for the receiver; checked in the handler.
    pub authority: UncheckedAccount<'info>,
    /// CHECK: this program (passed as the offramp program).
    #[account(address = crate::ID)]
    pub this_program: UncheckedAccount<'info>,
    /// CHECK: the allowed-offramp PDA (the receiver checks it).
    pub allowed_offramp: UncheckedAccount<'info>,
    /// CHECK: the receiver program (CPI target).
    pub receiver: UncheckedAccount<'info>,
}

/// Every account is positional (remaining accounts), as in the router.
#[derive(Accounts)]
pub struct CcipSend {}

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
