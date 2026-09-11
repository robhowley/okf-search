use time::{Date, Month, PrimitiveDateTime, Time, UtcOffset};

use crate::error::{Diagnostic, PrepareError};
use crate::yaml::{YamlOwned, YamlValue};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Draft,
    Stable,
    Deprecated,
}

impl Status {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Stable => "stable",
            Self::Deprecated => "deprecated",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrustTier {
    Unverified,
    MachineConfirmed,
    HumanReviewed,
}

impl TrustTier {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unverified => "unverified",
            Self::MachineConfirmed => "machine-confirmed",
            Self::HumanReviewed => "human-reviewed",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimeWindow {
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Generation {
    pub by: String,
    pub at: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Verification {
    pub by: String,
    pub at: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub resource: String,
    pub id: Option<String>,
    pub title: Option<String>,
    pub author: Option<String>,
    pub usage_count: Option<f64>,
    pub last_modified: Option<String>,
    pub usage_window: Option<TimeWindow>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Parameter {
    pub name: String,
    pub type_: String,
    pub required: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Executor {
    pub resource: String,
    pub receipt: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Attester {
    pub resource: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StaleAfter {
    pub value: String,
    pub epoch_millis: i64,
}

impl StaleAfter {
    #[must_use]
    pub fn timestamp(&self) -> &str {
        &self.value
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Staleness {
    pub classified: bool,
    pub stale_after: Option<StaleAfter>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProjectedFields {
    pub type_: String,
    pub title: String,
    pub description: Option<String>,
    pub resource: Option<String>,
    pub tags: Vec<String>,
    pub sources: Vec<Source>,
    pub source_text: String,
    pub usage_window: Option<TimeWindow>,
    pub generated: Option<Generation>,
    pub verified: Vec<Verification>,
    pub trust_tier: Option<TrustTier>,
    pub status: Option<Status>,
    pub stale_after: Option<StaleAfter>,
    pub staleness: Staleness,
    pub runtime: Option<String>,
    pub parameters: Option<Vec<Parameter>>,
    pub computation: Option<String>,
    pub executor: Option<Executor>,
    pub attester: Option<Attester>,
}

pub(crate) fn project(
    yaml: &YamlValue,
    path: &str,
    fallback_title: &str,
) -> (ProjectedFields, bool, Vec<Diagnostic>) {
    let data = yaml
        .as_mapping()
        .expect("frontmatter projection requires a mapping root");
    let mut diagnostics = Vec::new();

    let type_ = match field(data, "type").and_then(YamlOwned::as_str) {
        Some(value) if !value.trim().is_empty() => Some(value.to_owned()),
        _ => {
            invalid(&mut diagnostics, path, "type");
            None
        }
    };

    let title = match field(data, "title") {
        None => fallback_title.to_owned(),
        Some(value) => match value.as_str() {
            Some(value) => value.to_owned(),
            None => {
                invalid(&mut diagnostics, path, "title");
                String::new()
            }
        },
    };
    let description = string_field(data, "description", path, &mut diagnostics);
    let resource = string_field(data, "resource", path, &mut diagnostics);
    let tags = string_array(data, "tags", path, &mut diagnostics);
    let (sources, source_text) = project_sources(data, path, &mut diagnostics);
    let usage_window = optional_time_window(data, "usage_window", path, &mut diagnostics);
    let generated = project_generated(data, path, &mut diagnostics);
    let (verified, trust_tier) = project_verified(data, path, &mut diagnostics);

    let status = match field(data, "status") {
        None => Some(Status::Stable),
        Some(value) => match value.as_str() {
            Some("draft") => Some(Status::Draft),
            Some("stable") => Some(Status::Stable),
            Some("deprecated") => Some(Status::Deprecated),
            _ => {
                invalid(&mut diagnostics, path, "status");
                None
            }
        },
    };

    let (stale_after, staleness) = match field(data, "stale_after") {
        None => (
            None,
            Staleness {
                classified: true,
                stale_after: None,
            },
        ),
        Some(value) => match timestamp(value) {
            Some((value, epoch_millis)) => {
                let stale_after = StaleAfter {
                    value,
                    epoch_millis,
                };
                (
                    Some(stale_after.clone()),
                    Staleness {
                        classified: true,
                        stale_after: Some(stale_after),
                    },
                )
            }
            None => {
                invalid(&mut diagnostics, path, "stale_after");
                (
                    None,
                    Staleness {
                        classified: false,
                        stale_after: None,
                    },
                )
            }
        },
    };

    let runtime = string_field(data, "runtime", path, &mut diagnostics);
    if type_.as_deref() == Some("Attested Computation") && field(data, "runtime").is_none() {
        invalid(&mut diagnostics, path, "runtime");
    }
    let parameters = project_parameters(data, path, &mut diagnostics);
    let computation = string_field(data, "computation", path, &mut diagnostics);
    let executor = project_executor(data, path, &mut diagnostics);
    let attester = project_attester(data, path, &mut diagnostics);

    let fields = ProjectedFields {
        type_: type_.clone().unwrap_or_default(),
        title,
        description,
        resource,
        tags,
        sources,
        source_text,
        usage_window,
        generated,
        verified,
        trust_tier,
        status,
        stale_after,
        staleness,
        runtime,
        parameters,
        computation,
        executor,
        attester,
    };

    (fields, type_.is_some(), diagnostics)
}

fn string_field(
    data: &[(String, YamlOwned)],
    key: &str,
    path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<String> {
    let value = field(data, key)?;
    match value.as_str() {
        Some(value) => Some(value.to_owned()),
        None => {
            invalid(diagnostics, path, key);
            None
        }
    }
}

fn string_array(
    data: &[(String, YamlOwned)],
    key: &str,
    path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Vec<String> {
    let Some(value) = field(data, key) else {
        return Vec::new();
    };
    let Some(values) = value.as_sequence() else {
        invalid(diagnostics, path, key);
        return Vec::new();
    };

    values
        .iter()
        .enumerate()
        .filter_map(|(index, value)| match value.as_str() {
            Some(value) => Some(value.to_owned()),
            None => {
                invalid(diagnostics, path, format!("{key}[{index}]"));
                None
            }
        })
        .collect()
}

fn project_sources(
    data: &[(String, YamlOwned)],
    path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> (Vec<Source>, String) {
    let Some(value) = field(data, "sources") else {
        return (Vec::new(), String::new());
    };
    let Some(values) = value.as_sequence() else {
        invalid(diagnostics, path, "sources");
        return (Vec::new(), String::new());
    };

    let mut sources = Vec::new();
    let mut lexical = Vec::new();
    for (index, value) in values.iter().enumerate() {
        let base = format!("sources[{index}]");
        let Some(data) = value.as_mapping() else {
            invalid(diagnostics, path, &base);
            continue;
        };

        let resource = required_string(data, "resource", &base, path, diagnostics);
        let id = optional_string(data, "id", &base, path, diagnostics);
        let title = optional_string(data, "title", &base, path, diagnostics);
        let author = optional_actor(data, "author", &base, path, diagnostics);
        for part in [&id, &title, &author, &resource] {
            if let Some(part) = part.as_deref().filter(|part| !part.is_empty()) {
                lexical.push(part.to_owned());
            }
        }

        let mut valid = resource.is_some();
        if field(data, "id").is_some() && id.is_none()
            || field(data, "title").is_some() && title.is_none()
            || field(data, "author").is_some() && author.is_none()
        {
            valid = false;
        }
        let usage_count = if let Some(value) = field(data, "usage_count") {
            match value.as_number() {
                Some(value) => Some(value),
                None => {
                    invalid(diagnostics, path, format!("{base}.usage_count"));
                    valid = false;
                    None
                }
            }
        } else {
            None
        };

        let last_modified = if let Some(value) = field(data, "last_modified") {
            match timestamp(value) {
                Some((value, _)) => Some(value),
                None => {
                    invalid(diagnostics, path, format!("{base}.last_modified"));
                    valid = false;
                    None
                }
            }
        } else {
            None
        };

        let usage_window =
            optional_nested_time_window(data, "usage_window", &base, path, diagnostics);
        if field(data, "usage_window").is_some() && usage_window.is_none() {
            valid = false;
        }

        if valid {
            sources.push(Source {
                resource: resource.expect("valid source has a resource"),
                id,
                title,
                author,
                usage_count,
                last_modified,
                usage_window,
            });
        }
    }

    (sources, lexical.join(" "))
}

fn required_string(
    data: &[(String, YamlOwned)],
    key: &str,
    base: &str,
    path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<String> {
    let Some(value) = field(data, key) else {
        invalid(diagnostics, path, format!("{base}.{key}"));
        return None;
    };
    match value.as_str() {
        Some(value) => Some(value.to_owned()),
        None => {
            invalid(diagnostics, path, format!("{base}.{key}"));
            None
        }
    }
}

fn optional_string(
    data: &[(String, YamlOwned)],
    key: &str,
    base: &str,
    path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<String> {
    let value = field(data, key)?;
    match value.as_str() {
        Some(value) => Some(value.to_owned()),
        None => {
            invalid(diagnostics, path, format!("{base}.{key}"));
            None
        }
    }
}

fn optional_actor(
    data: &[(String, YamlOwned)],
    key: &str,
    base: &str,
    path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<String> {
    let value = field(data, key)?;
    match value.as_str().filter(|value| valid_actor(value)) {
        Some(value) => Some(value.to_owned()),
        None => {
            invalid(diagnostics, path, format!("{base}.{key}"));
            None
        }
    }
}

fn optional_time_window(
    data: &[(String, YamlOwned)],
    key: &str,
    path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<TimeWindow> {
    let value = field(data, key)?;
    project_time_window(value, key, path, diagnostics)
}

fn optional_nested_time_window(
    data: &[(String, YamlOwned)],
    key: &str,
    base: &str,
    path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<TimeWindow> {
    let value = field(data, key)?;
    project_time_window(value, &format!("{base}.{key}"), path, diagnostics)
}

fn project_time_window(
    value: &YamlOwned,
    base: &str,
    path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<TimeWindow> {
    let Some(data) = value.as_mapping() else {
        invalid(diagnostics, path, base);
        return None;
    };
    let from = field(data, "from")
        .and_then(timestamp)
        .map(|(value, _)| value);
    let to = field(data, "to")
        .and_then(timestamp)
        .map(|(value, _)| value);
    if from.is_none() {
        invalid(diagnostics, path, format!("{base}.from"));
    }
    if to.is_none() {
        invalid(diagnostics, path, format!("{base}.to"));
    }
    Some(TimeWindow {
        from: from?,
        to: to?,
    })
}

fn project_generated(
    data: &[(String, YamlOwned)],
    path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<Generation> {
    let value = field(data, "generated")?;
    let Some(data) = value.as_mapping() else {
        invalid(diagnostics, path, "generated");
        return None;
    };
    let by = field(data, "by")
        .and_then(YamlOwned::as_str)
        .filter(|value| valid_actor(value))
        .map(str::to_owned);
    if by.is_none() {
        invalid(diagnostics, path, "generated.by");
    }

    let at = if let Some(value) = field(data, "at") {
        match timestamp(value) {
            Some((value, _)) => Some(value),
            None => {
                invalid(diagnostics, path, "generated.at");
                None
            }
        }
    } else {
        None
    };
    let by = by?;
    if field(data, "at").is_some() && at.is_none() {
        return None;
    }
    Some(Generation { by, at })
}

fn project_verified(
    data: &[(String, YamlOwned)],
    path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> (Vec<Verification>, Option<TrustTier>) {
    let Some(value) = field(data, "verified") else {
        return (Vec::new(), Some(TrustTier::Unverified));
    };

    let values: Vec<&YamlOwned> = if let Some(values) = value.as_sequence() {
        values.iter().collect()
    } else if value.as_mapping().is_some() {
        vec![value]
    } else {
        invalid(diagnostics, path, "verified");
        return (Vec::new(), None);
    };

    let mut verified = Vec::new();
    for (index, value) in values.iter().enumerate() {
        let base = format!("verified[{index}]");
        let Some(data) = value.as_mapping() else {
            invalid(diagnostics, path, &base);
            continue;
        };
        let by = field(data, "by")
            .and_then(YamlOwned::as_str)
            .filter(|value| valid_actor(value))
            .map(str::to_owned);
        let at = field(data, "at")
            .and_then(timestamp)
            .map(|(value, _)| value);
        if by.is_none() {
            invalid(diagnostics, path, format!("{base}.by"));
        }
        if at.is_none() {
            invalid(diagnostics, path, format!("{base}.at"));
        }
        if let (Some(by), Some(at)) = (by, at) {
            verified.push(Verification { by, at });
        }
    }

    let trust_tier = if verified.iter().any(|event| event.by.starts_with("human:")) {
        Some(TrustTier::HumanReviewed)
    } else if !verified.is_empty() {
        Some(TrustTier::MachineConfirmed)
    } else if values.is_empty() {
        Some(TrustTier::Unverified)
    } else {
        None
    };
    (verified, trust_tier)
}

fn project_parameters(
    data: &[(String, YamlOwned)],
    path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<Vec<Parameter>> {
    let value = field(data, "parameters")?;
    let Some(values) = value.as_sequence() else {
        invalid(diagnostics, path, "parameters");
        return None;
    };

    let mut parameters = Vec::new();
    for (index, value) in values.iter().enumerate() {
        let base = format!("parameters[{index}]");
        let Some(data) = value.as_mapping() else {
            invalid(diagnostics, path, &base);
            continue;
        };
        let name = field(data, "name")
            .and_then(YamlOwned::as_str)
            .map(str::to_owned);
        let type_ = field(data, "type")
            .and_then(YamlOwned::as_str)
            .map(str::to_owned);
        let required = field(data, "required").and_then(YamlOwned::as_bool);
        if name.is_none() {
            invalid(diagnostics, path, format!("{base}.name"));
        }
        if type_.is_none() {
            invalid(diagnostics, path, format!("{base}.type"));
        }
        if required.is_none() {
            invalid(diagnostics, path, format!("{base}.required"));
        }
        if let (Some(name), Some(type_), Some(required)) = (name, type_, required) {
            parameters.push(Parameter {
                name,
                type_,
                required,
            });
        }
    }
    Some(parameters)
}

fn project_executor(
    data: &[(String, YamlOwned)],
    path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<Executor> {
    let value = field(data, "executor")?;
    let Some(data) = value.as_mapping() else {
        invalid(diagnostics, path, "executor");
        return None;
    };
    let resource = field(data, "resource")
        .and_then(YamlOwned::as_str)
        .map(str::to_owned);
    if resource.is_none() {
        invalid(diagnostics, path, "executor.resource");
    }

    let receipt = field(data, "receipt")
        .and_then(|value| value.as_sequence())
        .map(|values| {
            let mut receipt = Vec::new();
            for (index, value) in values.iter().enumerate() {
                match value.as_str() {
                    Some(value) => receipt.push(value.to_owned()),
                    None => invalid(diagnostics, path, format!("executor.receipt[{index}]")),
                }
            }
            (receipt, values.len())
        });
    let receipt = match receipt {
        Some((receipt, count)) if receipt.len() == count => Some(receipt),
        Some(_) => None,
        None => {
            invalid(diagnostics, path, "executor.receipt");
            None
        }
    };

    match (resource, receipt) {
        (Some(resource), Some(receipt)) => Some(Executor { resource, receipt }),
        _ => None,
    }
}

fn project_attester(
    data: &[(String, YamlOwned)],
    path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<Attester> {
    let value = field(data, "attester")?;
    let Some(data) = value.as_mapping() else {
        invalid(diagnostics, path, "attester");
        return None;
    };
    match field(data, "resource").and_then(YamlOwned::as_str) {
        Some(resource) => Some(Attester {
            resource: resource.to_owned(),
        }),
        None => {
            invalid(diagnostics, path, "attester.resource");
            None
        }
    }
}

fn field<'a>(data: &'a [(String, YamlOwned)], key: &str) -> Option<&'a YamlOwned> {
    data.iter()
        .find(|(candidate, _)| candidate == key)
        .map(|(_, value)| value)
}

fn invalid(diagnostics: &mut Vec<Diagnostic>, path: &str, field: impl Into<String>) {
    diagnostics.push(PrepareError::invalid_field(path, field));
}

/// Return whether a string uses one of the OKF actor forms.
pub fn valid_actor(value: &str) -> bool {
    ["human:", "process:"]
        .iter()
        .any(|prefix| actor_suffix(value, prefix))
        || value.matches('/').count() == 1
            && value
                .split_once('/')
                .is_some_and(|(left, right)| actor_part(left) && actor_part(right))
}

fn actor_suffix(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(actor_part)
}

fn actor_part(value: &str) -> bool {
    !value.is_empty() && !value.chars().any(is_actor_whitespace)
}

fn is_actor_whitespace(value: char) -> bool {
    value.is_whitespace() || value == '\u{feff}'
}

/// Parse an OKF timestamp into integer Unix epoch milliseconds.
pub fn parse_timestamp(value: &str) -> Option<i64> {
    timestamp_parts(value).and_then(|parts| {
        let month = Month::try_from(parts.month as u8).ok()?;
        let date = Date::from_calendar_date(parts.year, month, parts.day as u8).ok()?;
        let time = Time::from_hms(parts.hour as u8, parts.minute as u8, parts.second as u8).ok()?;
        let offset = UtcOffset::from_hms(parts.offset_hour, parts.offset_minute, 0).ok()?;
        let seconds = PrimitiveDateTime::new(date, time)
            .assume_offset(offset)
            .unix_timestamp();
        seconds
            .checked_mul(1_000)?
            .checked_add(i64::from(parts.millisecond))?
            .checked_add(i64::from(parts.rounds_up))
    })
}

/// Return whether a string is a valid OKF timestamp.
pub fn valid_timestamp(value: &str) -> bool {
    parse_timestamp(value).is_some()
}

fn timestamp(value: &YamlOwned) -> Option<(String, i64)> {
    let value = value.as_str()?;
    Some((value.to_owned(), parse_timestamp(value)?))
}

struct TimestampParts {
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    millisecond: u16,
    rounds_up: u8,
    offset_hour: i8,
    offset_minute: i8,
}

fn timestamp_parts(value: &str) -> Option<TimestampParts> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }

    let year = digits(bytes.get(0..4)?)? as i32;
    let month = digits(bytes.get(5..7)?)?;
    let day = digits(bytes.get(8..10)?)?;
    let hour = digits(bytes.get(11..13)?)?;
    let minute = digits(bytes.get(14..16)?)?;
    let second = digits(bytes.get(17..19)?)?;

    let mut timezone = 19;
    let mut millisecond = 0;
    let mut rounds_up = 0;
    if bytes.get(19) == Some(&b'.') {
        timezone = 20;
        while bytes.get(timezone).is_some_and(u8::is_ascii_digit) {
            timezone += 1;
        }
        if timezone == 20 {
            return None;
        }
        let fraction = &bytes[20..timezone];
        for digit in fraction.iter().take(3) {
            millisecond = millisecond * 10 + u16::from(digit - b'0');
        }
        for _ in fraction.len()..3 {
            millisecond *= 10;
        }
        if fraction.len() > 3 && fraction[3..].iter().any(|digit| *digit != b'0') {
            rounds_up = 1;
        }
    }

    let (offset_hour, offset_minute) = match bytes.get(timezone) {
        Some(b'Z') if timezone + 1 == bytes.len() => (0, 0),
        Some(sign @ (b'+' | b'-'))
            if timezone + 6 == bytes.len() && bytes.get(timezone + 3) == Some(&b':') =>
        {
            let hours = digits(bytes.get(timezone + 1..timezone + 3)?)?;
            let minutes = digits(bytes.get(timezone + 4..timezone + 6)?)?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            let sign = if *sign == b'+' { 1 } else { -1 };
            (sign * hours as i8, sign * minutes as i8)
        }
        _ => return None,
    };

    if month == 0 || month > 12 || day == 0 || hour > 23 || minute > 59 || second > 59 {
        return None;
    }

    Some(TimestampParts {
        year,
        month,
        day,
        hour,
        minute,
        second,
        millisecond,
        rounds_up,
        offset_hour,
        offset_minute,
    })
}

fn digits(value: &[u8]) -> Option<u32> {
    if value.is_empty() || !value.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(
        value
            .iter()
            .fold(0, |result, digit| result * 10 + u32::from(digit - b'0')),
    )
}
