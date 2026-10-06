//! Fixed-point arithmetic and the RPN evaluator for gateway predicates,
//! receive guards, formula captures and asset amounts.
//!
//! Numbers are i128 with 10 decimals (SCALE = 1e10), Daml's Decimal precision.
//! Multiplication and division truncate toward zero; the TypeScript reference
//! (packages/flow/src/decimal.ts) implements the same rules, so the reference
//! payoff and the program agree exactly.

use crate::def::{fkind, Op};
use crate::errors::EngineError;
use crate::state::Slot;
use anchor_lang::prelude::*;

pub const SCALE: i128 = 10_000_000_000;

pub fn mul(a: i128, b: i128) -> Result<i128> {
    a.checked_mul(b).map(|x| x / SCALE).ok_or(error!(EngineError::Overflow))
}

pub fn div(a: i128, b: i128) -> Result<i128> {
    require!(b != 0, EngineError::DivideByZero);
    a.checked_mul(SCALE).map(|x| x / b).ok_or(error!(EngineError::Overflow))
}

/// A field's value as a number for expressions. DATE and INT are plain
/// integers, scaled up so they compare and combine with Decimals.
pub fn slot_number(slot: &Slot, kind: u8) -> Option<i128> {
    if slot.tag == 0 {
        return None;
    }
    let raw = slot.as_i128();
    match kind {
        fkind::DECIMAL => Some(raw),
        fkind::INT | fkind::DATE | fkind::BOOL => raw.checked_mul(SCALE),
        _ => None,
    }
}

/// Evaluate an RPN program. Returns Ok(None) when a referenced field is not
/// set yet (the caller waits instead of guessing).
pub fn eval(prog: &[Op], slots: &[Slot], kinds: &[u8]) -> Result<Option<i128>> {
    let mut st: [i128; 32] = [0; 32];
    let mut sp = 0usize;
    macro_rules! pop {
        () => {{
            require!(sp > 0, EngineError::BadExpression);
            sp -= 1;
            st[sp]
        }};
    }
    macro_rules! push {
        ($v:expr) => {{
            require!(sp < st.len(), EngineError::BadExpression);
            st[sp] = $v;
            sp += 1;
        }};
    }
    let b = |x: bool| if x { SCALE } else { 0 };
    for o in prog {
        match o.code {
            0 => push!(o.value as i128),
            1 => {
                let i = o.field as usize;
                require!(i < slots.len() && i < kinds.len(), EngineError::BadExpression);
                match slot_number(&slots[i], kinds[i]) {
                    Some(v) => push!(v),
                    None => return Ok(None),
                }
            }
            2 => { let y = pop!(); let x = pop!(); push!(x.checked_add(y).ok_or(error!(EngineError::Overflow))?) }
            3 => { let y = pop!(); let x = pop!(); push!(x.checked_sub(y).ok_or(error!(EngineError::Overflow))?) }
            4 => { let y = pop!(); let x = pop!(); push!(mul(x, y)?) }
            5 => { let y = pop!(); let x = pop!(); push!(div(x, y)?) }
            6 => { let x = pop!(); push!(-x) }
            7 => { let y = pop!(); let x = pop!(); push!(b(x < y)) }
            8 => { let y = pop!(); let x = pop!(); push!(b(x <= y)) }
            9 => { let y = pop!(); let x = pop!(); push!(b(x > y)) }
            10 => { let y = pop!(); let x = pop!(); push!(b(x >= y)) }
            11 => { let y = pop!(); let x = pop!(); push!(b(x == y)) }
            12 => { let y = pop!(); let x = pop!(); push!(b(x != y)) }
            13 => { let y = pop!(); let x = pop!(); push!(b(x != 0 && y != 0)) }
            14 => { let y = pop!(); let x = pop!(); push!(b(x != 0 || y != 0)) }
            15 => { let x = pop!(); push!(b(x == 0)) }
            _ => return err!(EngineError::BadExpression),
        }
    }
    require!(sp == 1, EngineError::BadExpression);
    Ok(Some(st[0]))
}
