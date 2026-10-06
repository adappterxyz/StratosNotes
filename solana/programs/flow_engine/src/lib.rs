//! StratosNotes flow engine: runs compiled BPMN workflows on Solana.
//!
//! A workflow (e.g. a structured note's Issuer / Paying Agent / Investor
//! collaboration) is compiled off-chain into a `WorkflowDef`, stored once in a
//! content-addressed `Definition`, and run by any number of `Process`
//! accounts (one per issuance). People act through `execute_step`; Chainlink
//! CRE delivers oracle observations as DON-signed reports through the
//! keystone forwarder (`on_report`); everything else runs straight through.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub mod def;
pub mod errors;
pub mod exec;
pub mod expr;
pub mod state;

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

    /// Chainlink CRE: the keystone forwarder CPIs here with a DON-verified report.
    pub fn on_report(ctx: Context<OnReport>, _metadata: Vec<u8>, report: Vec<u8>) -> Result<()> {
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
