use anchor_lang::prelude::*;

pub const MAX_ROLES: usize = 8;
pub const MAX_TOKENS: usize = 32;
pub const MAX_FIELDS: usize = 64;
pub const MAX_HOLDINGS: usize = 64;
pub const MAX_ASSETS: usize = 8;
pub const MAX_FORWARDERS: usize = 4;
pub const MAX_CCIP_CHAINS: usize = 4;
pub const MAX_OUTBOX: usize = 32;

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

/// Chainlink CCIP: the router whose offramps may deliver messages, and the
/// source/destination chains (CCIP chain selectors) notes accept. A remote
/// holder's key names its chain by index into `chains` (see `remote_key`).
#[account]
pub struct CcipConfig {
    pub router: Pubkey,
    pub chains: Vec<u64>,
    pub bump: u8,
}

impl CcipConfig {
    pub const SPACE: usize = 8 + 32 + 4 + 8 * MAX_CCIP_CHAINS + 1;
}

/// A payout CRE has decided and locked (see `on_report`, payout kind): the
/// tokens already sit in the engine's CCIP sender account; anyone can deliver
/// it (`flush_outbox`), only to `holder`'s address, only this amount.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct Payout {
    pub process: Pubkey,
    pub holder: Pubkey,
    pub mint: Pubkey,
    pub asset: u8,
    /// Base units of the token.
    pub amount: u64,
    pub queued_at: i64,
}

#[account]
pub struct Outbox {
    pub payouts: Vec<Payout>,
    pub bump: u8,
}

impl Outbox {
    pub const SPACE: usize = 8 + 4 + (32 * 3 + 1 + 8 + 8) * MAX_OUTBOX + 1;
}

/// A holder on another chain: `[chain index + 1][11 zero bytes][20-byte EVM address]`.
/// No one holds its private key: only CCIP messages from that address (and
/// the engine, paying it out) ever act for it.
pub fn remote_key(chain: u8, evm: &[u8; 20]) -> Pubkey {
    let mut b = [0u8; 32];
    b[0] = chain + 1;
    b[12..].copy_from_slice(evm);
    Pubkey::new_from_array(b)
}

/// (chain index, EVM address) of a remote holder's key, if it is one.
pub fn remote_of(k: &Pubkey) -> Option<(u8, [u8; 20])> {
    let b = k.to_bytes();
    if b[0] == 0 || b[0] as usize > MAX_CCIP_CHAINS || b[1..12].iter().any(|&x| x != 0) {
        return None;
    }
    let mut a = [0u8; 20];
    a.copy_from_slice(&b[12..]);
    Some((b[0] - 1, a))
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
