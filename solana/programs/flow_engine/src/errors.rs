use anchor_lang::prelude::*;

#[error_code]
pub enum EngineError {
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Division by zero")]
    DivideByZero,
    #[msg("Malformed expression in the definition")]
    BadExpression,
    #[msg("The definition is malformed or exceeds the engine's limits")]
    BadDefinition,
    #[msg("The definition is not sealed yet")]
    NotSealed,
    #[msg("The definition is already sealed")]
    AlreadySealed,
    #[msg("The definition bytes do not match their hash")]
    HashMismatch,
    #[msg("Only the definition's creator can write it")]
    NotCreator,
    #[msg("That step is not waiting (no token on it)")]
    StepNotActive,
    #[msg("A parallel join is still waiting for its other branches")]
    JoinNotReady,
    #[msg("That step's time has not come yet")]
    NotDue,
    #[msg("The message's guard does not hold")]
    GuardNotMet,
    #[msg("A field this step needs is not set yet")]
    FieldNotSet,
    #[msg("Wrong number or type of inputs for this step")]
    BadInputs,
    #[msg("An oracle value is outside the bounds the definition allows")]
    OracleOutOfBounds,
    #[msg("Oracle values arrive only in CRE reports")]
    OracleOnlyViaReport,
    #[msg("The signer does not hold the role for this step")]
    WrongRole,
    #[msg("This step cannot be run this way")]
    WrongStepKind,
    #[msg("No branch of this gateway applies; choose one")]
    NoBranch,
    #[msg("Insufficient balance for this asset operation")]
    InsufficientBalance,
    #[msg("The process holdings ledger is full")]
    HoldingsFull,
    #[msg("Too many live tokens")]
    TooManyTokens,
    #[msg("Deposit accounts are missing or do not match")]
    BadDepositAccounts,
    #[msg("The report did not come from an accepted Chainlink forwarder")]
    UntrustedForwarder,
    #[msg("forwarder_authority is not the forwarder's PDA for this receiver")]
    InvalidForwarderAuthority,
    #[msg("Report payload does not decode")]
    BadReport,
    #[msg("The report is for a different process")]
    WrongProcess,
    #[msg("Only the config admin can do this")]
    NotAdmin,
    #[msg("The process has finished")]
    ProcessFinished,
    #[msg("Asset is not cash (no SPL token behind it)")]
    NotCash,
    #[msg("Only note units (issued assets) can be transferred; withdraw cash instead")]
    NotTransferable,
    #[msg("The CCIP message did not come through an offramp the CCIP router allows, or from an accepted chain")]
    UntrustedCcip,
    #[msg("The CCIP message does not decode, or carries more than one token")]
    BadCcipMessage,
    #[msg("The token is not an asset of this process")]
    UnknownMint,
    #[msg("Not a remote (cross-chain) holder")]
    NotRemote,
    #[msg("CCIP accounts are missing or do not match")]
    BadCcipAccounts,
    #[msg("Nothing to send")]
    NothingToSend,
    #[msg("The CCIP outbox is full: flush queued payouts first")]
    OutboxFull,
}
