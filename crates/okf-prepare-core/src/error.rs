pub type DiagnosticCode = &'static str;

pub const ERR_OKF_PARSE: DiagnosticCode = "ERR_OKF_PARSE";
pub const ERR_OKF_FIELD: DiagnosticCode = "ERR_OKF_FIELD";

pub type Diagnostic = PrepareError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrepareError {
    pub code: DiagnosticCode,
    pub message: String,
    pub path: String,
    pub field: Option<String>,
}

impl PrepareError {
    #[must_use]
    pub fn parse(path: impl Into<String>) -> Self {
        let path = path.into();
        Self {
            code: ERR_OKF_PARSE,
            message: format!("Cannot parse OKF concept: {path}"),
            path,
            field: None,
        }
    }

    #[must_use]
    pub fn invalid_field(path: impl Into<String>, field: impl Into<String>) -> Self {
        let path = path.into();
        let field = field.into();
        Self {
            code: ERR_OKF_FIELD,
            message: format!("Invalid OKF field: {path} ({field})"),
            path,
            field: Some(field),
        }
    }
}
