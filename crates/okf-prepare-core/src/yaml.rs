use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    fmt,
    hash::{Hash, Hasher},
    rc::Rc,
};

use hashlink::LinkedHashMap;
use saphyr::{
    LoadableYamlNode, Scalar, ScalarOwned, Tag, Yaml as SaphyrYaml, YamlOwned as SaphyrYamlOwned,
};

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
        check_resource_limits(source)?;
        let mut documents = SaphyrYamlOwned::load_from_str(source)
            .map_err(|error| YamlError::new(error.to_string()))?;
        if documents.len() != 1 {
            return Err(YamlError::new("expected exactly one YAML document"));
        }

        let mut duplicate_documents = DuplicateDetectingYaml::load_from_str(source)
            .map_err(|error| YamlError::new(error.to_string()))?;
        let document = duplicate_documents
            .pop()
            .expect("duplicate document count checked");
        if has_duplicate_keys(&document) {
            return Err(YamlError::new("duplicate YAML mapping key"));
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

// Bound both loader passes before either can clone anchors or build recursive trees.
// Costs include anchor copies, not just the final expanded document.
const MAX_INPUT_BYTES: usize = 1024 * 1024;
const MAX_DEPTH: usize = 64;
const MAX_LOADED_NODES: usize = 100_000;
const MAX_LOADED_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy)]
struct LoadCost {
    nodes: usize,
    bytes: usize,
    depth: usize,
}

fn check_resource_limits(source: &str) -> Result<(), YamlError> {
    use saphyr_parser::{Event, Parser};

    if source.len() > MAX_INPUT_BYTES {
        return Err(YamlError::new("YAML input byte limit exceeded"));
    }
    let mut parser = Parser::new_from_str(source);
    let mut stack: Vec<(usize, LoadCost)> = Vec::new();
    let mut anchors = HashMap::<usize, LoadCost>::new();
    let mut loaded_nodes = 0;
    let mut loaded_bytes = 0;
    while let Some(event) = parser.next_event() {
        let (event, _) = event.map_err(|error| YamlError::new(error.to_string()))?;
        let (anchor, cost, start) = match event {
            Event::SequenceStart(anchor, tag) | Event::MappingStart(anchor, tag) => {
                let bytes = tag.map_or(0, |tag| tag.to_string().len());
                (
                    anchor,
                    LoadCost {
                        nodes: 1,
                        bytes,
                        depth: 1,
                    },
                    true,
                )
            }
            Event::Scalar(value, _, anchor, tag) => {
                let bytes = value.len() + tag.map_or(0, |tag| tag.to_string().len());
                (
                    anchor,
                    LoadCost {
                        nodes: 1,
                        bytes,
                        depth: 1,
                    },
                    false,
                )
            }
            Event::Alias(id) => {
                let cost = *anchors
                    .get(&id)
                    .ok_or_else(|| YamlError::new("recursive or unresolved YAML alias"))?;
                (0, cost, false)
            }
            Event::SequenceEnd | Event::MappingEnd => {
                let (anchor, cost) = stack.pop().expect("parser balances collections");
                // Children and collection were already charged as events arrived.
                if anchor != 0 {
                    loaded_nodes += cost.nodes;
                    loaded_bytes += cost.bytes;
                    anchors.insert(anchor, cost);
                }
                if let Some((_, parent)) = stack.last_mut() {
                    parent.nodes += cost.nodes;
                    parent.bytes += cost.bytes;
                    parent.depth = parent.depth.max(cost.depth + 1);
                }
                if loaded_nodes > MAX_LOADED_NODES || loaded_bytes > MAX_LOADED_BYTES {
                    return Err(YamlError::new("YAML expansion limit exceeded"));
                }
                continue;
            }
            Event::DocumentStart(_) => {
                anchors.clear();
                continue;
            }
            _ => continue,
        };
        if stack.len() + cost.depth > MAX_DEPTH {
            return Err(YamlError::new("YAML nesting limit exceeded"));
        }
        loaded_nodes += cost.nodes;
        loaded_bytes += cost.bytes;
        if start {
            stack.push((anchor, cost));
        } else {
            if anchor != 0 {
                loaded_nodes += cost.nodes;
                loaded_bytes += cost.bytes;
                anchors.insert(anchor, cost);
            }
            if let Some((_, parent)) = stack.last_mut() {
                parent.nodes += cost.nodes;
                parent.bytes += cost.bytes;
                parent.depth = parent.depth.max(cost.depth + 1);
            }
        }
        if loaded_nodes > MAX_LOADED_NODES || loaded_bytes > MAX_LOADED_BYTES {
            return Err(YamlError::new("YAML expansion limit exceeded"));
        }
    }
    Ok(())
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

fn has_duplicate_keys(value: &DuplicateDetectingYaml) -> bool {
    match &value.value {
        DuplicateValue::Sequence(values) => values.iter().any(has_duplicate_keys),
        DuplicateValue::Mapping(entries) => {
            let mut keys = HashSet::new();
            entries.iter().any(|(key, value)| {
                let duplicate = string_key_value(key).is_some_and(|key| !keys.insert(key));
                duplicate || has_duplicate_keys(key) || has_duplicate_keys(value)
            })
        }
        DuplicateValue::Tagged(value) => has_duplicate_keys(value),
        _ => false,
    }
}

fn string_key_value(value: &DuplicateDetectingYaml) -> Option<&str> {
    match &value.value {
        DuplicateValue::String(value) => Some(value),
        DuplicateValue::Tagged(value) => string_key_value(value),
        _ => None,
    }
}

// Saphyr's loader stores mappings in a hash map. Unique node identities keep
// every loaded pair so duplicate string keys can be checked after parsing.
#[derive(Debug)]
struct DuplicateDetectingYaml {
    identity: Rc<u8>,
    value: DuplicateValue,
}

#[derive(Clone, Debug)]
enum DuplicateValue {
    String(String),
    Other,
    Sequence(Vec<DuplicateDetectingYaml>),
    Mapping(LinkedHashMap<DuplicateDetectingYaml, DuplicateDetectingYaml>),
    Tagged(Box<DuplicateDetectingYaml>),
    BadValue,
}

impl DuplicateDetectingYaml {
    fn new(value: DuplicateValue) -> Self {
        Self {
            identity: Rc::new(0),
            value,
        }
    }
}

// Loader copies represent aliases or anchor values. Give each copy a fresh
// identity so repeated aliases are not collapsed before duplicate checking.
impl Clone for DuplicateDetectingYaml {
    fn clone(&self) -> Self {
        Self::new(self.value.clone())
    }
}

impl PartialEq for DuplicateDetectingYaml {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.identity, &other.identity)
    }
}

impl Eq for DuplicateDetectingYaml {}

impl Hash for DuplicateDetectingYaml {
    fn hash<H: Hasher>(&self, state: &mut H) {
        Rc::as_ptr(&self.identity).hash(state);
    }
}

impl<'input> LoadableYamlNode<'input> for DuplicateDetectingYaml {
    type HashKey = Self;

    fn from_bare_yaml(value: SaphyrYaml<'input>) -> Self {
        let value = match value {
            SaphyrYaml::Representation(value, _, _) => DuplicateValue::String(value.into_owned()),
            SaphyrYaml::Value(Scalar::String(value)) => DuplicateValue::String(value.into_owned()),
            SaphyrYaml::Value(_) => DuplicateValue::Other,
            SaphyrYaml::Sequence(_) => DuplicateValue::Sequence(Vec::new()),
            SaphyrYaml::Mapping(_) => DuplicateValue::Mapping(LinkedHashMap::new()),
            SaphyrYaml::Tagged(_, value) => {
                DuplicateValue::Tagged(Box::new(Self::from_bare_yaml(*value)))
            }
            SaphyrYaml::Alias(_) => DuplicateValue::Other,
            SaphyrYaml::BadValue => DuplicateValue::BadValue,
        };
        Self::new(value)
    }

    fn is_sequence(&self) -> bool {
        match &self.value {
            DuplicateValue::Sequence(_) => true,
            DuplicateValue::Tagged(value) => value.is_sequence(),
            _ => false,
        }
    }

    fn is_mapping(&self) -> bool {
        match &self.value {
            DuplicateValue::Mapping(_) => true,
            DuplicateValue::Tagged(value) => value.is_mapping(),
            _ => false,
        }
    }

    fn is_badvalue(&self) -> bool {
        matches!(self.value, DuplicateValue::BadValue)
    }

    fn sequence_mut(&mut self) -> &mut Vec<Self> {
        match &mut self.value {
            DuplicateValue::Sequence(values) => values,
            DuplicateValue::Tagged(value) => value.sequence_mut(),
            _ => panic!("Called sequence_mut on a non-array"),
        }
    }

    fn mapping_mut(&mut self) -> &mut LinkedHashMap<Self::HashKey, Self> {
        match &mut self.value {
            DuplicateValue::Mapping(entries) => entries,
            DuplicateValue::Tagged(value) => value.mapping_mut(),
            _ => panic!("Called mapping_mut on a non-hash"),
        }
    }

    fn into_tagged(self, _: Cow<'input, Tag>) -> Self {
        Self::new(DuplicateValue::Tagged(Box::new(self)))
    }

    fn take(&mut self) -> Self {
        std::mem::replace(self, Self::new(DuplicateValue::BadValue))
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
