use crate::error::{Diagnostic, PrepareError};
use crate::yaml::{YamlOwned, YamlValue};

#[derive(Clone, Debug, PartialEq)]
pub struct Frontmatter {
    pub yaml: YamlValue,
    pub body: String,
    pub body_start_line: usize,
}

/// Extract and parse the one frontmatter envelope owned by the domain core.
pub fn parse(markdown: &str, path: &str) -> Result<Frontmatter, Diagnostic> {
    let opening = if markdown.starts_with("---\r\n") {
        5
    } else if markdown.starts_with("---\n") {
        4
    } else {
        return Err(PrepareError::parse(path));
    };

    let remainder = &markdown[opening..];
    let Some((yaml_end, envelope_end)) = closing_delimiter(remainder) else {
        return Err(PrepareError::parse(path));
    };

    let yaml =
        YamlOwned::load_from_str(&remainder[..yaml_end]).map_err(|_| PrepareError::parse(path))?;
    if yaml.as_mapping().is_none() {
        return Err(PrepareError::parse(path));
    }

    let body_start = opening + envelope_end;
    let body_start_line = markdown[..body_start]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
        + 1;

    Ok(Frontmatter {
        yaml,
        body: remainder[envelope_end..].to_owned(),
        body_start_line,
    })
}

fn closing_delimiter(source: &str) -> Option<(usize, usize)> {
    let bytes = source.as_bytes();
    let mut line_start = 0;

    loop {
        let line_end = bytes[line_start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |offset| line_start + offset);
        let content_end = if line_end > line_start && bytes[line_end - 1] == b'\r' {
            line_end - 1
        } else {
            line_end
        };

        if &source[line_start..content_end] == "---" {
            let yaml_end = if line_start == 0 {
                0
            } else if line_start >= 2 && bytes[line_start - 2] == b'\r' {
                line_start - 2
            } else {
                line_start - 1
            };
            let envelope_end = if line_end < bytes.len() {
                line_end + 1
            } else {
                line_end
            };
            return Some((yaml_end, envelope_end));
        }

        if line_end == bytes.len() {
            return None;
        }
        line_start = line_end + 1;
    }
}
