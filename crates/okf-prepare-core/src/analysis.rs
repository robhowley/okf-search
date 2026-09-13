use crate::error::Diagnostic;
use crate::fields::{ProjectedFields, project};
use crate::frontmatter::parse as parse_frontmatter;
use crate::sections::{PreparedSection, project_sections};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Conformance {
    Strict,
    Degraded,
}

impl Conformance {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Strict => "strict",
            Self::Degraded => "degraded",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Input<'a> {
    pub path: &'a str,
    pub markdown: &'a str,
    pub fallback_title: &'a str,
}

#[derive(Clone, Debug, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum Analysis {
    Fatal {
        diagnostics: Vec<Diagnostic>,
    },
    Accepted {
        fields: ProjectedFields,
        body: String,
        body_start_line: usize,
        conformance: Conformance,
        diagnostics: Vec<Diagnostic>,
    },
}

#[derive(Clone, Debug, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum Prepared {
    Fatal {
        diagnostics: Vec<Diagnostic>,
    },
    Accepted {
        document_id: String,
        fields: ProjectedFields,
        body: String,
        body_start_line: usize,
        conformance: Conformance,
        diagnostics: Vec<Diagnostic>,
        sections: Vec<PreparedSection>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Validation {
    pub is_valid: bool,
    pub is_indexable: bool,
    pub errors: Vec<Diagnostic>,
}

pub fn analyze(input: Input<'_>) -> Analysis {
    let frontmatter = match parse_frontmatter(input.markdown, input.path) {
        Ok(frontmatter) => frontmatter,
        Err(diagnostic) => {
            return Analysis::Fatal {
                diagnostics: vec![diagnostic],
            };
        }
    };

    let (fields, type_valid, diagnostics) =
        project(&frontmatter.yaml, input.path, input.fallback_title);
    if !type_valid {
        return Analysis::Fatal { diagnostics };
    }

    let conformance = if diagnostics.is_empty() {
        Conformance::Strict
    } else {
        Conformance::Degraded
    };
    Analysis::Accepted {
        fields,
        body: frontmatter.body,
        body_start_line: frontmatter.body_start_line,
        conformance,
        diagnostics,
    }
}

/// Analyze a document and project its sections using the caller-supplied document identity.
///
/// `document_id` is treated as an opaque, already-normalized identity.
pub fn prepare(input: Input<'_>, document_id: &str) -> Prepared {
    match analyze(input) {
        Analysis::Fatal { diagnostics } => Prepared::Fatal { diagnostics },
        Analysis::Accepted {
            fields,
            body,
            body_start_line,
            conformance,
            diagnostics,
        } => {
            let sections = project_sections(document_id, &fields.title, &body, body_start_line);
            Prepared::Accepted {
                document_id: document_id.to_owned(),
                fields,
                body,
                body_start_line,
                conformance,
                diagnostics,
                sections,
            }
        }
    }
}

pub fn validate(input: Input<'_>) -> Validation {
    analyze(input).into_validation()
}

impl Analysis {
    #[must_use]
    pub fn into_validation(self) -> Validation {
        match self {
            Self::Fatal { diagnostics } => Validation {
                is_valid: false,
                is_indexable: false,
                errors: diagnostics,
            },
            Self::Accepted { diagnostics, .. } if diagnostics.is_empty() => Validation {
                is_valid: true,
                is_indexable: true,
                errors: Vec::new(),
            },
            Self::Accepted { diagnostics, .. } => Validation {
                is_valid: false,
                is_indexable: true,
                errors: diagnostics,
            },
        }
    }
}
