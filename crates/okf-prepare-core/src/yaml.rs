use std::fmt;

use saphyr::{LoadableYamlNode, ScalarOwned, YamlOwned as SaphyrYamlOwned};

#[derive(Clone, Debug, PartialEq)]
pub enum YamlOwned {
    Null,
    Boolean(bool),
    Integer(i64),
    Float(f64),
    String(String),
    Sequence(Vec<Self>),
    Mapping(Vec<(String, Self)>),
    Tagged { tag: String, value: Box<Self> },
}

pub type YamlValue = YamlOwned;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct YamlError {
    pub message: String,
}

impl YamlOwned {
    pub fn load_from_str(source: &str) -> Result<Self, YamlError> {
        let mut documents = SaphyrYamlOwned::load_from_str(source)
            .map_err(|error| YamlError::new(error.to_string()))?;
        if documents.len() != 1 {
            return Err(YamlError::new("expected exactly one YAML document"));
        }
        convert(documents.pop().expect("document count checked"))
    }

    #[must_use]
    pub fn as_mapping(&self) -> Option<&[(String, Self)]> {
        match self {
            Self::Mapping(entries) => Some(entries),
            Self::Tagged { value, .. } => value.as_mapping(),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_sequence(&self) -> Option<&[Self]> {
        match self {
            Self::Sequence(values) => Some(values),
            Self::Tagged { value, .. } => value.as_sequence(),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            Self::Tagged { value, .. } => value.as_str(),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Boolean(value) => Some(*value),
            Self::Tagged { value, .. } => value.as_bool(),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_number(&self) -> Option<f64> {
        match self {
            Self::Integer(value) => Some(*value as f64),
            Self::Float(value) => Some(*value),
            Self::Tagged { value, .. } => value.as_number(),
            _ => None,
        }
    }
}

fn convert(value: SaphyrYamlOwned) -> Result<YamlOwned, YamlError> {
    match value {
        SaphyrYamlOwned::Representation(value, _, _) => Ok(YamlOwned::String(value)),
        SaphyrYamlOwned::Value(value) => Ok(match value {
            ScalarOwned::Null => YamlOwned::Null,
            ScalarOwned::Boolean(value) => YamlOwned::Boolean(value),
            ScalarOwned::Integer(value) => YamlOwned::Integer(value),
            ScalarOwned::FloatingPoint(value) => YamlOwned::Float(value.into_inner()),
            ScalarOwned::String(value) => YamlOwned::String(value),
        }),
        SaphyrYamlOwned::Sequence(values) => values
            .into_iter()
            .map(convert)
            .collect::<Result<Vec<_>, _>>()
            .map(YamlOwned::Sequence),
        SaphyrYamlOwned::Mapping(entries) => entries
            .into_iter()
            .map(|(key, value)| Ok((string_key(&key)?, convert(value)?)))
            .collect::<Result<Vec<_>, YamlError>>()
            .map(YamlOwned::Mapping),
        SaphyrYamlOwned::Tagged(tag, value) => Ok(YamlOwned::Tagged {
            tag: tag.to_string(),
            value: Box::new(convert(*value)?),
        }),
        SaphyrYamlOwned::Alias(_) => Err(YamlError::new("unresolved YAML alias")),
        SaphyrYamlOwned::BadValue => Err(YamlError::new("invalid YAML value")),
    }
}

fn string_key(value: &SaphyrYamlOwned) -> Result<String, YamlError> {
    match value {
        SaphyrYamlOwned::Representation(value, _, _) => Ok(value.clone()),
        SaphyrYamlOwned::Value(ScalarOwned::String(value)) => Ok(value.clone()),
        SaphyrYamlOwned::Tagged(_, value) => string_key(value),
        _ => Err(YamlError::new("YAML mapping keys must resolve to strings")),
    }
}

impl YamlError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for YamlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for YamlError {}
