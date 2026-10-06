//! The compiled workflow definition: what a BPMN collaboration becomes on
//! Solana. Produced by the TypeScript compiler (`packages/flow/src/compile.ts`),
//! Borsh-encoded, stored once in a `Definition` account addressed by its
//! SHA-256, and read (never written) by every process that runs it.
//!
//! Every pool is a ROLE (one key per process; the default key = an OPEN role
//! that anyone may take, e.g. the investors in a marketplace offering). All pools share one process
//! account, so a message flow is a token handoff and a field captured in one
//! pool is visible to the others (Flow's "carried" fields need no copying).

use anchor_lang::prelude::*;

pub const DEF_VERSION: u8 = 1;

/// A length-prefixed string or byte run the engine never uses (names, ids,
/// metadata for people, apps and CRE): decoded by skipping, with no
/// allocation. Solana gives a program 32 KiB of heap that is never freed, and
/// the CRE report path cannot ask for more.
/// One byte, not zero-sized: borsh refuses vectors of zero-sized types.
#[derive(Clone, Copy, Debug, Default)]
pub struct Skip(u8);

impl AnchorDeserialize for Skip {
    fn deserialize_reader<R: std::io::Read>(r: &mut R) -> std::io::Result<Self> {
        let mut n = u32::deserialize_reader(r)? as usize;
        let mut buf = [0u8; 64];
        while n > 0 {
            let k = n.min(buf.len());
            r.read_exact(&mut buf[..k])?;
            n -= k;
        }
        Ok(Skip(0))
    }
}

impl AnchorSerialize for Skip {
    fn serialize<W: std::io::Write>(&self, w: &mut W) -> std::io::Result<()> {
        0u32.serialize(w)
    }
}

#[cfg(feature = "idl-build")]
impl anchor_lang::IdlBuild for Skip {}

/// Step kinds (BPMN element types).
pub mod kind {
    pub const START: u8 = 0;
    pub const END: u8 = 1;
    pub const USER: u8 = 2; // userTask: waits for its role's signature
    pub const SERVICE: u8 = 3; // serviceTask: runs automatically when it can
    pub const RECEIVE: u8 = 4; // receiveTask: waits for a message (token handoff)
    pub const XOR: u8 = 5; // exclusiveGateway
    pub const AND: u8 = 6; // parallelGateway (fork / join)
    pub const CATCH: u8 = 7; // intermediate timer catch event
}

/// Field kinds. Numbers are 10-decimal fixed point (like Daml's Decimal).
pub mod fkind {
    pub const DECIMAL: u8 = 0;
    pub const INT: u8 = 1;
    pub const DATE: u8 = 2; // unix seconds (stored as a plain integer, not scaled)
    pub const TEXT: u8 = 3; // up to 32 bytes
    pub const PARTY: u8 = 4; // a public key
    pub const BOOL: u8 = 5;
}

/// Capture sources.
pub mod src {
    pub const INPUT: u8 = 0; // the signer supplies it (user task / start)
    pub const ORACLE: u8 = 1; // a CRE report supplies it (DON-signed), bounds-checked
    pub const EXPR: u8 = 2; // computed from other fields
}

/// Asset operation kinds.
pub mod op {
    pub const NONE: u8 = 0;
    pub const MINT: u8 = 1; // asset -> to_role
    pub const BURN: u8 = 2; // asset from from_role
    pub const TRANSFER: u8 = 3; // asset from_role -> to_role
    pub const SWAP: u8 = 4; // atomic DvP: leg A and leg B
    pub const DEPOSIT: u8 = 5; // SPL cash from the signer (from_role) into the process vault
    pub const DISTRIBUTE: u8 = 6; // pay every holder of asset2: units x per-unit of asset, from from_role
}

/// Asset kinds.
pub mod akind {
    pub const ISSUED: u8 = 0; // units exist only in the process's holdings ledger (e.g. the note)
    pub const CASH: u8 = 1; // backed 1:1 by an SPL token held in the process vault
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct WorkflowDef {
    pub version: u8,
    pub name: Skip,
    /// Free-form JSON for people and apps (e.g. a product's term sheet, so a
    /// marketplace can show and price an offering from chain alone). Skipped.
    pub meta: Skip,
    /// Role (pool) names: only their number matters to the engine.
    pub roles: Vec<Skip>,
    pub fields: Vec<FieldDef>,
    pub assets: Vec<AssetDef>,
    /// Expression / predicate programs (RPN), referenced by index.
    pub exprs: Vec<Vec<Op>>,
    pub steps: Vec<StepDef>,
    /// Field kinds, computed once after decoding (not part of the bytes).
    #[borsh_skip]
    pub kinds: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct FieldDef {
    pub name: Skip,
    pub kind: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AssetDef {
    pub name: Skip,
    pub kind: u8,
    /// CASH: the SPL token's decimals (the mint is chosen per process at start).
    pub decimals: u8,
}

/// One RPN instruction. `code`: 0 const, 1 field, 2 add, 3 sub, 4 mul, 5 div,
/// 6 neg, 7 lt, 8 le, 9 gt, 10 ge, 11 eq, 12 ne, 13 and, 14 or, 15 not.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct Op {
    pub code: u8,
    pub field: u16,
    /// Constants (fixed point). i64 keeps the decoded definition small: the
    /// engine must fit Solana's 32 KiB heap on the CRE report path.
    pub value: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct Due {
    /// 0: fixed time `at`; 1: the Date field `field`.
    pub kind: u8,
    pub at: i64,
    pub field: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct Capture {
    pub field: u16,
    pub source: u8,
    /// EXPR: the expression index.
    pub expr: u16,
    /// ORACLE: inclusive bounds the reported value must sit in (fixed point).
    pub min: i64,
    pub max: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct AssetOp {
    pub kind: u8,
    pub asset: u8,
    pub from_role: u8,
    pub to_role: u8,
    pub amount: u16,
    /// SWAP: leg B. DISTRIBUTE: `asset2` is the holding instrument, `amount` the per-unit payout.
    pub asset2: u8,
    pub from_role2: u8,
    pub to_role2: u8,
    pub amount2: u16,
    /// DISTRIBUTE: retire (zero) the holdings it paid out on.
    pub retire: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct Edge {
    pub target: u16,
    /// XOR: predicate index; `NO_EXPR` = unconditioned.
    pub cond: u16,
    pub is_default: bool,
}

pub const NO_EXPR: u16 = u16::MAX;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StepDef {
    pub id: Skip,
    pub kind: u8,
    pub role: u8,
    pub timer: Option<Due>,
    /// RECEIVE: predicate over the fields that must hold before it accepts (`NO_EXPR` = none).
    pub guard: u16,
    pub captures: Vec<Capture>,
    /// Asset operations, applied in order, atomically (e.g. deposit then DvP).
    pub ops: Vec<AssetOp>,
    /// Repeatable window: until this time, anyone holding the role may run the
    /// step again and again (each run captures and applies its ops, keeping the
    /// token). From this time on the step closes and passes its token on.
    pub until: Option<Due>,
    pub next: Vec<Edge>,
    /// Message flows: receive steps (any pool) that get a token when this step completes.
    pub sends: Vec<u16>,
    /// AND join: tokens required before it fires (0 = not a join).
    pub join: u8,
}

impl StepDef {
    pub fn needs_oracle(&self) -> bool {
        self.captures.iter().any(|c| c.source == src::ORACLE)
    }
    pub fn needs_input(&self) -> bool {
        self.captures.iter().any(|c| c.source == src::INPUT)
    }
    pub fn has_deposit(&self) -> bool {
        self.ops.iter().any(|o| o.kind == op::DEPOSIT)
    }
}
