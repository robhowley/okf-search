use comrak::nodes::NodeValue;
use comrak::{Arena, Options, parse_document};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BlockKind {
    Heading { depth: u8, text: String },
    Content,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RootBlock {
    pub kind: BlockKind,
    pub start_line: usize,
    pub end_line: usize,
    pub source: String,
}

pub(crate) struct BorrowedRootBlock<'a> {
    pub(crate) kind: BlockKind,
    pub(crate) start_line: usize,
    pub(crate) end_line: usize,
    pub(crate) source: &'a str,
}

/// Project the root blocks consumed by OKF preparation.
#[must_use]
pub fn project(source: &str) -> Vec<RootBlock> {
    let lines = line_ranges(source);
    project_borrowed(source, &lines)
        .into_iter()
        .map(|block| RootBlock {
            kind: block.kind,
            start_line: block.start_line,
            end_line: block.end_line,
            source: block.source.to_owned(),
        })
        .collect()
}

pub(crate) fn project_borrowed<'a>(
    source: &'a str,
    lines: &[(usize, usize)],
) -> Vec<BorrowedRootBlock<'a>> {
    let arena = Arena::new();
    let root = parse_document(&arena, source, &Options::default());

    root.children()
        .map(|node| {
            let sourcepos = node.data().sourcepos;
            let depth = match &node.data().value {
                NodeValue::Heading(heading) => Some(heading.level),
                _ => None,
            };
            let kind = depth.map_or(BlockKind::Content, |depth| BlockKind::Heading {
                depth,
                text: node.collect_text(),
            });

            BorrowedRootBlock {
                kind,
                start_line: sourcepos.start.line,
                end_line: sourcepos.end.line,
                source: slice_lines(lines, sourcepos.start.line, sourcepos.end.line, source),
            }
        })
        .collect()
}

pub(crate) fn line_ranges(source: &str) -> Vec<(usize, usize)> {
    let bytes = source.as_bytes();
    let mut ranges = Vec::new();
    let mut start = 0;
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'\n' => {
                ranges.push((start, index));
                index += 1;
                start = index;
            }
            b'\r' => {
                ranges.push((start, index));
                index += 1;
                if bytes.get(index) == Some(&b'\n') {
                    index += 1;
                }
                start = index;
            }
            _ => index += 1,
        }
    }
    ranges.push((start, source.len()));
    ranges
}

pub(crate) fn slice_lines<'a>(
    lines: &[(usize, usize)],
    start_line: usize,
    end_line: usize,
    source: &'a str,
) -> &'a str {
    let Some(&(start, _)) = start_line.checked_sub(1).and_then(|line| lines.get(line)) else {
        return "";
    };
    let Some(&(_, end)) = end_line.checked_sub(1).and_then(|line| lines.get(line)) else {
        return "";
    };
    &source[start..end]
}

#[cfg(test)]
mod tests {
    use super::{line_ranges, slice_lines};

    #[test]
    fn shared_line_ranges_preserve_empty_and_terminal_lines() {
        for (source, expected) in [
            ("", vec![(0, 0)]),
            ("a", vec![(0, 1)]),
            ("a\n", vec![(0, 1), (2, 2)]),
            ("a\r", vec![(0, 1), (2, 2)]),
            ("a\r\n", vec![(0, 1), (3, 3)]),
            ("a\r\nb\rc\n", vec![(0, 1), (3, 4), (5, 6), (7, 7)]),
            ("a\n\n", vec![(0, 1), (2, 2), (3, 3)]),
            ("\n\n", vec![(0, 0), (1, 1), (2, 2)]),
        ] {
            assert_eq!(line_ranges(source), expected, "source: {source:?}");
            for (line, &(start, end)) in expected.iter().enumerate() {
                assert_eq!(
                    slice_lines(&expected, line + 1, line + 1, source),
                    &source[start..end],
                    "source: {source:?}, line: {}",
                    line + 1
                );
            }
            assert_eq!(slice_lines(&expected, 0, 1, source), "");
            assert_eq!(slice_lines(&expected, 1, expected.len() + 1, source), "");
        }
    }
}
