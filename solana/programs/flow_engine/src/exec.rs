//! Executing steps: the token-multiset state machine (Flow's semantics, on one
//! account). A step consumes its token, checks its timer and guard, captures
//! fields, applies its asset operation and hands tokens to its successors and
//! message targets. `advance` then runs every step that needs nobody: gateways,
//! joins, receives, ends and automatic service steps whose time has come —
//! straight-through processing, so CRE only has to deliver oracle values.

use crate::def::*;
use crate::errors::EngineError;
use crate::expr::{eval, mul, SCALE};
use crate::state::*;
use anchor_lang::prelude::*;

/// What a step needs from outside the definition.
pub struct Ctx<'a> {
    pub now: i64,
    /// The role-holder who signed (None: a CRE report or straight-through).
    pub signer: Option<Pubkey>,
    pub inputs: &'a [Slot],
    pub oracle: &'a [i128],
    /// XOR decided by a person: index into the step's `next`.
    pub choice: Option<u16>,
}

/// SPL movements the instruction must perform after the state change.
#[derive(Default)]
pub struct Effects {
    /// (asset, base units, from) — cash into the process vault.
    pub deposits: Vec<(u8, u64, Pubkey)>,
}

#[event]
pub struct StepRun {
    pub process: Pubkey,
    pub step: u16,
    pub kind: u8,
}

fn token_count(p: &Process, i: u16) -> usize {
    p.tokens.iter().filter(|&&t| t == i).count()
}

fn take_tokens(p: &mut Process, i: u16, n: usize) -> Result<()> {
    require!(token_count(p, i) >= n.max(1), EngineError::StepNotActive);
    for _ in 0..n.max(1) {
        let pos = p.tokens.iter().position(|&t| t == i).unwrap();
        p.tokens.remove(pos);
    }
    Ok(())
}

fn add_token(p: &mut Process, i: u16) -> Result<()> {
    require!(p.tokens.len() < MAX_TOKENS, EngineError::TooManyTokens);
    p.tokens.push(i);
    Ok(())
}

/// When a timed step becomes due (None: the date field is not set yet).
fn due_at(p: &Process, d: &Due) -> Option<i64> {
    match d.kind {
        0 => Some(d.at),
        _ => {
            let s = p.values.get(d.field as usize)?;
            if s.tag == 0 { None } else { i64::try_from(s.as_i128()).ok() }
        }
    }
}

fn is_due(p: &Process, s: &StepDef, now: i64) -> bool {
    match &s.timer {
        None => true,
        Some(d) => due_at(p, d).map_or(false, |t| now >= t),
    }
}

fn eval_num(p: &Process, d: &WorkflowDef, expr: u16) -> Result<Option<i128>> {
    let prog = d.exprs.get(expr as usize).ok_or(error!(EngineError::BadDefinition))?;
    eval(prog, &p.values, &d.kinds)
}

fn holds(p: &Process, d: &WorkflowDef, expr: u16) -> Result<Option<bool>> {
    Ok(eval_num(p, d, expr)?.map(|v| v != 0))
}

/// The XOR branch to take, if it can be decided without a person.
fn xor_pick(p: &Process, d: &WorkflowDef, s: &StepDef) -> Result<Option<usize>> {
    let conditioned = s.next.iter().any(|e| e.cond != NO_EXPR);
    if !conditioned {
        return Ok(if s.next.len() == 1 { Some(0) } else { None });
    }
    for (k, e) in s.next.iter().enumerate() {
        if e.cond == NO_EXPR || e.is_default {
            continue;
        }
        match holds(p, d, e.cond)? {
            Some(true) => return Ok(Some(k)),
            Some(false) => {}
            None => return Ok(None), // a field is not set yet: wait
        }
    }
    Ok(s.next.iter().position(|e| e.is_default || e.cond == NO_EXPR))
}

pub fn credit(p: &mut Process, owner: Pubkey, asset: u8, amt: i128) -> Result<()> {
    if amt == 0 {
        return Ok(());
    }
    if let Some(h) = p.holdings.iter_mut().find(|h| h.owner == owner && h.asset == asset) {
        h.amount = h.amount.checked_add(amt).ok_or(error!(EngineError::Overflow))?;
        return Ok(());
    }
    require!(p.holdings.len() < MAX_HOLDINGS, EngineError::HoldingsFull);
    p.holdings.push(Holding { owner, asset, amount: amt });
    Ok(())
}

pub fn debit(p: &mut Process, owner: Pubkey, asset: u8, amt: i128) -> Result<()> {
    if amt == 0 {
        return Ok(());
    }
    let h = p.holdings.iter_mut().find(|h| h.owner == owner && h.asset == asset).ok_or(error!(EngineError::InsufficientBalance))?;
    require!(h.amount >= amt, EngineError::InsufficientBalance);
    h.amount -= amt;
    Ok(())
}

pub fn deposit_credit(p: &mut Process, owner: Pubkey, asset: u8, base: u64, decimals: u8) -> Result<()> {
    let amt = (base as i128).checked_mul(SCALE).ok_or(error!(EngineError::Overflow))? / 10i128.pow(decimals as u32);
    credit(p, owner, asset, amt)
}

/// Fixed-point amount to SPL base units (truncated).
pub fn to_base(amount: i128, decimals: u8) -> Result<u64> {
    let v = amount.checked_mul(10i128.pow(decimals as u32)).ok_or(error!(EngineError::Overflow))? / SCALE;
    u64::try_from(v).map_err(|_| error!(EngineError::Overflow))
}

fn amount(p: &Process, d: &WorkflowDef, expr: u16) -> Result<i128> {
    let v = eval_num(p, d, expr)?.ok_or(error!(EngineError::FieldNotSet))?;
    require!(v >= 0, EngineError::InsufficientBalance);
    Ok(v)
}

/// The key acting as role `r`: its holder, or for an OPEN role the signer.
fn role(p: &Process, r: u8, ctx: &Ctx) -> Result<Pubkey> {
    let k = p.roles.get(r as usize).copied().ok_or(error!(EngineError::BadDefinition))?;
    if k == Pubkey::default() {
        return ctx.signer.ok_or(error!(EngineError::WrongRole));
    }
    Ok(k)
}

fn apply_op(p: &mut Process, d: &WorkflowDef, o: &AssetOp, ctx: &Ctx, fx: &mut Effects) -> Result<()> {
    match o.kind {
        op::NONE => {}
        op::MINT => {
            let a = amount(p, d, o.amount)?;
            credit(p, role(p, o.to_role, ctx)?, o.asset, a)?;
        }
        op::BURN => {
            let a = amount(p, d, o.amount)?;
            debit(p, role(p, o.from_role, ctx)?, o.asset, a)?;
        }
        op::TRANSFER => {
            let a = amount(p, d, o.amount)?;
            debit(p, role(p, o.from_role, ctx)?, o.asset, a)?;
            credit(p, role(p, o.to_role, ctx)?, o.asset, a)?;
        }
        op::SWAP => {
            let a = amount(p, d, o.amount)?;
            let b = amount(p, d, o.amount2)?;
            debit(p, role(p, o.from_role, ctx)?, o.asset, a)?;
            debit(p, role(p, o.from_role2, ctx)?, o.asset2, b)?;
            credit(p, role(p, o.to_role, ctx)?, o.asset, a)?;
            credit(p, role(p, o.to_role2, ctx)?, o.asset2, b)?;
        }
        op::DEPOSIT => {
            let from = role(p, o.from_role, ctx)?;
            require!(ctx.signer == Some(from), EngineError::WrongRole);
            let asset = d.assets.get(o.asset as usize).ok_or(error!(EngineError::BadDefinition))?;
            require!(asset.kind == akind::CASH, EngineError::NotCash);
            let base = to_base(amount(p, d, o.amount)?, asset.decimals)?;
            deposit_credit(p, from, o.asset, base, asset.decimals)?;
            fx.deposits.push((o.asset, base, from));
        }
        op::DISTRIBUTE => {
            // Pay every holder of `asset2` units x per-unit of `asset`, from
            // `from_role`. The ledger is in this account, so "every holder" is
            // complete by construction (Flow proved it with sum == supply).
            let per_unit = amount(p, d, o.amount)?;
            let payer = role(p, o.from_role, ctx)?;
            let holders: Vec<(Pubkey, i128)> = p.holdings.iter().filter(|h| h.asset == o.asset2 && h.amount > 0).map(|h| (h.owner, h.amount)).collect();
            for (owner, units) in holders {
                let pay = mul(units, per_unit)?;
                debit(p, payer, o.asset, pay)?;
                credit(p, owner, o.asset, pay)?;
                if o.retire {
                    debit(p, owner, o.asset2, units)?;
                }
            }
        }
        _ => return err!(EngineError::BadDefinition),
    }
    Ok(())
}

fn set_capture(p: &mut Process, d: &WorkflowDef, c: &Capture, v: Slot) -> Result<()> {
    let f = d.fields.get(c.field as usize).ok_or(error!(EngineError::BadDefinition))?;
    let ok = match f.kind {
        fkind::TEXT => v.tag == 2,
        fkind::PARTY => v.tag == 3,
        _ => v.tag == 1,
    };
    require!(ok, EngineError::BadInputs);
    let slot = p.values.get_mut(c.field as usize).ok_or(error!(EngineError::BadDefinition))?;
    *slot = v;
    Ok(())
}

/// Run one step that holds a token.
pub fn run_step(key: Pubkey, p: &mut Process, d: &WorkflowDef, i: u16, ctx: &Ctx, fx: &mut Effects) -> Result<()> {
    require!(p.status == status::RUNNING, EngineError::ProcessFinished);
    let s = d.steps.get(i as usize).ok_or(error!(EngineError::BadDefinition))?;
    if let Some(until) = &s.until {
        require!(token_count(p, i) >= 1, EngineError::StepNotActive);
        if window_open(p, until, ctx.now) {
            // A run inside the window: capture and apply, keep the token.
            require!(ctx.signer.is_some(), EngineError::WrongRole);
            run_body(p, d, s, ctx, fx)?;
            p.steps_run = p.steps_run.saturating_add(1);
            p.updated_at = ctx.now;
            emit!(StepRun { process: key, step: i, kind: s.kind });
            return Ok(());
        }
        // The window has closed: pass the token on, nothing else.
        take_tokens(p, i, 1)?;
        return pass_on(key, p, d, i, s, ctx);
    }
    if s.join > 0 {
        require!(token_count(p, i) >= s.join as usize, EngineError::JoinNotReady);
        take_tokens(p, i, s.join as usize)?;
    } else {
        take_tokens(p, i, 1)?;
    }
    require!(is_due(p, s, ctx.now), EngineError::NotDue);
    if s.guard != NO_EXPR {
        require!(holds(p, d, s.guard)? == Some(true), EngineError::GuardNotMet);
    }

    run_body(p, d, s, ctx, fx)?;
    pass_on(key, p, d, i, s, ctx)
}

fn window_open(p: &Process, until: &Due, now: i64) -> bool {
    due_at(p, until).map_or(true, |t| now < t)
}

/// Captures, then the asset operations.
fn run_body(p: &mut Process, d: &WorkflowDef, s: &StepDef, ctx: &Ctx, fx: &mut Effects) -> Result<()> {
    let (mut ni, mut no) = (0usize, 0usize);
    for c in &s.captures {
        let v = match c.source {
            src::INPUT => {
                let v = *ctx.inputs.get(ni).ok_or(error!(EngineError::BadInputs))?;
                ni += 1;
                v
            }
            src::ORACLE => {
                let v = *ctx.oracle.get(no).ok_or(error!(EngineError::OracleOnlyViaReport))?;
                no += 1;
                require!(v >= c.min as i128 && v <= c.max as i128, EngineError::OracleOutOfBounds);
                Slot::number(v)
            }
            _ => Slot::number(eval_num(p, d, c.expr)?.ok_or(error!(EngineError::FieldNotSet))?),
        };
        set_capture(p, d, c, v)?;
    }
    require!(ni == ctx.inputs.len() && no == ctx.oracle.len(), EngineError::BadInputs);
    for o in &s.ops {
        apply_op(p, d, o, ctx, fx)?;
    }
    Ok(())
}

/// Hand the step's tokens to its successors and message targets.
fn pass_on(key: Pubkey, p: &mut Process, d: &WorkflowDef, i: u16, s: &StepDef, ctx: &Ctx) -> Result<()> {
    match s.kind {
        kind::END => {}
        kind::XOR => {
            // A person chooses only at an UNCONDITIONED gateway; a conditioned
            // one waits for its data and is never overridden.
            let conditioned = s.next.iter().any(|e| e.cond != NO_EXPR);
            let k = match xor_pick(p, d, s)? {
                Some(k) => k,
                None if !conditioned => ctx.choice.map(|c| c as usize).filter(|&c| c < s.next.len()).ok_or(error!(EngineError::NoBranch))?,
                None => return err!(EngineError::NoBranch),
            };
            add_token(p, s.next[k].target)?;
        }
        _ => {
            for e in &s.next {
                add_token(p, e.target)?;
            }
        }
    }
    for &t in &s.sends {
        add_token(p, t)?;
    }
    p.steps_run = p.steps_run.saturating_add(1);
    p.updated_at = ctx.now;
    emit!(StepRun { process: key, step: i, kind: s.kind });
    Ok(())
}

/// Can this token's step run with nobody's input?
fn runs_itself(p: &Process, d: &WorkflowDef, i: u16, now: i64) -> Result<bool> {
    let s = &d.steps[i as usize];
    if let Some(until) = &s.until {
        return Ok(!window_open(p, until, now));
    }
    if !is_due(p, s, now) {
        return Ok(false);
    }
    Ok(match s.kind {
        kind::END | kind::CATCH => true,
        kind::AND => s.join == 0 || token_count(p, i) >= s.join as usize,
        kind::XOR => xor_pick(p, d, s)?.is_some(),
        kind::RECEIVE => s.guard == NO_EXPR || holds(p, d, s.guard)? == Some(true),
        kind::SERVICE => !s.needs_oracle() && !s.needs_input() && !s.has_deposit(),
        _ => false,
    })
}

/// Straight-through processing: run every step that needs nobody, until none can.
pub fn advance(key: Pubkey, p: &mut Process, d: &WorkflowDef, now: i64) -> Result<()> {
    let ctx = Ctx { now, signer: None, inputs: &[], oracle: &[], choice: None };
    let mut fx = Effects::default();
    for _ in 0..256 {
        if p.status != status::RUNNING {
            break;
        }
        let mut next = None;
        for &t in p.tokens.iter() {
            if (t as usize) < d.steps.len() && runs_itself(p, d, t, now)? {
                next = Some(t);
                break;
            }
        }
        match next {
            Some(t) => run_step(key, p, d, t, &ctx, &mut fx)?,
            None => break,
        }
        if p.tokens.is_empty() {
            p.status = status::COMPLETED;
        }
    }
    if p.tokens.is_empty() {
        p.status = status::COMPLETED;
    }
    Ok(())
}
