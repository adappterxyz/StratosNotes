//! StratosNotes flow engine: runs compiled BPMN workflows on Solana.
//!
//! A workflow (e.g. a structured note's Issuer / Paying Agent / Investor
//! collaboration) is compiled off-chain into a `WorkflowDef`, stored once in a
//! content-addressed `Definition`, and run by any number of `Process`
//! accounts (one per issuance). People act through `execute_step`; Chainlink
//! CRE delivers oracle observations as DON-signed reports through the
//! keystone forwarder (`on_report`); everything else runs straight through.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{self, Approve, Mint, Token, TokenAccount, Transfer};

pub mod ccip;
pub mod def;
pub mod errors;
pub mod exec;
pub mod expr;
pub mod heap;
pub mod state;

use ccip::*;
use def::*;
use errors::EngineError;
use exec::*;
use state::*;

declare_id!("9a5xpgRgK7NQMVtYvLuVq1XooK3Ca4CrKVkFEnVRGaHx");

/// What a CRE workflow reports: run `step` of `process` with these oracle
/// values (in capture order). `step == u16::MAX`: just advance (due timers).
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct Report {
    pub process: Pubkey,
    pub step: u16,
    pub values: Vec<i128>,
}

/// Check a Definition account's owner, discriminator and creator (raw access).
fn raw_header(info: &AccountInfo, data: &[u8], creator: &Pubkey) -> Result<()> {
    require_keys_eq!(*info.owner, crate::ID, EngineError::BadDefinition);
    require!(data.len() >= 81 && &data[..8] == Definition::DISCRIMINATOR, EngineError::BadDefinition);
    require!(&data[40..72] == creator.as_ref(), EngineError::NotCreator);
    Ok(())
}

/// Decode a sealed definition straight from the account's data (no Anchor
/// copy of the bytes: the CRE report path must fit the 32 KiB heap).
/// Layout: discriminator 8 | hash 32 | creator 32 | sealed 1 | len 4 | vec len 4 | bytes.
fn load(info: &AccountInfo) -> Result<WorkflowDef> {
    require_keys_eq!(*info.owner, crate::ID, EngineError::BadDefinition);
    let data = info.try_borrow_data()?;
    require!(data.len() >= 81 && &data[..8] == Definition::DISCRIMINATOR, EngineError::BadDefinition);
    require!(data[72] == 1, EngineError::NotSealed);
    let n = u32::from_le_bytes([data[77], data[78], data[79], data[80]]) as usize;
    require!(data.len() >= 81 + n, EngineError::BadDefinition);
    let mut d = WorkflowDef::try_from_slice(&data[81..81 + n]).map_err(|_| error!(EngineError::BadDefinition))?;
    d.kinds = d.fields.iter().map(|f| f.kind).collect();
    Ok(d)
}

/// CRE's payout decision for a remote holder: debit their whole balance of a
/// token asset, move the tokens from the vault to the engine's CCIP sender
/// account and record the payout in the outbox for anyone to deliver.
/// `rem`: ccip_config, outbox (w), sender PDA, sender token account (w), vault (w), token program.
fn queue_payout<'info>(p: &mut Account<'info, Process>, d: &WorkflowDef, r: &Report, rem: &'info [AccountInfo<'info>], now: i64) -> Result<()> {
    require!(r.values.len() == 3 && rem.len() >= 6, EngineError::BadReport);
    let mut hb = [0u8; 32];
    hb[..16].copy_from_slice(&r.values[0].to_le_bytes());
    hb[16..].copy_from_slice(&r.values[1].to_le_bytes());
    let holder = Pubkey::new_from_array(hb);
    let asset = u8::try_from(r.values[2]).map_err(|_| error!(EngineError::BadReport))?;
    let (chain, _) = remote_of(&holder).ok_or(error!(EngineError::NotRemote))?;
    let cfg: Account<CcipConfig> = Account::try_from(&rem[0])?;
    require_keys_eq!(cfg.key(), Pubkey::find_program_address(&[b"ccip_config"], &crate::ID).0, EngineError::BadCcipAccounts);
    require!((chain as usize) < cfg.chains.len(), EngineError::UntrustedCcip);
    let mut outbox: Account<Outbox> = Account::try_from(&rem[1])?;
    require_keys_eq!(outbox.key(), Pubkey::find_program_address(&[b"outbox"], &crate::ID).0, EngineError::BadCcipAccounts);
    require!(outbox.payouts.len() < MAX_OUTBOX, EngineError::OutboxFull);
    let (sender, _) = Pubkey::find_program_address(&[b"ccip_sender"], &crate::ID);
    require_keys_eq!(rem[2].key(), sender, EngineError::BadCcipAccounts);
    let sender_token: Account<TokenAccount> = Account::try_from(&rem[3])?;
    let mint = *p.mints.get(asset as usize).ok_or(error!(EngineError::BadInputs))?;
    require!(sender_token.owner == sender && sender_token.mint == mint, EngineError::BadCcipAccounts);
    let key = p.key();
    let (vk, _) = Pubkey::find_program_address(&[b"vault", key.as_ref(), &[asset]], &crate::ID);
    require_keys_eq!(rem[4].key(), vk, EngineError::BadCcipAccounts);
    require_keys_eq!(rem[5].key(), token::ID, EngineError::BadCcipAccounts);
    let a = d.assets.get(asset as usize).ok_or(error!(EngineError::BadInputs))?;
    require!(a.kind == akind::CASH, EngineError::NotCash);
    let base = to_base(p.balance(&holder, asset), a.decimals)?;
    require!(base > 0, EngineError::NothingToSend);
    let amt = (base as i128).checked_mul(expr::SCALE).ok_or(error!(EngineError::Overflow))? / 10i128.pow(a.decimals as u32);
    debit(p, holder, asset, amt)?;
    let (def_key, creator, id, pbump) = (p.definition, p.creator, p.id.to_le_bytes(), p.bump);
    let pseeds: &[&[u8]] = &[b"proc", def_key.as_ref(), creator.as_ref(), &id, &[pbump]];
    token::transfer(CpiContext::new_with_signer(rem[5].clone(), Transfer {
        from: rem[4].clone(), to: rem[3].clone(), authority: p.to_account_info(),
    }, &[pseeds]), base)?;
    outbox.payouts.push(Payout { process: key, holder, mint, asset, amount: base, queued_at: now });
    outbox.exit(&crate::ID)?;
    emit!(PayoutQueued { process: key, holder, asset, amount: base });
    Ok(())
}

/// A Report's `step` for a payout decision (CRE): values = [holder low 16 bytes, holder high 16 bytes, asset].
pub const PAYOUT_STEP: u16 = u16::MAX - 1;

/// Approve the router's fee-billing signer for `amount` on the sender PDA's token account, fund the
/// CCIP fee, and CPI the router's `ccip_send` to `evm` on `dest`. `rem`: the router's accounts in order
/// (authority = the sender PDA, then the token's accounts starting with the sender's token account), then the router.
#[allow(clippy::too_many_arguments)]
fn ccip_send_tokens<'info>(
    rem: &'info [AccountInfo<'info>], router: Pubkey, sender: &AccountInfo<'info>, sender_bump: u8, sender_token: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>, system_program: &AccountInfo<'info>, payer: &AccountInfo<'info>, fee_lamports: u64,
    dest: u64, evm: &[u8; 20], mint: Pubkey, amount: u64,
) -> Result<()> {
    require!(rem.len() > 19, EngineError::BadCcipAccounts);
    let (router_info, metas_infos) = rem.split_last().unwrap();
    require_keys_eq!(router_info.key(), router, EngineError::BadCcipAccounts);
    require_keys_eq!(metas_infos[3].key(), sender.key(), EngineError::BadCcipAccounts);
    require_keys_eq!(metas_infos[18].key(), sender_token.key(), EngineError::BadCcipAccounts);
    let sseeds: &[&[u8]] = &[b"ccip_sender", &[sender_bump]];
    token::approve(CpiContext::new_with_signer(token_program.clone(), Approve {
        to: sender_token.clone(), delegate: metas_infos[9].clone(), authority: sender.clone(),
    }, &[sseeds]), amount)?;
    if fee_lamports > 0 {
        anchor_lang::system_program::transfer(CpiContext::new(system_program.clone(), anchor_lang::system_program::Transfer {
            from: payer.clone(), to: sender.clone(),
        }), fee_lamports)?;
    }
    let msg = SVM2AnyMessage {
        receiver: evm_receiver(evm),
        data: vec![],
        token_amounts: vec![SVMTokenAmount { token: mint, amount }],
        fee_token: Pubkey::default(),
        extra_args: evm_extra_args(0),
    };
    let mut data = CCIP_SEND.to_vec();
    dest.serialize(&mut data)?;
    msg.serialize(&mut data)?;
    vec![0u8].serialize(&mut data)?; // token_indexes: the token's accounts start right after the fixed ones
    let sk = sender.key();
    let metas: Vec<AccountMeta> = metas_infos.iter().map(|i| AccountMeta { pubkey: i.key(), is_signer: i.is_signer || i.key() == sk, is_writable: i.is_writable }).collect();
    invoke_signed(&Instruction { program_id: router, accounts: metas, data }, metas_infos, &[sseeds])?;
    Ok(())
}

fn check_def(d: &WorkflowDef) -> Result<()> {
    require!(d.version == DEF_VERSION, EngineError::BadDefinition);
    require!(!d.roles.is_empty() && d.roles.len() <= MAX_ROLES, EngineError::BadDefinition);
    require!(d.fields.len() <= MAX_FIELDS && d.assets.len() <= MAX_ASSETS, EngineError::BadDefinition);
    require!(!d.steps.is_empty() && d.steps.len() < u16::MAX as usize, EngineError::BadDefinition);
    let n = d.steps.len() as u16;
    for s in &d.steps {
        require!((s.role as usize) < d.roles.len(), EngineError::BadDefinition);
        require!(s.next.iter().all(|e| e.target < n) && s.sends.iter().all(|&t| t < n), EngineError::BadDefinition);
        require!(s.captures.iter().all(|c| (c.field as usize) < d.fields.len()), EngineError::BadDefinition);
    }
    Ok(())
}

#[program]
pub mod flow_engine {
    use super::*;

    /// One-time: the admin and the forwarder programs whose reports are accepted.
    pub fn init_config(ctx: Context<InitConfig>, forwarders: Vec<Pubkey>) -> Result<()> {
        require!(forwarders.len() <= MAX_FORWARDERS, EngineError::BadDefinition);
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.forwarders = forwarders;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_forwarders(ctx: Context<SetForwarders>, forwarders: Vec<Pubkey>) -> Result<()> {
        require!(forwarders.len() <= MAX_FORWARDERS, EngineError::BadDefinition);
        require_keys_eq!(ctx.accounts.config.admin, ctx.accounts.admin.key(), EngineError::NotAdmin);
        ctx.accounts.config.forwarders = forwarders;
        Ok(())
    }

    /// Start storing a compiled workflow of `len` bytes whose SHA-256 is `hash`.
    pub fn create_definition(ctx: Context<CreateDefinition>, hash: [u8; 32], len: u32) -> Result<()> {
        let d = &mut ctx.accounts.definition;
        d.hash = hash;
        d.creator = ctx.accounts.creator.key();
        d.sealed = false;
        d.len = len;
        d.data = vec![];
        Ok(())
    }

    /// Append one chunk, written straight into the account (it grows to fit).
    pub fn write_definition(ctx: Context<WriteDefinition>, bytes: Vec<u8>) -> Result<()> {
        let info = ctx.accounts.definition.to_account_info();
        let (cur, total) = {
            let data = info.try_borrow_data()?;
            raw_header(&info, &data, &ctx.accounts.creator.key())?;
            require!(data[72] == 0, EngineError::AlreadySealed);
            let total = u32::from_le_bytes([data[73], data[74], data[75], data[76]]) as usize;
            let cur = u32::from_le_bytes([data[77], data[78], data[79], data[80]]) as usize;
            (cur, total)
        };
        let new_len = cur + bytes.len();
        require!(new_len <= total, EngineError::BadDefinition);
        let size = Definition::space(new_len);
        if info.data_len() < size {
            let top_up = Rent::get()?.minimum_balance(size).saturating_sub(info.lamports());
            if top_up > 0 {
                anchor_lang::system_program::transfer(
                    CpiContext::new(ctx.accounts.system_program.to_account_info(), anchor_lang::system_program::Transfer {
                        from: ctx.accounts.creator.to_account_info(), to: info.clone(),
                    }),
                    top_up,
                )?;
            }
            info.resize(size)?;
        }
        let mut data = info.try_borrow_mut_data()?;
        data[81 + cur..81 + new_len].copy_from_slice(&bytes);
        data[77..81].copy_from_slice(&(new_len as u32).to_le_bytes());
        Ok(())
    }

    /// Verify the hash, check the workflow, and freeze the definition.
    pub fn seal_definition(ctx: Context<SealDefinition>) -> Result<()> {
        let info = ctx.accounts.definition.to_account_info();
        {
            let data = info.try_borrow_data()?;
            raw_header(&info, &data, &ctx.accounts.creator.key())?;
            require!(data[72] == 0, EngineError::AlreadySealed);
            let total = u32::from_le_bytes([data[73], data[74], data[75], data[76]]) as usize;
            let cur = u32::from_le_bytes([data[77], data[78], data[79], data[80]]) as usize;
            require!(cur == total && data.len() >= 81 + cur, EngineError::BadDefinition);
            let bytes = &data[81..81 + cur];
            let h = anchor_lang::solana_program::hash::hash(bytes).to_bytes();
            require!(h[..] == data[8..40], EngineError::HashMismatch);
            let wf = WorkflowDef::try_from_slice(bytes).map_err(|_| error!(EngineError::BadDefinition))?;
            check_def(&wf)?;
        }
        info.try_borrow_mut_data()?[72] = 1;
        Ok(())
    }

    /// Start a run: the signer holds the start step's role.
    pub fn start_process(ctx: Context<StartProcess>, id: u64, roles: Vec<Pubkey>, mints: Vec<Pubkey>, start_step: u16, inputs: Vec<Slot>) -> Result<()> {
        let d = load(&ctx.accounts.definition.to_account_info())?;
        require!(roles.len() == d.roles.len() && mints.len() == d.assets.len(), EngineError::BadInputs);
        let s = d.steps.get(start_step as usize).ok_or(error!(EngineError::BadDefinition))?;
        require!(s.kind == kind::START, EngineError::WrongStepKind);
        require_keys_eq!(roles[s.role as usize], ctx.accounts.signer.key(), EngineError::WrongRole);
        let now = Clock::get()?.unix_timestamp;
        let key = ctx.accounts.process.key();
        let p = &mut ctx.accounts.process;
        p.definition = ctx.accounts.definition.key();
        p.id = id;
        p.creator = ctx.accounts.signer.key();
        p.bump = ctx.bumps.process;
        p.status = status::RUNNING;
        p.roles = roles;
        p.mints = mints;
        p.tokens = vec![start_step];
        p.values = vec![Slot::default(); d.fields.len()];
        p.holdings = vec![];
        p.created_at = now;
        p.updated_at = now;
        p.steps_run = 0;
        let mut fx = Effects::default();
        run_step(key, p, &d, start_step, &Ctx { now, signer: Some(ctx.accounts.signer.key()), inputs: &inputs, oracle: &[], choice: None }, &mut fx)?;
        require!(fx.deposits.is_empty(), EngineError::BadDepositAccounts);
        advance(key, p, &d, now)
    }

    /// Open the process's vault for a cash asset (an SPL token account it controls).
    pub fn open_vault(_ctx: Context<OpenVault>, _asset: u8) -> Result<()> {
        Ok(())
    }

    /// A role-holder runs a step: a user task, a decision, or a stuck service step.
    pub fn execute_step<'info>(ctx: Context<'_, '_, '_, 'info, ExecuteStep<'info>>, step: u16, choice: Option<u16>, inputs: Vec<Slot>) -> Result<()> {
        let d = load(&ctx.accounts.definition.to_account_info())?;
        let s = d.steps.get(step as usize).ok_or(error!(EngineError::BadDefinition))?;
        require!(!s.needs_oracle(), EngineError::OracleOnlyViaReport);
        require!(matches!(s.kind, kind::USER | kind::SERVICE | kind::XOR | kind::RECEIVE | kind::CATCH), EngineError::WrongStepKind);
        let signer = ctx.accounts.signer.key();
        let now = Clock::get()?.unix_timestamp;
        let key = ctx.accounts.process.key();
        let p = &mut ctx.accounts.process;
        let holder = p.roles[s.role as usize];
        require!(holder == signer || holder == Pubkey::default(), EngineError::WrongRole);
        let mut fx = Effects::default();
        run_step(key, p, &d, step, &Ctx { now, signer: Some(signer), inputs: &inputs, oracle: &[], choice }, &mut fx)?;
        advance(key, p, &d, now)?;

        // Cash in: move the SPL tokens the step committed to.
        require!(fx.deposits.len() <= 1, EngineError::BadDepositAccounts);
        if let Some((asset, base, from)) = fx.deposits.first().copied() {
            let (Some(mint), Some(src), Some(vault), Some(tp)) = (&ctx.accounts.mint, &ctx.accounts.from_token, &ctx.accounts.vault, &ctx.accounts.token_program) else {
                return err!(EngineError::BadDepositAccounts);
            };
            require_keys_eq!(mint.key(), p.mints[asset as usize], EngineError::BadDepositAccounts);
            require_keys_eq!(src.owner, from, EngineError::BadDepositAccounts);
            let (vk, _) = Pubkey::find_program_address(&[b"vault", key.as_ref(), &[asset]], &crate::ID);
            require_keys_eq!(vault.key(), vk, EngineError::BadDepositAccounts);
            token::transfer(CpiContext::new(tp.to_account_info(), Transfer {
                from: src.to_account_info(), to: vault.to_account_info(), authority: ctx.accounts.signer.to_account_info(),
            }), base)?;
        }
        Ok(())
    }

    /// Anyone: run whatever can run now (e.g. after a top-up, or a due timer).
    pub fn poke(ctx: Context<Poke>) -> Result<()> {
        let d = load(&ctx.accounts.definition.to_account_info())?;
        let key = ctx.accounts.process.key();
        advance(key, &mut ctx.accounts.process, &d, Clock::get()?.unix_timestamp)
    }

    /// Put cash into the process on your own account (e.g. an issuer topping up coupons).
    pub fn deposit(ctx: Context<Deposit>, asset: u8, base: u64) -> Result<()> {
        let d = load(&ctx.accounts.definition.to_account_info())?;
        let a = d.assets.get(asset as usize).ok_or(error!(EngineError::BadInputs))?;
        require!(a.kind == akind::CASH, EngineError::NotCash);
        let p = &mut ctx.accounts.process;
        require_keys_eq!(ctx.accounts.mint.key(), p.mints[asset as usize], EngineError::BadDepositAccounts);
        deposit_credit(p, ctx.accounts.signer.key(), asset, base, a.decimals)?;
        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer {
            from: ctx.accounts.from_token.to_account_info(), to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.signer.to_account_info(),
        }), base)
    }

    /// Take your cash out of the process.
    pub fn withdraw(ctx: Context<Withdraw>, asset: u8, base: u64) -> Result<()> {
        let d = load(&ctx.accounts.definition.to_account_info())?;
        let a = d.assets.get(asset as usize).ok_or(error!(EngineError::BadInputs))?;
        require!(a.kind == akind::CASH, EngineError::NotCash);
        let p = &mut ctx.accounts.process;
        require_keys_eq!(ctx.accounts.mint.key(), p.mints[asset as usize], EngineError::BadDepositAccounts);
        let amt = (base as i128).checked_mul(expr::SCALE).ok_or(error!(EngineError::Overflow))? / 10i128.pow(a.decimals as u32);
        debit(p, ctx.accounts.signer.key(), asset, amt)?;
        let (def_key, creator, id, bump) = (p.definition, p.creator, p.id.to_le_bytes(), p.bump);
        let seeds: &[&[u8]] = &[b"proc", def_key.as_ref(), creator.as_ref(), &id, &[bump]];
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
            from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.to_token.to_account_info(), authority: p.to_account_info(),
        }, &[seeds]), base)
    }

    /// A holder moves note units (an ISSUED asset) to another key, in whole or
    /// in part. Later coupons and redemptions pay whoever holds the units then:
    /// distributions read this ledger.
    pub fn transfer_units(ctx: Context<TransferUnits>, asset: u8, to: Pubkey, amount: i128) -> Result<()> {
        let d = load(&ctx.accounts.definition.to_account_info())?;
        let a = d.assets.get(asset as usize).ok_or(error!(EngineError::BadInputs))?;
        require!(a.kind == akind::ISSUED, EngineError::NotTransferable);
        require!(amount > 0 && to != Pubkey::default(), EngineError::BadInputs);
        let from = ctx.accounts.signer.key();
        let p = &mut ctx.accounts.process;
        debit(p, from, asset, amount)?;
        credit(p, to, asset, amount)?;
        emit!(UnitsTransferred { process: p.key(), asset, from, to, amount });
        Ok(())
    }

    /// Admin: the CCIP router whose offramps may deliver, and the chains notes accept.
    pub fn set_ccip(ctx: Context<SetCcip>, router: Pubkey, chains: Vec<u64>) -> Result<()> {
        require!(chains.len() <= MAX_CCIP_CHAINS, EngineError::BadInputs);
        require_keys_eq!(ctx.accounts.config.admin, ctx.accounts.admin.key(), EngineError::NotAdmin);
        let c = &mut ctx.accounts.ccip_config;
        // Chains only append: a remote holder's key names its chain by index.
        require!(c.chains.iter().zip(chains.iter()).all(|(a, b)| a == b) && chains.len() >= c.chains.len(), EngineError::BadInputs);
        c.router = router;
        c.chains = chains;
        c.bump = ctx.bumps.ccip_config;
        Ok(())
    }

    /// Chainlink CCIP: a message (and tokens) from a holder on another chain.
    /// Called by a CCIP offramp the router allows; see `ccip.rs`.
    pub fn ccip_receive(ctx: Context<CcipReceive>, message: Any2SVMMessage) -> Result<()> {
        let chain = ctx.accounts.ccip_config.chains.iter().position(|&c| c == message.source_chain_selector)
            .ok_or(error!(EngineError::UntrustedCcip))?;
        require!(message.sender.len() >= 20 && message.token_amounts.len() <= 1, EngineError::BadCcipMessage);
        let mut evm = [0u8; 20];
        evm.copy_from_slice(&message.sender[message.sender.len() - 20..]);
        let sender = remote_key(chain as u8, &evm);
        let call = CcipCall::try_from_slice(&message.data).map_err(|_| error!(EngineError::BadCcipMessage))?;

        let d = load(&ctx.accounts.definition.to_account_info())?;
        let key = ctx.accounts.process.key();
        let now = Clock::get()?.unix_timestamp;
        let (received, asset) = match message.token_amounts.first() {
            Some(t) => {
                let a = ctx.accounts.process.mints.iter().position(|m| *m == t.token).ok_or(error!(EngineError::UnknownMint))? as u8;
                require!(d.assets.get(a as usize).map_or(false, |x| x.kind == akind::CASH), EngineError::NotCash);
                require_keys_eq!(ctx.accounts.inbox_token.mint, t.token, EngineError::BadCcipAccounts);
                (t.amount, Some(a))
            }
            None => (0, None),
        };
        let p = &mut ctx.accounts.process;
        let (mut used, mut ran) = (0u64, true);
        match call {
            CcipCall::Run { process, step, inputs } => {
                require_keys_eq!(process, key, EngineError::WrongProcess);
                // Run on a copy first: if the step cannot run (e.g. the book closed while the
                // message was in flight), keep the process as it was and refund the sender.
                let snapshot: Process = (**p).clone();
                let mut fx = Effects::default();
                let ok = (|| -> Result<()> {
                    let s = d.steps.get(step as usize).ok_or(error!(EngineError::BadDefinition))?;
                    require!(s.kind == kind::USER, EngineError::WrongStepKind);
                    // A message that arrives after the window closed must not close it as a side effect.
                    require!(!window_closed(p, s, now), EngineError::StepNotActive);
                    let holder = p.roles[s.role as usize];
                    require!(holder == sender || holder == Pubkey::default(), EngineError::WrongRole);
                    run_step(key, p, &d, step, &Ctx { now, signer: Some(sender), inputs: &inputs, oracle: &[], choice: None }, &mut fx)?;
                    advance(key, p, &d, now)?;
                    for &(a, base, from) in fx.deposits.iter() {
                        require!(Some(a) == asset && from == sender && used + base <= received, EngineError::BadDepositAccounts);
                        used += base;
                    }
                    Ok(())
                })();
                if ok.is_err() {
                    p.set_inner(snapshot);
                    used = 0;
                    ran = false;
                }
            }
            CcipCall::Deposit { process, role } => {
                require_keys_eq!(process, key, EngineError::WrongProcess);
                let a = asset.ok_or(error!(EngineError::BadCcipMessage))?;
                let to = match p.roles.get(role as usize).copied().ok_or(error!(EngineError::BadInputs))? {
                    k if k == Pubkey::default() => sender,
                    k => k,
                };
                deposit_credit(p, to, a, received, d.assets[a as usize].decimals)?;
                used = received;
            }
        }
        // Whatever the step did not take stays the sender's, withdrawable back to its chain.
        if let Some(a) = asset {
            if received > used {
                deposit_credit(p, sender, a, received - used, d.assets[a as usize].decimals)?;
            }
            let (vk, _) = Pubkey::find_program_address(&[b"vault", key.as_ref(), &[a]], &crate::ID);
            require_keys_eq!(ctx.accounts.vault.key(), vk, EngineError::BadCcipAccounts);
            let bump = ctx.bumps.inbox;
            token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                from: ctx.accounts.inbox_token.to_account_info(), to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.inbox.to_account_info(),
            }, &[&[b"ccip_inbox", &[bump]]]), received)?;
        }
        emit!(CcipReceived { process: key, message_id: message.message_id, sender, received, used, ran });
        Ok(())
    }

    /// Anyone: send a remote holder's balance of a token asset to its chain over CCIP.
    /// `remaining_accounts`: the router's `ccip_send` accounts in order (with this
    /// program's sender PDA as authority), then the router program.
    pub fn withdraw_remote<'info>(ctx: Context<'_, '_, 'info, 'info, WithdrawRemote<'info>>, holder: Pubkey, asset: u8, fee_lamports: u64) -> Result<()> {
        let (chain, evm) = remote_of(&holder).ok_or(error!(EngineError::NotRemote))?;
        let dest = *ctx.accounts.ccip_config.chains.get(chain as usize).ok_or(error!(EngineError::UntrustedCcip))?;
        let router = ctx.accounts.ccip_config.router;
        let d = load(&ctx.accounts.definition.to_account_info())?;
        let a = d.assets.get(asset as usize).ok_or(error!(EngineError::BadInputs))?;
        require!(a.kind == akind::CASH, EngineError::NotCash);
        let decimals = a.decimals;
        let mint = ctx.accounts.mint.key();
        let key = ctx.accounts.process.key();

        // 1. Debit the holder's whole balance (in whole base units of the token).
        let base = {
            let p = &mut ctx.accounts.process;
            require_keys_eq!(mint, p.mints[asset as usize], EngineError::BadCcipAccounts);
            let base = to_base(p.balance(&holder, asset), decimals)?;
            require!(base > 0, EngineError::NothingToSend);
            let amt = (base as i128).checked_mul(expr::SCALE).ok_or(error!(EngineError::Overflow))? / 10i128.pow(decimals as u32);
            debit(p, holder, asset, amt)?;
            base
        };

        // 2. Vault -> the sender PDA's token account, then the router's ccip_send (helper).
        let p = &ctx.accounts.process;
        let (def_key, creator, id, pbump) = (p.definition, p.creator, p.id.to_le_bytes(), p.bump);
        let pseeds: &[&[u8]] = &[b"proc", def_key.as_ref(), creator.as_ref(), &id, &[pbump]];
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
            from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.sender_token.to_account_info(), authority: ctx.accounts.process.to_account_info(),
        }, &[pseeds]), base)?;
        ccip_send_tokens(
            ctx.remaining_accounts, router, &ctx.accounts.sender.to_account_info(), ctx.bumps.sender, &ctx.accounts.sender_token.to_account_info(),
            &ctx.accounts.token_program.to_account_info(), &ctx.accounts.system_program.to_account_info(), &ctx.accounts.payer.to_account_info(), fee_lamports,
            dest, &evm, mint, base,
        )?;
        emit!(CcipSent { process: key, holder, asset, amount: base, dest_chain_selector: dest });
        Ok(())
    }

    /// Create the outbox of CRE-decided payouts (once; anyone may pay for it).
    pub fn init_outbox(ctx: Context<InitOutbox>) -> Result<()> {
        ctx.accounts.outbox.bump = ctx.bumps.outbox;
        Ok(())
    }

    /// Anyone: deliver payout `index` from the outbox over CCIP, exactly as CRE
    /// recorded it (holder's address, token, amount). `remaining_accounts`: the
    /// router's `ccip_send` accounts in order, then the router program.
    pub fn flush_outbox<'info>(ctx: Context<'_, '_, 'info, 'info, FlushOutbox<'info>>, index: u16, fee_lamports: u64) -> Result<()> {
        let po = *ctx.accounts.outbox.payouts.get(index as usize).ok_or(error!(EngineError::NothingToSend))?;
        require_keys_eq!(po.mint, ctx.accounts.mint.key(), EngineError::BadCcipAccounts);
        let (chain, evm) = remote_of(&po.holder).ok_or(error!(EngineError::NotRemote))?;
        let dest = *ctx.accounts.ccip_config.chains.get(chain as usize).ok_or(error!(EngineError::UntrustedCcip))?;
        ccip_send_tokens(
            ctx.remaining_accounts, ctx.accounts.ccip_config.router, &ctx.accounts.sender.to_account_info(), ctx.bumps.sender, &ctx.accounts.sender_token.to_account_info(),
            &ctx.accounts.token_program.to_account_info(), &ctx.accounts.system_program.to_account_info(), &ctx.accounts.payer.to_account_info(), fee_lamports,
            dest, &evm, po.mint, po.amount,
        )?;
        ctx.accounts.outbox.payouts.swap_remove(index as usize);
        emit!(CcipSent { process: po.process, holder: po.holder, asset: po.asset, amount: po.amount, dest_chain_selector: dest });
        Ok(())
    }

    /// Chainlink CRE: the keystone forwarder CPIs here with a DON-verified report.
    pub fn on_report<'info>(ctx: Context<'_, '_, 'info, 'info, OnReport<'info>>, _metadata: Vec<u8>, report: Vec<u8>) -> Result<()> {
        // The forwarder program owns `state` and signs as PDA("forwarder", state, this program).
        let fwd = *ctx.accounts.state.owner;
        require!(ctx.accounts.config.forwarders.contains(&fwd), EngineError::UntrustedForwarder);
        let state_key = ctx.accounts.state.key();
        let (authority, _) = Pubkey::find_program_address(&[b"forwarder", state_key.as_ref(), crate::ID.as_ref()], &fwd);
        require_keys_eq!(authority, ctx.accounts.forwarder_authority.key(), EngineError::InvalidForwarderAuthority);

        let r = Report::try_from_slice(&report).map_err(|_| error!(EngineError::BadReport))?;
        let key = ctx.accounts.process.key();
        require_keys_eq!(r.process, key, EngineError::WrongProcess);
        let d = load(&ctx.accounts.definition.to_account_info())?;
        let now = Clock::get()?.unix_timestamp;
        if r.step == PAYOUT_STEP {
            return queue_payout(&mut ctx.accounts.process, &d, &r, ctx.remaining_accounts, now);
        }
        let p = &mut ctx.accounts.process;
        if r.step != u16::MAX {
            let s = d.steps.get(r.step as usize).ok_or(error!(EngineError::BadReport))?;
            require!(matches!(s.kind, kind::SERVICE | kind::CATCH), EngineError::WrongStepKind);
            let mut fx = Effects::default();
            run_step(key, p, &d, r.step, &Ctx { now, signer: None, inputs: &[], oracle: &r.values, choice: None }, &mut fx)?;
        }
        advance(key, p, &d, now)
    }
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(init, payer = admin, space = Config::SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetForwarders<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(hash: [u8; 32])]
pub struct CreateDefinition<'info> {
    #[account(init, payer = creator, space = Definition::space(0), seeds = [b"def", hash.as_ref()], bump)]
    pub definition: Account<'info, Definition>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WriteDefinition<'info> {
    /// CHECK: a Definition owned by this program, written raw (checked in the handler).
    #[account(mut)]
    pub definition: UncheckedAccount<'info>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SealDefinition<'info> {
    /// CHECK: a Definition owned by this program, checked in the handler.
    #[account(mut)]
    pub definition: UncheckedAccount<'info>,
    pub creator: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct StartProcess<'info> {
    #[account(init, payer = signer, space = Process::SPACE, seeds = [b"proc", definition.key().as_ref(), signer.key().as_ref(), &id.to_le_bytes()], bump)]
    pub process: Account<'info, Process>,
    /// CHECK: a sealed Definition owned by this program (checked in `load`).
    pub definition: UncheckedAccount<'info>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(asset: u8)]
pub struct OpenVault<'info> {
    pub process: Account<'info, Process>,
    #[account(constraint = mint.key() == process.mints[asset as usize] @ EngineError::BadDepositAccounts)]
    pub mint: Account<'info, Mint>,
    #[account(init_if_needed, payer = payer, seeds = [b"vault", process.key().as_ref(), &[asset]], bump, token::mint = mint, token::authority = process)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteStep<'info> {
    #[account(mut, has_one = definition)]
    pub process: Account<'info, Process>,
    /// CHECK: a sealed Definition owned by this program (checked in `load`).
    pub definition: UncheckedAccount<'info>,
    pub signer: Signer<'info>,
    /// Only for steps that take a cash deposit.
    pub mint: Option<Account<'info, Mint>>,
    #[account(mut)]
    pub from_token: Option<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub vault: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
}

#[derive(Accounts)]
pub struct Poke<'info> {
    #[account(mut, has_one = definition)]
    pub process: Account<'info, Process>,
    /// CHECK: a sealed Definition owned by this program (checked in `load`).
    pub definition: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(asset: u8)]
pub struct Deposit<'info> {
    #[account(mut, has_one = definition)]
    pub process: Account<'info, Process>,
    /// CHECK: a sealed Definition owned by this program (checked in `load`).
    pub definition: UncheckedAccount<'info>,
    pub signer: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = signer)]
    pub from_token: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", process.key().as_ref(), &[asset]], bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(asset: u8)]
pub struct Withdraw<'info> {
    #[account(mut, has_one = definition)]
    pub process: Account<'info, Process>,
    /// CHECK: a sealed Definition owned by this program (checked in `load`).
    pub definition: UncheckedAccount<'info>,
    pub signer: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint)]
    pub to_token: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", process.key().as_ref(), &[asset]], bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct UnitsTransferred {
    pub process: Pubkey,
    pub asset: u8,
    pub from: Pubkey,
    pub to: Pubkey,
    pub amount: i128,
}

#[derive(Accounts)]
pub struct TransferUnits<'info> {
    #[account(mut, has_one = definition)]
    pub process: Account<'info, Process>,
    /// CHECK: a sealed Definition owned by this program (checked in `load`).
    pub definition: UncheckedAccount<'info>,
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetCcip<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init_if_needed, payer = admin, space = CcipConfig::SPACE, seeds = [b"ccip_config"], bump)]
    pub ccip_config: Account<'info, CcipConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// The CCIP receiver interface: the offramp's authority PDA signs; the router's
/// allowed_offramp PDA proves the offramp is allowed for the source chain. The
/// rest are this program's accounts, listed by the sender in the message's
/// extra args (process, definition, inbox, inbox token account, vault, token program).
#[derive(Accounts)]
#[instruction(message: Any2SVMMessage)]
pub struct CcipReceive<'info> {
    #[account(seeds = [b"external_execution_config", crate::ID.as_ref()], bump, seeds::program = offramp_program.key())]
    pub authority: Signer<'info>,
    /// CHECK: only used to derive the authority and allowed_offramp PDAs.
    pub offramp_program: UncheckedAccount<'info>,
    /// CHECK: exists (owned by the router) only if the router allows this offramp for the source chain.
    #[account(
        owner = ccip_config.router @ EngineError::UntrustedCcip,
        seeds = [b"allowed_offramp", message.source_chain_selector.to_le_bytes().as_ref(), offramp_program.key().as_ref()],
        bump,
        seeds::program = ccip_config.router,
    )]
    pub allowed_offramp: UncheckedAccount<'info>,
    #[account(seeds = [b"ccip_config"], bump = ccip_config.bump)]
    pub ccip_config: Account<'info, CcipConfig>,
    #[account(mut, has_one = definition)]
    pub process: Account<'info, Process>,
    /// CHECK: a sealed Definition owned by this program (checked in `load`).
    pub definition: UncheckedAccount<'info>,
    /// CHECK: the inbox PDA: CCIP delivers tokens to its token accounts (the message's token receiver).
    #[account(seeds = [b"ccip_inbox"], bump)]
    pub inbox: UncheckedAccount<'info>,
    #[account(mut, token::authority = inbox)]
    pub inbox_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(holder: Pubkey, asset: u8)]
pub struct WithdrawRemote<'info> {
    #[account(mut, has_one = definition)]
    pub process: Account<'info, Process>,
    /// CHECK: a sealed Definition owned by this program (checked in `load`).
    pub definition: UncheckedAccount<'info>,
    #[account(seeds = [b"ccip_config"], bump = ccip_config.bump)]
    pub ccip_config: Account<'info, CcipConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the sender PDA (holds only SOL): CCIP's `authority`, paying the fee in SOL.
    #[account(mut, seeds = [b"ccip_sender"], bump)]
    pub sender: UncheckedAccount<'info>,
    #[account(mut, token::mint = mint, token::authority = sender)]
    pub sender_token: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", process.key().as_ref(), &[asset]], bump)]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitOutbox<'info> {
    #[account(init, payer = payer, space = Outbox::SPACE, seeds = [b"outbox"], bump)]
    pub outbox: Account<'info, Outbox>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FlushOutbox<'info> {
    #[account(mut, seeds = [b"outbox"], bump = outbox.bump)]
    pub outbox: Account<'info, Outbox>,
    #[account(seeds = [b"ccip_config"], bump = ccip_config.bump)]
    pub ccip_config: Account<'info, CcipConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the sender PDA (holds only SOL): CCIP's `authority`, paying the fee in SOL.
    #[account(mut, seeds = [b"ccip_sender"], bump)]
    pub sender: UncheckedAccount<'info>,
    #[account(mut, token::mint = mint, token::authority = sender)]
    pub sender_token: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OnReport<'info> {
    /// CHECK: the forwarder's state account; its owner must be an accepted forwarder program.
    pub state: UncheckedAccount<'info>,
    /// The forwarder's PDA signer for this receiver (checked in the handler).
    pub forwarder_authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = definition)]
    pub process: Account<'info, Process>,
    /// CHECK: a sealed Definition owned by this program (checked in `load`).
    pub definition: UncheckedAccount<'info>,
}
