//! Small Rust-owned frontmatter and field analysis for OKF documents.

pub mod analysis;
pub mod error;
pub mod fields;
pub mod frontmatter;
pub mod markdown;
pub mod sections;
pub mod yaml;

pub use analysis::{
    Analysis, Conformance, Input, Prepared, Validation, analyze, prepare, validate,
};
pub use error::{Diagnostic, DiagnosticCode, ERR_OKF_FIELD, ERR_OKF_PARSE, PrepareError};
pub use fields::{
    Attester, Executor, Generation, Parameter, ProjectedFields, Source, StaleAfter, Staleness,
    Status, TimeWindow, TrustTier, Verification, parse_timestamp, valid_actor, valid_timestamp,
};
pub use frontmatter::{Frontmatter, parse as parse_frontmatter};
pub use yaml::{YamlError, YamlOwned, YamlValue};
