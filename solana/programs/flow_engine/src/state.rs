use anchor_lang::prelude::*;

pub const MAX_ROLES: usize = 8;
pub const MAX_TOKENS: usize = 32;
pub const MAX_FIELDS: usize = 64;
pub const MAX_HOLDINGS: usize = 64;
pub const MAX_ASSETS: usize = 8;
pub const MAX_FORWARDERS: usize = 4;

/// Program-wide settings: who may deliver CRE reports.
#[account]
pub struct Config {
    pub admin: Pubkey,
    /// Keystone forwarder programs whose CPIs are accepted (the DON's, and the
    /// CRE simulator's mock forwarder on devnet).
    pub forwarders: Vec<Pubkey>,
    pub bump: u8,
}

impl Config {
    pub const SPACE: usize = 8 + 32 + 4 + 32 * MAX_FORWARDERS + 1;
}

/// A compiled workflow, addressed by the SHA-256 of its bytes. Written in
/// chunks, then sealed (hash verified); immutable after that.
#[account]
pub struct Definition {
    pub hash: [u8; 32],
    pub creator: Pubkey,
    pub sealed: bool,
    /// Total length once fully written.
    pub len: u32,
    pub data: Vec<u8>,
}

impl Definition {
    pub fn space(len: usize) -> usize {
        8 + 32 + 32 + 1 + 4 + 4 + len
    }
}

/// One field value. tag: 0 unset, 1 number (i128 LE in data[0..16]),
/// 2 text (UTF-8, zero padded), 3 public key.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug)]
pub struct Slot {
    pub tag: u8,
    pub data: [u8; 32],
}

impl Slot {
    pub fn number(v: i128) -> Self {
        let mut data = [0u8; 32];
        data[..16].copy_from_slice(&v.to_le_bytes());
        Slot { tag: 1, data }
    }
    pub fn as_i128(&self) -> i128 {
        let mut b = [0u8; 16];
        b.copy_from_slice(&self.data[..16]);
        i128::from_le_bytes(b)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct Holding {
    pub owner: Pubkey,
    pub asset: u8,
    /// Fixed point, 10 decimals.
    pub amount: i128,
}

pub mod status {
    pub const RUNNING: u8 = 0;
    pub const COMPLETED: u8 = 1;
}

/// One run of a workflow (e.g. one issuance of a note).
#[account]
pub struct Process {
    pub definition: Pubkey,
    pub id: u64,
    pub creator: Pubkey,
    pub bump: u8,
    pub status: u8,
    /// One key per role (pool), in definition order.
    pub roles: Vec<Pubkey>,
    /// SPL mint per asset (default key for ISSUED assets).
    pub mints: Vec<Pubkey>,
    /// Live BPMN tokens: a multiset of step indexes (parallel branches).
    pub tokens: Vec<u16>,
    pub values: Vec<Slot>,
    pub holdings: Vec<Holding>,
    pub created_at: i64,
    pub updated_at: i64,
    pub steps_run: u32,
}

impl Process {
    pub const SPACE: usize = 8 + 32 + 8 + 32 + 1 + 1
        + 4 + 32 * MAX_ROLES
        + 4 + 32 * MAX_ASSETS
        + 4 + 2 * MAX_TOKENS
        + 4 + 33 * MAX_FIELDS
        + 4 + (32 + 1 + 16) * MAX_HOLDINGS
        + 8 + 8 + 4;

    pub fn balance(&self, owner: &Pubkey, asset: u8) -> i128 {
        self.holdings.iter().filter(|h| h.owner == *owner && h.asset == asset).map(|h| h.amount).sum()
    }
}
