#![deny(clippy::all)]

#[cfg(test)]
mod filesystem;
#[cfg(test)]
mod preparation;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::ops::Bound;

use chrono::{DateTime, Utc};
use napi::bindgen_prelude::{
    Either, FromNapiValue, JsObjectValue, JsValue, KeyCollectionMode, KeyConversion, KeyFilter,
    Object, Unknown, ValueType,
};
use napi::{Error, Result as NapiResult, Status};
use napi_derive::napi;
use parking_lot::Mutex;
use tantivy::collector::{Count, TopDocs};
use tantivy::directory::RamDirectory;
use tantivy::query::{
    BooleanQuery, BoostQuery, ConstScoreQuery, DisjunctionMaxQuery, EnableScoring,
    FastFieldRangeQuery, FuzzyTermQuery, Occur, Query, TermQuery, TermSetQuery,
};
use tantivy::schema::{
    FAST, Field, INDEXED, IndexRecordOption, STORED, STRING, Schema, TantivyDocument,
    TextFieldIndexing, TextOptions, Value,
};
use tantivy::tokenizer::{LowerCaser, SimpleTokenizer, TextAnalyzer, TokenStream};
use tantivy::{
    DocAddress, DocSet, Index, IndexReader, IndexSettings, IndexWriter, ReloadPolicy, Score, Term,
};
use thiserror::Error as ThisError;

const TOKENIZER: &str = "okf";
const WRITER_HEAP_BYTES: usize = 15_000_000;
const FETCH_FLOOR: usize = 32;
const MAX_SAFE_INTEGER: u128 = 9_007_199_254_740_991;

#[napi(object)]
#[derive(Clone, Debug)]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
    pub field: Option<String>,
    pub path: String,
}

/// Search-independent output from the existing OKF parser/projector.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PreparedSection {
    #[napi(js_name = "sectionId")]
    pub section_id: String,
    #[napi(js_name = "headingPath")]
    pub heading_path: String,
    pub text: String,
    #[napi(js_name = "startLine")]
    pub start_line: f64,
    #[napi(js_name = "endLine")]
    pub end_line: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct PreparedDocument {
    #[napi(js_name = "documentId")]
    pub document_id: String,
    pub path: String,
    #[napi(js_name = "type")]
    pub document_type: String,
    pub conformance: String,
    pub diagnostics: Vec<Diagnostic>,
    pub title: String,
    pub tags: Vec<String>,
    pub status: Option<String>,
    #[napi(js_name = "staleAfterEpoch")]
    pub stale_after_epoch: Option<f64>,
    #[napi(js_name = "stalenessClassified")]
    pub staleness_classified: bool,
    #[napi(js_name = "trustTier")]
    pub trust_tier: Option<String>,
    pub resource: String,
    pub description: String,
    #[napi(js_name = "sourceText")]
    pub source_text: String,
    pub sections: Vec<PreparedSection>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct SearchWhere {
    pub types: Option<Vec<String>>,
    #[napi(js_name = "tagsAny")]
    pub tags_any: Option<Vec<String>>,
    pub statuses: Option<Vec<String>>,
    #[napi(js_name = "trustTiers")]
    pub trust_tiers: Option<Vec<String>>,
    pub stale: Option<bool>,
    pub conformance: Option<Vec<String>>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct SearchBoost {
    pub resource: Option<f64>,
    pub title: Option<f64>,
    pub heading: Option<f64>,
    pub description: Option<f64>,
    pub tags: Option<f64>,
    #[napi(js_name = "type")]
    pub document_type: Option<f64>,
    pub sources: Option<f64>,
    pub body: Option<f64>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct SearchOptions {
    pub limit: Option<f64>,
    #[napi(js_name = "where")]
    pub where_filter: Option<SearchWhere>,
    #[napi(js_name = "asOf")]
    pub as_of: Option<DateTime<Utc>>,
    #[napi(js_name = "match")]
    pub match_mode: Option<String>,
    pub fields: Option<Vec<String>>,
    pub boost: Option<SearchBoost>,
    pub fuzzy: Option<Either<bool, f64>>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct SearchHit {
    #[napi(js_name = "documentId")]
    pub document_id: String,
    pub title: String,
    #[napi(js_name = "sectionId")]
    pub section_id: String,
    pub score: f64,
    pub conformance: String,
    #[napi(js_name = "matchedFields")]
    pub matched_fields: Vec<String>,
    #[napi(js_name = "headingPath")]
    pub heading_path: String,
    pub path: String,
    #[napi(js_name = "startLine")]
    pub start_line: u32,
    #[napi(js_name = "endLine")]
    pub end_line: u32,
    pub snippet: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct DegradedDocument {
    #[napi(js_name = "documentId")]
    pub document_id: String,
    pub path: String,
    pub diagnostics: Vec<Diagnostic>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct Suggestion {
    pub suggestion: String,
    pub terms: Vec<String>,
    pub score: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct IndexDocumentStats {
    pub total: f64,
    pub strict: f64,
    pub degraded: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct IndexTypeStats {
    #[napi(js_name = "type")]
    pub document_type: String,
    #[napi(js_name = "documentCount")]
    pub document_count: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct IndexStatusStats {
    pub draft: f64,
    pub stable: f64,
    pub deprecated: f64,
    pub unclassified: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct IndexTrustTierStats {
    pub unverified: f64,
    #[napi(js_name = "machineConfirmed")]
    pub machine_confirmed: f64,
    #[napi(js_name = "humanReviewed")]
    pub human_reviewed: f64,
    pub unclassified: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct LogicalIndexStats {
    pub documents: IndexDocumentStats,
    pub types: Vec<IndexTypeStats>,
    pub statuses: IndexStatusStats,
    #[napi(js_name = "trustTiers")]
    pub trust_tiers: IndexTrustTierStats,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct IndexStorageStats {
    #[napi(ts_type = "\"in-memory-index-files\"")]
    pub kind: String,
    #[napi(js_name = "sizeInBytes")]
    pub size_in_bytes: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct IndexStats {
    pub logical: LogicalIndexStats,
    pub storage: IndexStorageStats,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum SearchField {
    Resource,
    Title,
    Heading,
    Description,
    Tags,
    Type,
    Sources,
    Body,
}

impl SearchField {
    const ALL: [Self; 8] = [
        Self::Resource,
        Self::Title,
        Self::Heading,
        Self::Description,
        Self::Tags,
        Self::Type,
        Self::Sources,
        Self::Body,
    ];

    fn parse(value: &str) -> Option<Self> {
        match value {
            "resource" => Some(Self::Resource),
            "title" => Some(Self::Title),
            "heading" => Some(Self::Heading),
            "description" => Some(Self::Description),
            "tags" => Some(Self::Tags),
            "type" => Some(Self::Type),
            "sources" => Some(Self::Sources),
            "body" => Some(Self::Body),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Resource => "resource",
            Self::Title => "title",
            Self::Heading => "heading",
            Self::Description => "description",
            Self::Tags => "tags",
            Self::Type => "type",
            Self::Sources => "sources",
            Self::Body => "body",
        }
    }

    fn baseline_boost(self) -> f32 {
        match self {
            Self::Resource => 6.0,
            Self::Title => 5.0,
            Self::Heading => 4.0,
            Self::Description => 3.0,
            Self::Tags => 2.0,
            Self::Type => 1.5,
            Self::Sources | Self::Body => 1.0,
        }
    }
}

#[derive(Clone)]
struct Fields {
    section_id: Field,
    document_id: Field,
    conformance: Field,
    title: Field,
    path: Field,
    type_text: Field,
    type_exact: Field,
    tags_text: Field,
    tag_exact: Field,
    status: Field,
    stale_after_epoch: Field,
    staleness_classified: Field,
    trust_tier: Field,
    resource: Field,
    heading: Field,
    description: Field,
    sources: Field,
    body: Field,
    start_line: Field,
    end_line: Field,
}

impl Fields {
    fn searchable(&self, field: SearchField) -> Field {
        match field {
            SearchField::Resource => self.resource,
            SearchField::Title => self.title,
            SearchField::Heading => self.heading,
            SearchField::Description => self.description,
            SearchField::Tags => self.tags_text,
            SearchField::Type => self.type_text,
            SearchField::Sources => self.sources,
            SearchField::Body => self.body,
        }
    }
}

fn analyzer() -> TextAnalyzer {
    TextAnalyzer::builder(SimpleTokenizer::default())
        .filter(LowerCaser)
        .build()
}

fn schema() -> (Schema, Fields) {
    let mut builder = Schema::builder();
    let indexed = TextOptions::default()
        .set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer(TOKENIZER)
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        )
        .set_stored();

    let section_id = builder.add_text_field("section_id", STRING | STORED);
    let document_id = builder.add_text_field("document_id", STRING | STORED);
    let conformance = builder.add_text_field("conformance", STRING | STORED);
    let title = builder.add_text_field("title", indexed.clone());
    let path = builder.add_text_field("path", STORED);
    let type_text = builder.add_text_field("type_text", indexed.clone());
    // Filter-only metadata is indexed but deliberately not stored. Search must
    // express these constraints inside Tantivy instead of reading every top hit
    // back from the document store and filtering in Rust.
    let type_exact = builder.add_text_field("type_exact", STRING);
    let tags_text = builder.add_text_field("tags_text", indexed.clone());
    let tag_exact = builder.add_text_field("tag_exact", STRING);
    let status = builder.add_text_field("status", STRING);
    // Epoch values have high cardinality. A fast field avoids expanding every
    // timestamp term up to `asOf` through the inverted index.
    let stale_after_epoch = builder.add_i64_field("stale_after_epoch", FAST);
    let staleness_classified = builder.add_u64_field("staleness_classified", INDEXED);
    let trust_tier = builder.add_text_field("trust_tier", STRING);
    let resource = builder.add_text_field("resource", indexed.clone());
    let heading = builder.add_text_field("heading", indexed.clone());
    let description = builder.add_text_field("description", indexed.clone());
    let sources = builder.add_text_field("sources", indexed.clone());
    let body = builder.add_text_field("body", indexed);
    let start_line = builder.add_u64_field("start_line", STORED);
    let end_line = builder.add_u64_field("end_line", STORED);

    (
        builder.build(),
        Fields {
            section_id,
            document_id,
            conformance,
            title,
            path,
            type_text,
            type_exact,
            tags_text,
            tag_exact,
            status,
            stale_after_epoch,
            staleness_classified,
            trust_tier,
            resource,
            heading,
            description,
            sources,
            body,
            start_line,
            end_line,
        },
    )
}

#[derive(Clone, Debug, Default)]
struct ResolvedWhere {
    // Deterministic ordering makes the generated term sets stable in tests and
    // query explanations. Filter semantics remain exact and case-sensitive.
    types: Option<BTreeSet<String>>,
    tags_any: Option<BTreeSet<String>>,
    statuses: Option<BTreeSet<String>>,
    trust_tiers: Option<BTreeSet<String>>,
    stale: Option<bool>,
    conformance: Option<BTreeSet<String>>,
}

#[derive(Clone, Debug)]
struct ResolvedOptions {
    limit: usize,
    where_filter: ResolvedWhere,
    as_of_epoch: i64,
    match_all: bool,
    fields: Vec<SearchField>,
    boosts: HashMap<SearchField, f32>,
    fuzzy_ratio: f64,
}

#[derive(Clone, Debug)]
struct QueryPlan {
    terms: Vec<String>,
    options: ResolvedOptions,
}

fn invalid_options(message: impl Into<String>) -> Error {
    Error::new(
        Status::InvalidArg,
        format!("[ERR_OKF_INVALID_SEARCH_OPTIONS] {}", message.into()),
    )
}

fn nonempty_set(values: Option<Vec<String>>) -> Option<BTreeSet<String>> {
    values.and_then(|values| {
        let set: BTreeSet<_> = values.into_iter().collect();
        (!set.is_empty()).then_some(set)
    })
}

fn validate_vocab(
    name: &str,
    values: &Option<BTreeSet<String>>,
    allowed: &[&str],
) -> NapiResult<()> {
    if let Some(values) = values {
        for value in values {
            if !allowed.contains(&value.as_str()) {
                return Err(invalid_options(format!("unknown {name} `{value}`")));
            }
        }
    }
    Ok(())
}

fn resolve_where(value: Option<SearchWhere>) -> NapiResult<ResolvedWhere> {
    let resolved = value.map_or_else(ResolvedWhere::default, |value| ResolvedWhere {
        types: nonempty_set(value.types),
        tags_any: nonempty_set(value.tags_any),
        statuses: nonempty_set(value.statuses),
        trust_tiers: nonempty_set(value.trust_tiers),
        stale: value.stale,
        conformance: nonempty_set(value.conformance),
    });
    validate_vocab(
        "status",
        &resolved.statuses,
        &["draft", "stable", "deprecated"],
    )?;
    validate_vocab(
        "trust tier",
        &resolved.trust_tiers,
        &["unverified", "machine-confirmed", "human-reviewed"],
    )?;
    validate_vocab(
        "conformance",
        &resolved.conformance,
        &["strict", "degraded"],
    )?;
    Ok(resolved)
}

fn boost_value(boost: &Option<SearchBoost>, field: SearchField) -> Option<f64> {
    boost.as_ref().and_then(|boost| match field {
        SearchField::Resource => boost.resource,
        SearchField::Title => boost.title,
        SearchField::Heading => boost.heading,
        SearchField::Description => boost.description,
        SearchField::Tags => boost.tags,
        SearchField::Type => boost.document_type,
        SearchField::Sources => boost.sources,
        SearchField::Body => boost.body,
    })
}

fn validate_option_keys(object: &Object<'_>, location: &str, allowed: &[&str]) -> NapiResult<()> {
    let names = object
        .get_all_property_names(
            KeyCollectionMode::OwnOnly,
            KeyFilter::Enumerable,
            KeyConversion::NumbersToStrings,
        )
        .map_err(|error| invalid_options(format!("could not inspect {location}: {error}")))?;
    let length = names
        .get_array_length()
        .map_err(|error| invalid_options(format!("could not inspect {location}: {error}")))?;
    for index in 0..length {
        let key = names
            .get_element::<String>(index)
            .map_err(|_| invalid_options(format!("unknown {location} symbol key")))?;
        if !allowed.contains(&key.as_str()) {
            return Err(invalid_options(format!("unknown {location} key `{key}`")));
        }
    }
    Ok(())
}

fn validate_nested_option_keys(
    object: &Object<'_>,
    property: &str,
    location: &str,
    allowed: &[&str],
) -> NapiResult<()> {
    let Some(value) = object.get::<Unknown<'_>>(property)? else {
        return Ok(());
    };
    if value.get_type()? != ValueType::Object || value.is_array()? {
        return Err(invalid_options(format!("{location} must be an object")));
    }
    let nested = unsafe { value.cast::<Object<'_>>() }?;
    validate_option_keys(&nested, location, allowed)?;
    Ok(())
}

fn parse_search_options(options: Option<Object<'_>>) -> NapiResult<Option<SearchOptions>> {
    let Some(object) = options else {
        return Ok(None);
    };
    validate_option_keys(
        &object,
        "search option",
        &[
            "limit", "where", "asOf", "match", "fields", "boost", "fuzzy",
        ],
    )?;
    validate_nested_option_keys(
        &object,
        "where",
        "where",
        &[
            "types",
            "tagsAny",
            "statuses",
            "trustTiers",
            "stale",
            "conformance",
        ],
    )?;
    validate_nested_option_keys(
        &object,
        "boost",
        "boost",
        &[
            "resource",
            "title",
            "heading",
            "description",
            "tags",
            "type",
            "sources",
            "body",
        ],
    )?;
    Ok(Some(unsafe {
        SearchOptions::from_napi_value(object.value().env, object.raw())?
    }))
}

fn resolve_options(options: Option<SearchOptions>) -> NapiResult<ResolvedOptions> {
    let options = options.unwrap_or(SearchOptions {
        limit: None,
        where_filter: None,
        as_of: None,
        match_mode: None,
        fields: None,
        boost: None,
        fuzzy: None,
    });

    let match_all = match options.match_mode.as_deref().unwrap_or("any") {
        "any" => false,
        "all" => true,
        _ => return Err(invalid_options("match must be `any` or `all`")),
    };

    let fields = match options.fields {
        None => SearchField::ALL.to_vec(),
        Some(values) if values.is_empty() => {
            return Err(invalid_options("fields must be a non-empty array"));
        }
        Some(values) => {
            let mut seen = HashSet::new();
            let mut result = Vec::new();
            for value in values {
                let field = SearchField::parse(&value)
                    .ok_or_else(|| invalid_options(format!("unknown field `{value}`")))?;
                if seen.insert(field) {
                    result.push(field);
                }
            }
            result
        }
    };

    let fuzzy_ratio = match options.fuzzy {
        None | Some(Either::A(false)) => 0.0,
        Some(Either::A(true)) => 0.2,
        Some(Either::B(value)) => {
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                return Err(invalid_options("fuzzy must be between 0 and 1"));
            }
            value
        }
    };

    let mut boosts = HashMap::new();
    for field in SearchField::ALL {
        let value = boost_value(&options.boost, field).unwrap_or(field.baseline_boost() as f64);
        if !value.is_finite() || !(0.1..=10.0).contains(&value) {
            return Err(invalid_options(format!(
                "boost.{} must be between 0.1 and 10",
                field.name()
            )));
        }
        boosts.insert(field, value as f32);
    }

    let limit = options.limit.unwrap_or(10.0);
    if !limit.is_finite() || limit < 0.0 || limit.fract() != 0.0 || limit > usize::MAX as f64 {
        return Err(invalid_options(
            "limit must be a finite non-negative integer",
        ));
    }

    Ok(ResolvedOptions {
        limit: limit as usize,
        where_filter: resolve_where(options.where_filter)?,
        as_of_epoch: options.as_of.unwrap_or_else(Utc::now).timestamp_millis(),
        match_all,
        fields,
        boosts,
        fuzzy_ratio,
    })
}

fn tokenize(text: &str) -> Vec<String> {
    let mut analyzer = analyzer();
    let mut stream = analyzer.token_stream(text);
    let mut terms = Vec::new();
    while stream.advance() {
        terms.push(stream.token().text.clone());
    }
    terms
}

fn fuzzy_distance(term: &str, ratio: f64) -> u8 {
    if ratio == 0.0 {
        return 0;
    }
    ((term.chars().count() as f64 * ratio).round() as u8).clamp(1, 2)
}

// The actual branch builder is kept separate so the string is available for
// the fuzzy ratio → discrete edit-distance mapping.
fn field_term_query_text(
    plan: &QueryPlan,
    fields: &Fields,
    field: SearchField,
    text: &str,
    final_term: bool,
    apply_field_boost: bool,
) -> Box<dyn Query> {
    let term = Term::from_field_text(fields.searchable(field), text);
    let mut alternatives: Vec<Box<dyn Query>> = vec![Box::new(TermQuery::new(
        term.clone(),
        IndexRecordOption::WithFreqs,
    ))];
    let distance = fuzzy_distance(text, plan.options.fuzzy_ratio);

    if distance > 0 {
        alternatives.push(Box::new(BoostQuery::new(
            Box::new(FuzzyTermQuery::new(term.clone(), distance, true)),
            0.70,
        )));
    }
    if final_term && text.chars().count() >= 3 {
        alternatives.push(Box::new(BoostQuery::new(
            Box::new(FuzzyTermQuery::new_prefix(term, distance, true)),
            0.50,
        )));
    }

    let mut query: Box<dyn Query> = if alternatives.len() == 1 {
        alternatives.pop().expect("exact query")
    } else {
        // Exact, fuzzy, and prefix are alternative interpretations of one
        // term/field match. Disjunction-max avoids triple-counting an exact
        // term that also satisfies the fuzzy and prefix branches.
        Box::new(DisjunctionMaxQuery::new(alternatives))
    };
    if apply_field_boost {
        query = Box::new(BoostQuery::new(
            query,
            *plan.options.boosts.get(&field).expect("resolved boost"),
        ));
    }
    query
}

fn build_text_query(plan: &QueryPlan, fields: &Fields) -> Option<Box<dyn Query>> {
    if plan.terms.is_empty() {
        return None;
    }
    let final_index = plan.terms.len() - 1;
    let term_queries: Vec<Box<dyn Query>> = plan
        .terms
        .iter()
        .enumerate()
        .map(|(index, term)| {
            let field_queries: Vec<Box<dyn Query>> = plan
                .options
                .fields
                .iter()
                .map(|field| {
                    field_term_query_text(plan, fields, *field, term, index == final_index, true)
                })
                .collect();
            Box::new(BooleanQuery::union(field_queries)) as Box<dyn Query>
        })
        .collect();
    let query: Box<dyn Query> = if plan.options.match_all {
        Box::new(BooleanQuery::intersection(term_queries))
    } else {
        Box::new(BooleanQuery::union(term_queries))
    };
    Some(query)
}

fn exact_values_query(field: Field, values: &BTreeSet<String>) -> Box<dyn Query> {
    Box::new(TermSetQuery::new(
        values
            .iter()
            .map(|value| Term::from_field_text(field, value)),
    ))
}

fn classified_query(fields: &Fields) -> Box<dyn Query> {
    Box::new(TermQuery::new(
        Term::from_field_u64(fields.staleness_classified, 1),
        IndexRecordOption::Basic,
    ))
}

fn stale_at_or_before_query(fields: &Fields, as_of_epoch: i64) -> Box<dyn Query> {
    Box::new(FastFieldRangeQuery::new(
        Bound::Unbounded,
        Bound::Included(Term::from_field_i64(fields.stale_after_epoch, as_of_epoch)),
    ))
}

fn build_filter_query(
    filter: &ResolvedWhere,
    fields: &Fields,
    as_of_epoch: i64,
) -> Option<Box<dyn Query>> {
    let mut clauses: Vec<Box<dyn Query>> = Vec::new();

    if let Some(values) = &filter.types {
        clauses.push(exact_values_query(fields.type_exact, values));
    }
    if let Some(values) = &filter.tags_any {
        clauses.push(exact_values_query(fields.tag_exact, values));
    }
    if let Some(values) = &filter.statuses {
        clauses.push(exact_values_query(fields.status, values));
    }
    if let Some(values) = &filter.trust_tiers {
        clauses.push(exact_values_query(fields.trust_tier, values));
    }
    if let Some(values) = &filter.conformance {
        clauses.push(exact_values_query(fields.conformance, values));
    }
    if let Some(wants_stale) = filter.stale {
        let stale_query = stale_at_or_before_query(fields, as_of_epoch);
        let stale_clause: Box<dyn Query> = if wants_stale {
            Box::new(BooleanQuery::new(vec![
                (Occur::Must, classified_query(fields)),
                (Occur::Must, stale_query),
            ]))
        } else {
            // `stale: false` means explicitly classified and not stale at
            // `asOf`. Missing staleAfterEpoch therefore matches false, while
            // unclassified degraded sections match neither stale branch.
            Box::new(BooleanQuery::new(vec![
                (Occur::Must, classified_query(fields)),
                (Occur::MustNot, stale_query),
            ]))
        };
        clauses.push(stale_clause);
    }

    match clauses.len() {
        0 => None,
        1 => clauses.pop(),
        _ => Some(Box::new(BooleanQuery::intersection(clauses))),
    }
}

fn build_query(plan: &QueryPlan, fields: &Fields) -> Option<Box<dyn Query>> {
    let text_query = build_text_query(plan, fields)?;
    let Some(filter_query) =
        build_filter_query(&plan.options.where_filter, fields, plan.options.as_of_epoch)
    else {
        return Some(text_query);
    };

    // Metadata must constrain the matching document set without changing BM25
    // scores. A zero-score wrapper makes that invariant explicit even though
    // several individual filter primitives already happen to score constantly.
    Some(Box::new(BooleanQuery::new(vec![
        (Occur::Must, text_query),
        (
            Occur::Must,
            Box::new(ConstScoreQuery::new(filter_query, 0.0)),
        ),
    ])))
}

fn field_probe(plan: &QueryPlan, fields: &Fields, field: SearchField) -> Box<dyn Query> {
    let final_index = plan.terms.len() - 1;
    let clauses: Vec<Box<dyn Query>> = plan
        .terms
        .iter()
        .enumerate()
        .map(|(index, term)| {
            field_term_query_text(plan, fields, field, term, index == final_index, false)
        })
        .collect();
    Box::new(BooleanQuery::union(clauses))
}

#[derive(Debug, ThisError)]
enum EngineError {
    #[error("[ERR_OKF_INVALID_PREPARED_DOCUMENT] {0}")]
    Invalid(String),
    #[error("stored index invariant failed: {0}")]
    StoredInvariant(String),
    #[error("[ERR_OKF_INDEX_UNUSABLE] {0}")]
    Poisoned(String),
    #[error("[ERR_OKF_NATIVE] {0}")]
    UnsafeInteger(String),
    #[error("[ERR_OKF_NATIVE] {0}")]
    Tantivy(#[from] tantivy::TantivyError),
}

#[derive(Clone)]
struct DocumentState {
    document_id: String,
    path: String,
    document_type: String,
    conformance: String,
    diagnostics: Vec<Diagnostic>,
    status: Option<String>,
    trust_tier: Option<String>,
    section_ids: BTreeSet<String>,
    section_count: usize,
}

impl From<&PreparedDocument> for DocumentState {
    fn from(value: &PreparedDocument) -> Self {
        Self {
            document_id: value.document_id.clone(),
            path: value.path.clone(),
            document_type: value.document_type.clone(),
            conformance: value.conformance.clone(),
            diagnostics: value.diagnostics.clone(),
            status: value.status.clone(),
            trust_tier: value.trust_tier.clone(),
            section_ids: value
                .sections
                .iter()
                .map(|section| section.section_id.clone())
                .collect(),
            section_count: value.sections.len(),
        }
    }
}

#[derive(Clone)]
struct Record {
    address: DocAddress,
    document_id: String,
    title: String,
    section_id: String,
    conformance: String,
    heading_path: String,
    path: String,
    start_line: u32,
    end_line: u32,
    text: String,
}

#[derive(Clone)]
struct Candidate {
    score: Score,
    record: Record,
}

struct Engine {
    _index: Index,
    // This is a clone of the directory passed to `_index`; RamDirectory clones
    // share the live file map, so telemetry observes the same files on demand.
    ram_directory: RamDirectory,
    reader: IndexReader,
    writer: IndexWriter,
    fields: Fields,
    documents: BTreeMap<String, DocumentState>,
    poisoned: Mutex<Option<String>>,
    #[cfg(test)]
    count_results: std::collections::VecDeque<Result<usize, tantivy::TantivyError>>,
    #[cfg(test)]
    query_results: Mutex<std::collections::VecDeque<Result<(), tantivy::TantivyError>>>,
}

impl Engine {
    fn new(documents: Vec<PreparedDocument>) -> Result<Self, EngineError> {
        validate_set(&documents)?;
        let (schema, fields) = schema();
        let ram_directory = RamDirectory::create();
        let index = Index::create(ram_directory.clone(), schema, IndexSettings::default())?;
        index.tokenizers().register(TOKENIZER, analyzer());
        let mut writer = index.writer(WRITER_HEAP_BYTES)?;
        let mut states = BTreeMap::new();
        for document in &documents {
            add_document(&writer, &fields, document)?;
            states.insert(document.document_id.clone(), DocumentState::from(document));
        }
        writer.commit()?;
        let reader: IndexReader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;
        reader.reload()?;
        Ok(Self {
            _index: index,
            ram_directory,
            reader,
            writer,
            fields,
            documents: states,
            poisoned: Mutex::new(None),
            #[cfg(test)]
            count_results: std::collections::VecDeque::new(),
            #[cfg(test)]
            query_results: Mutex::new(std::collections::VecDeque::new()),
        })
    }

    fn usable(&self) -> Result<(), EngineError> {
        self.poisoned
            .lock()
            .as_ref()
            .map_or(Ok(()), |cause| Err(EngineError::Poisoned(cause.clone())))
    }

    fn poison<T>(&self, cause: impl Into<String>) -> Result<T, EngineError> {
        let cause = cause.into();
        *self.poisoned.lock() = Some(cause.clone());
        Err(EngineError::Poisoned(cause))
    }

    fn count(&mut self, document_id: &str) -> Result<usize, EngineError> {
        #[cfg(test)]
        if let Some(result) = self.count_results.pop_front() {
            return result.map_err(EngineError::Tantivy);
        }

        let query = TermQuery::new(
            Term::from_field_text(self.fields.document_id, document_id),
            IndexRecordOption::Basic,
        );
        Ok(self.reader.searcher().search(&query, &Count)?)
    }

    fn verify_count(&mut self, document_id: &str, expected: usize) -> Result<(), EngineError> {
        let actual = self.count(document_id)?;
        if actual == expected {
            return Ok(());
        }
        self.poison(format!(
            "document `{document_id}` owns {actual} sections; state expects {expected}"
        ))
    }

    fn verify_post_commit_count(
        &mut self,
        document_id: &str,
        expected: usize,
    ) -> Result<(), EngineError> {
        match self.count(document_id) {
            Ok(actual) if actual == expected => Ok(()),
            Ok(actual) => self.poison(format!(
                "post-commit verification found {actual} sections for document `{document_id}`; expected {expected}"
            )),
            Err(error) => self.poison(format!(
                "post-commit verification failed for document `{document_id}`: {error}"
            )),
        }
    }

    fn commit(&mut self, operation: &str) -> Result<(), EngineError> {
        if let Err(error) = self.writer.commit() {
            return self.poison(format!("{operation} commit failed: {error}"));
        }
        if let Err(error) = self.reader.reload() {
            return self.poison(format!("{operation} reload failed: {error}"));
        }
        Ok(())
    }

    fn ingest(&mut self, document: PreparedDocument) -> Result<(), EngineError> {
        self.usable()?;
        validate_document(&document)?;

        if let Some(existing) = self.documents.get(&document.document_id)
            && existing.path != document.path
        {
            return Err(EngineError::Invalid(format!(
                "replacement documentId `{}` changed path from `{}` to `{}`",
                document.document_id, existing.path, document.path
            )));
        }
        if let Some(conflict) = self
            .documents
            .values()
            .find(|state| state.document_id != document.document_id && state.path == document.path)
        {
            return Err(EngineError::Invalid(format!(
                "path `{}` is already owned by documentId `{}`",
                document.path, conflict.document_id
            )));
        }
        for section in &document.sections {
            if let Some(conflict) = self.documents.values().find(|state| {
                state.document_id != document.document_id
                    && state.section_ids.contains(&section.section_id)
            }) {
                return Err(EngineError::Invalid(format!(
                    "sectionId `{}` is already owned by documentId `{}`",
                    section.section_id, conflict.document_id
                )));
            }
        }

        let previous = self
            .documents
            .get(&document.document_id)
            .map_or(0, |state| state.section_count);
        self.verify_count(&document.document_id, previous)?;

        self.writer.delete_term(Term::from_field_text(
            self.fields.document_id,
            &document.document_id,
        ));
        if let Err(error) = add_document(&self.writer, &self.fields, &document) {
            return self.poison(format!(
                "replacement `{}` could not be staged: {error}",
                document.document_id
            ));
        }
        self.commit(&format!("replace `{}`", document.document_id))?;
        let count = document.sections.len();
        self.documents
            .insert(document.document_id.clone(), DocumentState::from(&document));
        self.verify_post_commit_count(&document.document_id, count)
    }

    fn remove(&mut self, document_id: &str) -> Result<bool, EngineError> {
        self.usable()?;
        let Some(existing) = self.documents.get(document_id).cloned() else {
            self.verify_count(document_id, 0)?;
            return Ok(false);
        };
        self.verify_count(document_id, existing.section_count)?;
        self.writer
            .delete_term(Term::from_field_text(self.fields.document_id, document_id));
        self.commit(&format!("remove `{document_id}`"))?;
        self.documents.remove(document_id);
        self.verify_post_commit_count(document_id, 0)?;
        Ok(true)
    }

    fn index_stats(&self) -> Result<IndexStats, EngineError> {
        self.usable()?;

        let mut strict = 0usize;
        let mut degraded = 0usize;
        let mut type_counts = BTreeMap::<String, usize>::new();
        let mut draft = 0usize;
        let mut stable = 0usize;
        let mut deprecated = 0usize;
        let mut status_unclassified = 0usize;
        let mut unverified = 0usize;
        let mut machine_confirmed = 0usize;
        let mut human_reviewed = 0usize;
        let mut trust_unclassified = 0usize;

        for state in self.documents.values() {
            match state.conformance.as_str() {
                "strict" => strict += 1,
                "degraded" => degraded += 1,
                _ => {}
            }
            *type_counts.entry(state.document_type.clone()).or_default() += 1;

            match state.status.as_deref() {
                Some("draft") => draft += 1,
                Some("stable") => stable += 1,
                Some("deprecated") => deprecated += 1,
                _ => status_unclassified += 1,
            }
            match state.trust_tier.as_deref() {
                Some("unverified") => unverified += 1,
                Some("machine-confirmed") => machine_confirmed += 1,
                Some("human-reviewed") => human_reviewed += 1,
                _ => trust_unclassified += 1,
            }
        }

        Ok(IndexStats {
            logical: LogicalIndexStats {
                documents: IndexDocumentStats {
                    total: usize_to_js_number(self.documents.len(), "document total")?,
                    strict: usize_to_js_number(strict, "strict document count")?,
                    degraded: usize_to_js_number(degraded, "degraded document count")?,
                },
                types: type_counts
                    .into_iter()
                    .map(|(document_type, document_count)| {
                        Ok(IndexTypeStats {
                            document_type,
                            document_count: usize_to_js_number(
                                document_count,
                                "per-type document count",
                            )?,
                        })
                    })
                    .collect::<Result<Vec<_>, EngineError>>()?,
                statuses: IndexStatusStats {
                    draft: usize_to_js_number(draft, "draft document count")?,
                    stable: usize_to_js_number(stable, "stable document count")?,
                    deprecated: usize_to_js_number(deprecated, "deprecated document count")?,
                    unclassified: usize_to_js_number(
                        status_unclassified,
                        "unclassified status count",
                    )?,
                },
                trust_tiers: IndexTrustTierStats {
                    unverified: usize_to_js_number(unverified, "unverified document count")?,
                    machine_confirmed: usize_to_js_number(
                        machine_confirmed,
                        "machine-confirmed document count",
                    )?,
                    human_reviewed: usize_to_js_number(
                        human_reviewed,
                        "human-reviewed document count",
                    )?,
                    unclassified: usize_to_js_number(
                        trust_unclassified,
                        "unclassified trust-tier count",
                    )?,
                },
            },
            storage: IndexStorageStats {
                kind: "in-memory-index-files".to_owned(),
                size_in_bytes: usize_to_js_number(
                    self.ram_directory.total_mem_usage(),
                    "index file bytes",
                )?,
            },
        })
    }

    fn list_types(&self) -> Result<Vec<String>, EngineError> {
        self.usable()?;
        Ok(self
            .documents
            .values()
            .map(|state| state.document_type.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect())
    }

    fn list_degraded(&self) -> Result<Vec<DegradedDocument>, EngineError> {
        self.usable()?;
        let mut documents: Vec<_> = self
            .documents
            .values()
            .filter(|state| state.conformance == "degraded")
            .map(|state| DegradedDocument {
                document_id: state.document_id.clone(),
                path: state.path.clone(),
                diagnostics: state.diagnostics.clone(),
            })
            .collect();
        documents.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(documents)
    }

    fn search(&self, text: &str, options: Option<SearchOptions>) -> NapiResult<Vec<SearchHit>> {
        self.usable().map_err(native_error)?;
        let plan = QueryPlan {
            terms: tokenize(text.trim()),
            options: resolve_options(options)?,
        };
        if plan.terms.is_empty() || plan.options.limit == 0 {
            return Ok(Vec::new());
        }
        let query = build_query(&plan, &self.fields).expect("non-empty query");
        let searcher = self.reader.searcher();
        let live = searcher.num_docs() as usize;
        if live == 0 {
            return Ok(Vec::new());
        }

        let mut fetch = plan
            .options
            .limit
            .saturating_mul(4)
            .max(FETCH_FLOOR)
            .min(live);
        let selected = loop {
            let requested = fetch.saturating_add(1).min(live);
            #[cfg(test)]
            if let Some(result) = self.query_results.lock().pop_front() {
                result.map_err(|error| native_error(error.into()))?;
            }
            let top = searcher
                .search(
                    query.as_ref(),
                    &TopDocs::with_limit(requested).order_by_score(),
                )
                .map_err(|e| native_error(e.into()))?;
            let has_more = top.len() > fetch;
            let mut candidates = Vec::with_capacity(fetch.min(top.len()));
            for (score, address) in top.iter().take(fetch).copied() {
                let record = match read_record(&searcher, &self.fields, address) {
                    Ok(record) => record,
                    Err(EngineError::StoredInvariant(cause)) => {
                        return self.poison(cause).map_err(native_error);
                    }
                    Err(error) => return Err(native_error(error)),
                };
                candidates.push(Candidate { score, record });
            }
            let ranked = collapse(candidates);
            let enough = ranked.len() >= plan.options.limit;
            let boundary = enough.then(|| ranked[plan.options.limit - 1].score);
            let next_score = top.get(fetch).map(|(score, _)| *score);
            let closed = matches!((boundary, next_score), (Some(a), Some(b)) if b < a)
                || matches!((boundary, next_score), (Some(_), None));
            if !has_more || (enough && closed) || fetch >= live {
                break ranked;
            }
            let next = fetch.saturating_mul(2).min(live);
            if next == fetch {
                break ranked;
            }
            fetch = next;
        };

        match selected
            .into_iter()
            .take(plan.options.limit)
            .map(|candidate| to_hit(&searcher, &self.fields, &plan, candidate))
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(hits) => Ok(hits),
            Err(EngineError::StoredInvariant(cause)) => self.poison(cause).map_err(native_error),
            Err(error) => Err(native_error(error)),
        }
    }
}

fn validate_set(documents: &[PreparedDocument]) -> Result<(), EngineError> {
    let mut document_ids = HashSet::new();
    let mut paths = HashSet::new();
    let mut section_ids = HashSet::new();

    for document in documents {
        validate_document(document)?;
        if !document_ids.insert(document.document_id.as_str()) {
            return Err(EngineError::Invalid(format!(
                "duplicate documentId `{}`",
                document.document_id
            )));
        }
        if !paths.insert(document.path.as_str()) {
            return Err(EngineError::Invalid(format!(
                "duplicate path `{}`",
                document.path
            )));
        }
        for section in &document.sections {
            if !section_ids.insert(section.section_id.as_str()) {
                return Err(EngineError::Invalid(format!(
                    "duplicate sectionId `{}`",
                    section.section_id
                )));
            }
        }
    }
    Ok(())
}

fn usize_to_js_number(value: usize, metric: &str) -> Result<f64, EngineError> {
    if (value as u128) > MAX_SAFE_INTEGER {
        return Err(EngineError::UnsafeInteger(format!(
            "{metric} exceeds Number.MAX_SAFE_INTEGER: {value}"
        )));
    }
    Ok(value as f64)
}

fn is_valid_line_number(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && (1.0..=u32::MAX as f64).contains(&value)
}

fn validate_document(document: &PreparedDocument) -> Result<(), EngineError> {
    if document.document_id.trim().is_empty() {
        return Err(EngineError::Invalid("documentId must not be empty".into()));
    }
    if document.path.trim().is_empty() {
        return Err(EngineError::Invalid(format!(
            "document `{}` has an empty path",
            document.document_id
        )));
    }
    if document.document_type.trim().is_empty() {
        return Err(EngineError::Invalid(format!(
            "document `{}` has an empty type",
            document.document_id
        )));
    }
    if !matches!(document.conformance.as_str(), "strict" | "degraded") {
        return Err(EngineError::Invalid(format!(
            "document `{}` has invalid conformance `{}`",
            document.document_id, document.conformance
        )));
    }
    match document.conformance.as_str() {
        "strict" if !document.diagnostics.is_empty() => {
            return Err(EngineError::Invalid(format!(
                "strict document `{}` must not have diagnostics",
                document.document_id
            )));
        }
        "degraded" if document.diagnostics.is_empty() => {
            return Err(EngineError::Invalid(format!(
                "degraded document `{}` must have at least one diagnostic",
                document.document_id
            )));
        }
        _ => {}
    }
    if let Some(diagnostic) = document.diagnostics.iter().find(|diagnostic| {
        diagnostic.path != document.path
            || !matches!(diagnostic.code.as_str(), "ERR_OKF_PARSE" | "ERR_OKF_FIELD")
    }) {
        return Err(EngineError::Invalid(format!(
            "document `{}` has invalid diagnostic `{}` for path `{}`",
            document.document_id, diagnostic.code, diagnostic.path
        )));
    }
    if let Some(value) = document.stale_after_epoch
        && (!value.is_finite()
            || value.fract() != 0.0
            || value < i64::MIN as f64
            || value > i64::MAX as f64)
    {
        return Err(EngineError::Invalid(format!(
            "document `{}` has an invalid staleAfterEpoch",
            document.document_id
        )));
    }
    if !document.staleness_classified && document.stale_after_epoch.is_some() {
        return Err(EngineError::Invalid(format!(
            "document `{}` has an unclassified staleAfterEpoch",
            document.document_id
        )));
    }
    if document.conformance == "strict"
        && (document.status.is_none()
            || document.trust_tier.is_none()
            || !document.staleness_classified)
    {
        return Err(EngineError::Invalid(format!(
            "strict document `{}` requires classified status, trustTier, and staleness",
            document.document_id
        )));
    }
    if let Some(status) = document.status.as_deref()
        && !matches!(status, "draft" | "stable" | "deprecated")
    {
        return Err(EngineError::Invalid(format!(
            "document `{}` has invalid status `{status}`",
            document.document_id
        )));
    }
    if let Some(tier) = document.trust_tier.as_deref()
        && !matches!(tier, "unverified" | "machine-confirmed" | "human-reviewed")
    {
        return Err(EngineError::Invalid(format!(
            "document `{}` has invalid trustTier `{tier}`",
            document.document_id
        )));
    }
    if document.sections.is_empty() {
        return Err(EngineError::Invalid(format!(
            "document `{}` has no projected sections",
            document.document_id
        )));
    }

    let mut ids = HashSet::new();
    for section in &document.sections {
        if section.section_id.trim().is_empty() {
            return Err(EngineError::Invalid(format!(
                "document `{}` contains an empty sectionId",
                document.document_id
            )));
        }
        if !ids.insert(section.section_id.as_str()) {
            return Err(EngineError::Invalid(format!(
                "document `{}` repeats sectionId `{}`",
                document.document_id, section.section_id
            )));
        }
        if !is_valid_line_number(section.start_line)
            || !is_valid_line_number(section.end_line)
            || section.end_line < section.start_line
        {
            return Err(EngineError::Invalid(format!(
                "section `{}` has invalid line bounds {}..{}",
                section.section_id, section.start_line, section.end_line
            )));
        }
    }
    Ok(())
}

fn add_document(
    writer: &IndexWriter,
    fields: &Fields,
    document: &PreparedDocument,
) -> Result<(), EngineError> {
    for section in &document.sections {
        add_section(writer, fields, document, section)?;
    }
    Ok(())
}

fn add_section(
    writer: &IndexWriter,
    fields: &Fields,
    document: &PreparedDocument,
    section: &PreparedSection,
) -> Result<(), EngineError> {
    // `validate_document` runs before storage construction in every caller.
    let start_line = section.start_line as u32;
    let end_line = section.end_line as u32;

    let mut doc = TantivyDocument::default();
    doc.add_text(fields.section_id, &section.section_id);
    doc.add_text(fields.document_id, &document.document_id);
    doc.add_text(fields.conformance, &document.conformance);
    doc.add_text(fields.title, &document.title);
    doc.add_text(fields.path, &document.path);
    doc.add_text(fields.type_text, &document.document_type);
    doc.add_text(fields.type_exact, &document.document_type);
    for tag in &document.tags {
        doc.add_text(fields.tags_text, tag);
        doc.add_text(fields.tag_exact, tag);
    }
    if let Some(status) = &document.status {
        doc.add_text(fields.status, status);
    }
    if let Some(epoch) = document.stale_after_epoch {
        doc.add_i64(fields.stale_after_epoch, epoch as i64);
    }
    // The positive marker is sufficient: missing means unclassified. Avoiding
    // a posting for the overwhelmingly uninteresting false value keeps this
    // filter field compact.
    if document.staleness_classified {
        doc.add_u64(fields.staleness_classified, 1);
    }
    if let Some(tier) = &document.trust_tier {
        doc.add_text(fields.trust_tier, tier);
    }
    doc.add_text(fields.resource, &document.resource);
    doc.add_text(fields.heading, &section.heading_path);
    doc.add_text(fields.description, &document.description);
    doc.add_text(fields.sources, &document.source_text);
    doc.add_text(fields.body, &section.text);
    doc.add_u64(fields.start_line, start_line as u64);
    doc.add_u64(fields.end_line, end_line as u64);
    writer.add_document(doc)?;
    Ok(())
}

fn required_text(doc: &TantivyDocument, field: Field, name: &str) -> Result<String, EngineError> {
    doc.get_first(field)
        .and_then(|value| value.as_value().as_str())
        .map(str::to_owned)
        .ok_or_else(|| {
            EngineError::StoredInvariant(format!(
                "stored Tantivy document is missing or has wrong type for text field `{name}`"
            ))
        })
}

fn required_u64(doc: &TantivyDocument, field: Field, name: &str) -> Result<u64, EngineError> {
    doc.get_first(field)
        .and_then(|value| value.as_value().as_u64())
        .ok_or_else(|| {
            EngineError::StoredInvariant(format!(
                "stored Tantivy document is missing or has wrong type for u64 field `{name}`"
            ))
        })
}

fn read_record(
    searcher: &tantivy::Searcher,
    fields: &Fields,
    address: DocAddress,
) -> Result<Record, EngineError> {
    let doc = searcher.doc::<TantivyDocument>(address)?;
    let start_line = required_u64(&doc, fields.start_line, "start_line")?;
    let end_line = required_u64(&doc, fields.end_line, "end_line")?;
    Ok(Record {
        address,
        document_id: required_text(&doc, fields.document_id, "document_id")?,
        title: required_text(&doc, fields.title, "title")?,
        section_id: required_text(&doc, fields.section_id, "section_id")?,
        conformance: required_text(&doc, fields.conformance, "conformance")?,
        heading_path: required_text(&doc, fields.heading, "heading")?,
        path: required_text(&doc, fields.path, "path")?,
        start_line: u32::try_from(start_line)
            .map_err(|_| EngineError::StoredInvariant("stored start_line exceeds u32".into()))?,
        end_line: u32::try_from(end_line)
            .map_err(|_| EngineError::StoredInvariant("stored end_line exceeds u32".into()))?,
        text: required_text(&doc, fields.body, "body")?,
    })
}

fn conformance_rank(value: &str) -> u8 {
    if value == "strict" { 0 } else { 1 }
}

fn compare_candidates(left: &Candidate, right: &Candidate) -> std::cmp::Ordering {
    right
        .score
        .total_cmp(&left.score)
        .then_with(|| {
            conformance_rank(&left.record.conformance)
                .cmp(&conformance_rank(&right.record.conformance))
        })
        .then_with(|| left.record.section_id.cmp(&right.record.section_id))
}

fn collapse(mut candidates: Vec<Candidate>) -> Vec<Candidate> {
    candidates.sort_by(compare_candidates);
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| seen.insert(candidate.record.document_id.clone()))
        .collect()
}

fn floor_char_boundary(text: &str, mut offset: usize) -> usize {
    offset = offset.min(text.len());
    while offset > 0 && !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

fn make_snippet(text: &str, terms: &[String], max_length: usize) -> String {
    // ASCII lowercasing keeps byte offsets aligned with the original string. For
    // non-ASCII case folding we deliberately fall back to a leading snippet.
    let lower = text.to_ascii_lowercase();
    let first_match = terms
        .iter()
        .filter_map(|term| lower.find(&term.to_ascii_lowercase()))
        .min();
    let raw_start = first_match.map_or(0, |position| position.saturating_sub(80));
    let start = floor_char_boundary(text, raw_start);
    let end = floor_char_boundary(text, start.saturating_add(max_length).min(text.len()));
    let mut snippet = String::new();
    if start > 0 {
        snippet.push('…');
    }
    snippet.push_str(text[start..end].trim());
    if end < text.len() {
        snippet.push('…');
    }
    snippet
}

fn matched_fields(
    searcher: &tantivy::Searcher,
    fields: &Fields,
    plan: &QueryPlan,
    address: DocAddress,
) -> Vec<String> {
    plan.options
        .fields
        .iter()
        .copied()
        .filter(|field| {
            let probe = field_probe(plan, fields, *field);
            query_matches_address(searcher, probe.as_ref(), address)
        })
        .map(|field| field.name().to_owned())
        .collect()
}

fn query_matches_address(
    searcher: &tantivy::Searcher,
    query: &dyn Query,
    address: DocAddress,
) -> bool {
    let Ok(weight) = query.weight(EnableScoring::disabled_from_searcher(searcher)) else {
        return false;
    };
    let reader = searcher.segment_reader(address.segment_ord);
    let Ok(mut scorer) = weight.scorer(reader, 1.0) else {
        return false;
    };
    let current = scorer.doc();
    current <= address.doc_id && scorer.seek(address.doc_id) == address.doc_id
}

fn to_hit(
    searcher: &tantivy::Searcher,
    fields: &Fields,
    plan: &QueryPlan,
    candidate: Candidate,
) -> Result<SearchHit, EngineError> {
    let record = candidate.record;
    let matched_fields = matched_fields(searcher, fields, plan, record.address);
    Ok(SearchHit {
        document_id: record.document_id,
        title: record.title,
        section_id: record.section_id,
        score: candidate.score as f64,
        conformance: record.conformance,
        matched_fields,
        heading_path: record.heading_path,
        path: record.path,
        start_line: record.start_line,
        end_line: record.end_line,
        snippet: make_snippet(&record.text, &plan.terms, 240),
    })
}

fn native_error(error: EngineError) -> Error {
    let status = match &error {
        EngineError::Invalid(_) => Status::InvalidArg,
        EngineError::StoredInvariant(_)
        | EngineError::Poisoned(_)
        | EngineError::UnsafeInteger(_)
        | EngineError::Tantivy(_) => Status::GenericFailure,
    };
    Error::new(status, error.to_string())
}

/// Native search handle. The public TypeScript adapter should keep accepting
/// raw Markdown and use the existing OKF parser/projector before crossing this
/// boundary.
#[napi]
pub struct NativeOkfSearch {
    inner: Mutex<Engine>,
}

#[napi]
impl NativeOkfSearch {
    #[napi(factory, js_name = "fromPrepared")]
    pub fn from_prepared(documents: Vec<PreparedDocument>) -> Result<Self, Error> {
        let engine = Engine::new(documents).map_err(native_error)?;
        Ok(Self {
            inner: Mutex::new(engine),
        })
    }

    #[napi(js_name = "ingestPrepared")]
    pub fn ingest_prepared(&self, document: PreparedDocument) -> Result<(), Error> {
        self.inner.lock().ingest(document).map_err(native_error)
    }

    #[napi(js_name = "removeDocument")]
    pub fn remove_document(&self, document_id: String) -> Result<bool, Error> {
        self.inner.lock().remove(&document_id).map_err(native_error)
    }

    #[napi]
    pub fn search(
        &self,
        query: String,
        #[napi(ts_arg_type = "SearchOptions | undefined | null")] options: Option<Object<'_>>,
    ) -> Result<Vec<SearchHit>, Error> {
        {
            let engine = self.inner.lock();
            engine.usable().map_err(native_error)?;
        }
        let options = parse_search_options(options)?;
        self.inner.lock().search(&query, options)
    }

    #[napi(js_name = "indexStats")]
    pub fn index_stats(&self) -> Result<IndexStats, Error> {
        self.inner.lock().index_stats().map_err(native_error)
    }

    #[napi(js_name = "listTypes")]
    pub fn list_types(&self) -> Result<Vec<String>, Error> {
        self.inner.lock().list_types().map_err(native_error)
    }

    #[napi(js_name = "listDegradedDocuments")]
    pub fn list_degraded_documents(&self) -> Result<Vec<DegradedDocument>, Error> {
        self.inner.lock().list_degraded().map_err(native_error)
    }

    /// Tantivy exposes the pieces needed to build completion, but not the
    /// section-aware MiniSearch `autoSuggest` contract. Returning ordinary
    /// search hits as suggestions would be misleading, so this spike fails
    /// explicitly instead.
    #[napi(js_name = "autoSuggest")]
    pub fn auto_suggest(
        &self,
        _query: String,
        _options: Option<SearchOptions>,
    ) -> Result<Vec<Suggestion>, Error> {
        self.inner.lock().usable().map_err(native_error)?;
        Err(Error::new(
            Status::GenericFailure,
            "[ERR_OKF_UNSUPPORTED] autoSuggest is not implemented by the Tantivy backend",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BEFORE: i64 = 999;
    const FIRST_DEADLINE: i64 = 1_000;
    const SECOND_DEADLINE: i64 = 3_000;

    fn section(document_id: &str, text: &str) -> PreparedSection {
        PreparedSection {
            section_id: format!("{document_id}#root"),
            heading_path: "Overview".to_owned(),
            text: text.to_owned(),
            start_line: 1.0,
            end_line: 3.0,
        }
    }

    fn document(section: PreparedSection) -> PreparedDocument {
        let document_id = section
            .section_id
            .split_once('#')
            .map_or(section.section_id.as_str(), |(document_id, _)| document_id)
            .to_owned();
        document_with_metadata(
            &document_id,
            "Note",
            "strict",
            &["search"],
            Some("stable"),
            None,
            true,
            Some("human-reviewed"),
            vec![section],
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn document_with_metadata(
        document_id: &str,
        document_type: &str,
        conformance: &str,
        tags: &[&str],
        status: Option<&str>,
        stale_after_epoch: Option<i64>,
        staleness_classified: bool,
        trust_tier: Option<&str>,
        sections: Vec<PreparedSection>,
    ) -> PreparedDocument {
        let path = format!("{document_id}.md");
        let diagnostics = if conformance == "degraded" {
            vec![Diagnostic {
                code: "ERR_OKF_FIELD".to_owned(),
                message: "fixture degradation".to_owned(),
                field: Some("stale_after".to_owned()),
                path: path.clone(),
            }]
        } else {
            Vec::new()
        };
        PreparedDocument {
            document_id: document_id.to_owned(),
            path,
            document_type: document_type.to_owned(),
            conformance: conformance.to_owned(),
            diagnostics,
            title: format!("Memory architecture for {document_id}"),
            tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
            status: status.map(str::to_owned),
            stale_after_epoch: stale_after_epoch.map(|epoch| epoch as f64),
            staleness_classified,
            trust_tier: trust_tier.map(str::to_owned),
            resource: document_id.to_owned(),
            description: "Memory architecture reference".to_owned(),
            source_text: String::new(),
            sections,
        }
    }

    fn fixture_engine() -> Engine {
        Engine::new(vec![
            document_with_metadata(
                "decision",
                "Decision",
                "strict",
                &["memory", "architecture"],
                Some("stable"),
                Some(FIRST_DEADLINE),
                true,
                Some("human-reviewed"),
                vec![section(
                    "decision",
                    "Memory architecture keeps retrieval predictable.",
                )],
            ),
            document_with_metadata(
                "reference",
                "Reference",
                "strict",
                &["memory", "docs"],
                Some("draft"),
                Some(SECOND_DEADLINE),
                true,
                Some("machine-confirmed"),
                vec![section(
                    "reference",
                    "Memory architecture keeps retrieval predictable.",
                )],
            ),
            document_with_metadata(
                "classified-without-deadline",
                "Note",
                "strict",
                &["memory"],
                Some("stable"),
                None,
                true,
                Some("unverified"),
                vec![section(
                    "classified-without-deadline",
                    "Memory architecture keeps retrieval predictable.",
                )],
            ),
            document_with_metadata(
                "unclassified",
                "Note",
                "degraded",
                &["memory"],
                None,
                None,
                false,
                None,
                vec![section(
                    "unclassified",
                    "Memory architecture keeps retrieval predictable.",
                )],
            ),
        ])
        .expect("fixture should index")
    }

    #[test]
    fn index_stats_count_each_logical_document_and_all_metadata_families() {
        let engine = Engine::new(vec![
            document_with_metadata(
                "draft-machine",
                "Note",
                "strict",
                &[],
                Some("draft"),
                None,
                true,
                Some("machine-confirmed"),
                vec![section("draft-machine", "needle")],
            ),
            document_with_metadata(
                "stable-human",
                "note",
                "strict",
                &[],
                Some("stable"),
                None,
                true,
                Some("human-reviewed"),
                vec![section("stable-human", "needle")],
            ),
            document_with_metadata(
                "deprecated-unverified",
                "Note",
                "strict",
                &[],
                Some("deprecated"),
                None,
                true,
                Some("unverified"),
                vec![section("deprecated-unverified", "needle")],
            ),
            document_with_metadata(
                "unclassified-status",
                "Note",
                "degraded",
                &[],
                None,
                None,
                false,
                Some("human-reviewed"),
                vec![section("unclassified-status", "needle")],
            ),
            document_with_metadata(
                "unclassified-trust",
                "Guide",
                "degraded",
                &[],
                Some("stable"),
                None,
                false,
                None,
                vec![section("unclassified-trust", "needle")],
            ),
        ])
        .expect("stats fixture should index");

        let stats = engine.index_stats().expect("stats should succeed");
        assert_eq!(stats.logical.documents.total, 5.0);
        assert_eq!(stats.logical.documents.strict, 3.0);
        assert_eq!(stats.logical.documents.degraded, 2.0);
        assert_eq!(
            stats
                .logical
                .types
                .iter()
                .map(|item| (item.document_type.as_str(), item.document_count))
                .collect::<Vec<_>>(),
            vec![("Guide", 1.0), ("Note", 3.0), ("note", 1.0)],
        );
        assert_eq!(stats.logical.statuses.draft, 1.0);
        assert_eq!(stats.logical.statuses.stable, 2.0);
        assert_eq!(stats.logical.statuses.deprecated, 1.0);
        assert_eq!(stats.logical.statuses.unclassified, 1.0);
        assert_eq!(stats.logical.trust_tiers.unverified, 1.0);
        assert_eq!(stats.logical.trust_tiers.machine_confirmed, 1.0);
        assert_eq!(stats.logical.trust_tiers.human_reviewed, 2.0);
        assert_eq!(stats.logical.trust_tiers.unclassified, 1.0);
    }

    #[test]
    fn index_stats_samples_the_live_ram_directory_and_tracks_successful_mutations() {
        let mut engine =
            Engine::new(vec![document(strict_section("first", "needle"))]).expect("baseline");
        let initial = engine.index_stats().expect("initial stats");
        assert_eq!(initial.storage.kind, "in-memory-index-files");
        assert_eq!(
            initial.storage.size_in_bytes,
            engine.ram_directory.total_mem_usage() as f64
        );
        assert!(initial.storage.size_in_bytes > 0.0);
        assert_eq!(initial.logical.documents.total, 1.0);

        let mut invalid = document(strict_section("invalid", "needle"));
        invalid.status = Some("future".to_owned());
        engine
            .ingest(invalid)
            .expect_err("invalid document should be rejected");
        let after_failed = engine.index_stats().expect("failed ingest stats");
        assert_eq!(after_failed.logical.documents.total, 1.0);

        let added = document_with_metadata(
            "added",
            "Note",
            "degraded",
            &[],
            None,
            None,
            false,
            None,
            vec![section("added", "needle")],
        );
        engine
            .ingest(added)
            .expect("a valid degraded document should commit");
        let after_ingest = engine.index_stats().expect("ingest stats");
        assert_eq!(after_ingest.logical.documents.total, 2.0);
        assert_eq!(
            after_ingest.storage.size_in_bytes,
            engine.ram_directory.total_mem_usage() as f64
        );

        engine.remove("added").expect("remove should commit");
        let after_remove = engine.index_stats().expect("remove stats");
        assert_eq!(after_remove.logical.documents.total, 1.0);
        assert_eq!(after_remove.logical.documents.degraded, 0.0);
        assert_eq!(
            after_remove.storage.size_in_bytes,
            engine.ram_directory.total_mem_usage() as f64
        );
    }

    fn where_filter() -> SearchWhere {
        SearchWhere {
            types: None,
            tags_any: None,
            statuses: None,
            trust_tiers: None,
            stale: None,
            conformance: None,
        }
    }

    fn options(where_filter: Option<SearchWhere>, as_of_epoch: i64) -> SearchOptions {
        SearchOptions {
            limit: Some(50.0),
            where_filter,
            as_of: Some(
                DateTime::<Utc>::from_timestamp_millis(as_of_epoch).expect("fixture timestamp"),
            ),
            match_mode: None,
            fields: Some(vec!["body".to_owned()]),
            boost: None,
            fuzzy: None,
        }
    }

    fn result_ids(
        engine: &Engine,
        where_filter: Option<SearchWhere>,
        as_of_epoch: i64,
    ) -> BTreeSet<String> {
        engine
            .search("memory", Some(options(where_filter, as_of_epoch)))
            .expect("search should succeed")
            .into_iter()
            .map(|hit| hit.document_id)
            .collect()
    }

    #[test]
    fn exact_metadata_filters_are_pushed_into_tantivy() {
        let engine = fixture_engine();

        let mut filter = where_filter();
        filter.types = Some(vec!["Decision".to_owned(), "Reference".to_owned()]);
        assert_eq!(
            result_ids(&engine, Some(filter), BEFORE),
            BTreeSet::from(["decision".to_owned(), "reference".to_owned()]),
        );

        let mut filter = where_filter();
        filter.tags_any = Some(vec!["docs".to_owned(), "missing".to_owned()]);
        assert_eq!(
            result_ids(&engine, Some(filter), BEFORE),
            BTreeSet::from(["reference".to_owned()]),
        );

        let mut filter = where_filter();
        filter.statuses = Some(vec!["stable".to_owned()]);
        assert_eq!(
            result_ids(&engine, Some(filter), BEFORE),
            BTreeSet::from([
                "classified-without-deadline".to_owned(),
                "decision".to_owned(),
            ]),
        );

        let mut filter = where_filter();
        filter.trust_tiers = Some(vec!["human-reviewed".to_owned()]);
        assert_eq!(
            result_ids(&engine, Some(filter), BEFORE),
            BTreeSet::from(["decision".to_owned()]),
        );

        let mut filter = where_filter();
        filter.conformance = Some(vec!["degraded".to_owned()]);
        assert_eq!(
            result_ids(&engine, Some(filter), BEFORE),
            BTreeSet::from(["unclassified".to_owned()]),
        );
    }

    #[test]
    fn filter_dimensions_intersect_and_values_within_a_dimension_union() {
        let engine = fixture_engine();
        let mut filter = where_filter();
        filter.types = Some(vec!["Decision".to_owned(), "Reference".to_owned()]);
        filter.tags_any = Some(vec!["architecture".to_owned(), "missing".to_owned()]);
        filter.statuses = Some(vec!["stable".to_owned()]);
        filter.trust_tiers = Some(vec!["human-reviewed".to_owned()]);
        filter.conformance = Some(vec!["strict".to_owned()]);

        assert_eq!(
            result_ids(&engine, Some(filter), BEFORE),
            BTreeSet::from(["decision".to_owned()]),
        );
    }

    #[test]
    fn empty_filter_arrays_remain_no_ops() {
        let engine = fixture_engine();
        let mut filter = where_filter();
        filter.types = Some(Vec::new());
        filter.tags_any = Some(Vec::new());
        filter.statuses = Some(Vec::new());
        filter.trust_tiers = Some(Vec::new());
        filter.conformance = Some(Vec::new());

        assert_eq!(
            result_ids(&engine, Some(filter), BEFORE),
            result_ids(&engine, None, BEFORE),
        );
    }

    #[test]
    fn stale_filter_preserves_classification_and_boundary_semantics() {
        let engine = fixture_engine();

        let mut stale = where_filter();
        stale.stale = Some(true);
        assert!(result_ids(&engine, Some(stale.clone()), BEFORE).is_empty());
        assert_eq!(
            result_ids(&engine, Some(stale.clone()), FIRST_DEADLINE),
            BTreeSet::from(["decision".to_owned()]),
        );
        assert_eq!(
            result_ids(&engine, Some(stale), SECOND_DEADLINE),
            BTreeSet::from(["decision".to_owned(), "reference".to_owned()]),
        );

        let mut fresh = where_filter();
        fresh.stale = Some(false);
        assert_eq!(
            result_ids(&engine, Some(fresh.clone()), BEFORE),
            BTreeSet::from([
                "classified-without-deadline".to_owned(),
                "decision".to_owned(),
                "reference".to_owned(),
            ]),
        );
        assert_eq!(
            result_ids(&engine, Some(fresh.clone()), FIRST_DEADLINE),
            BTreeSet::from([
                "classified-without-deadline".to_owned(),
                "reference".to_owned(),
            ]),
        );
        assert_eq!(
            result_ids(&engine, Some(fresh), SECOND_DEADLINE),
            BTreeSet::from(["classified-without-deadline".to_owned()]),
        );
    }

    #[test]
    fn pushdown_restricts_the_tantivy_candidate_set_before_document_loading() {
        let engine = fixture_engine();
        let searcher = engine.reader.searcher();

        let unfiltered_plan = QueryPlan {
            terms: tokenize("memory"),
            options: resolve_options(Some(options(None, BEFORE))).expect("unfiltered options"),
        };
        let unfiltered_query =
            build_query(&unfiltered_plan, &engine.fields).expect("unfiltered query");
        assert_eq!(
            searcher
                .search(unfiltered_query.as_ref(), &Count)
                .expect("count"),
            4,
        );

        let mut filter = where_filter();
        filter.types = Some(vec!["Decision".to_owned()]);
        filter.tags_any = Some(vec!["architecture".to_owned()]);
        filter.statuses = Some(vec!["stable".to_owned()]);
        let filtered_plan = QueryPlan {
            terms: tokenize("memory"),
            options: resolve_options(Some(options(Some(filter), BEFORE)))
                .expect("filtered options"),
        };
        let filtered_query = build_query(&filtered_plan, &engine.fields).expect("filtered query");
        assert_eq!(
            searcher
                .search(filtered_query.as_ref(), &Count)
                .expect("count"),
            1,
        );
    }

    #[test]
    fn metadata_filters_do_not_change_text_scores() {
        let engine = fixture_engine();
        let unfiltered = engine
            .search("memory", Some(options(None, BEFORE)))
            .expect("unfiltered search");
        let baseline = unfiltered
            .iter()
            .find(|hit| hit.document_id == "decision")
            .expect("decision hit")
            .score;

        let mut filter = where_filter();
        filter.types = Some(vec!["Decision".to_owned()]);
        filter.tags_any = Some(vec!["architecture".to_owned()]);
        filter.statuses = Some(vec!["stable".to_owned()]);
        filter.trust_tiers = Some(vec!["human-reviewed".to_owned()]);
        filter.conformance = Some(vec!["strict".to_owned()]);
        filter.stale = Some(false);
        let filtered = engine
            .search("memory", Some(options(Some(filter), BEFORE)))
            .expect("filtered search");

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].document_id, "decision");
        assert_eq!(filtered[0].score.to_bits(), baseline.to_bits());
    }

    #[test]
    fn pushed_metadata_terms_follow_replacement_and_removal() {
        let mut engine = fixture_engine();

        let mut old_filter = where_filter();
        old_filter.types = Some(vec!["Decision".to_owned()]);
        old_filter.tags_any = Some(vec!["architecture".to_owned()]);
        old_filter.statuses = Some(vec!["stable".to_owned()]);
        old_filter.trust_tiers = Some(vec!["human-reviewed".to_owned()]);
        assert_eq!(
            result_ids(&engine, Some(old_filter.clone()), BEFORE),
            BTreeSet::from(["decision".to_owned()]),
        );

        engine
            .ingest(document_with_metadata(
                "decision",
                "Guide",
                "strict",
                &["docs", "rust"],
                Some("draft"),
                Some(SECOND_DEADLINE),
                true,
                Some("unverified"),
                vec![section(
                    "decision",
                    "Memory architecture keeps retrieval predictable.",
                )],
            ))
            .expect("replacement should commit");

        assert!(result_ids(&engine, Some(old_filter), BEFORE).is_empty());

        let mut replacement_filter = where_filter();
        replacement_filter.types = Some(vec!["Guide".to_owned()]);
        replacement_filter.tags_any = Some(vec!["rust".to_owned()]);
        replacement_filter.statuses = Some(vec!["draft".to_owned()]);
        replacement_filter.trust_tiers = Some(vec!["unverified".to_owned()]);
        replacement_filter.stale = Some(false);
        assert_eq!(
            result_ids(&engine, Some(replacement_filter.clone()), BEFORE),
            BTreeSet::from(["decision".to_owned()]),
        );

        assert!(engine.remove("decision").expect("remove should commit"));
        assert!(result_ids(&engine, Some(replacement_filter), BEFORE).is_empty());
        assert!(
            !engine
                .remove("decision")
                .expect("repeat removal should be absent")
        );
    }

    #[test]
    fn filter_only_metadata_is_not_readable_from_the_document_store() {
        let engine = fixture_engine();
        let searcher = engine.reader.searcher();
        let query = TermQuery::new(
            Term::from_field_text(engine.fields.body, "memory"),
            IndexRecordOption::WithFreqs,
        );
        let top = searcher
            .search(&query, &TopDocs::with_limit(1).order_by_score())
            .expect("top doc");
        let address = top[0].1;
        let doc = searcher
            .doc::<TantivyDocument>(address)
            .expect("stored document");

        assert!(doc.get_first(engine.fields.type_exact).is_none());
        assert!(doc.get_first(engine.fields.tag_exact).is_none());
        assert!(doc.get_first(engine.fields.status).is_none());
        assert!(doc.get_first(engine.fields.stale_after_epoch).is_none());
        assert!(doc.get_first(engine.fields.staleness_classified).is_none());
        assert!(doc.get_first(engine.fields.trust_tier).is_none());
        assert!(doc.get_first(engine.fields.conformance).is_some());
    }

    fn strict_section(document_id: &str, text: &str) -> PreparedSection {
        section(document_id, text)
    }

    fn search_options(fields: &[&str], match_mode: &str) -> SearchOptions {
        SearchOptions {
            limit: Some(50.0),
            where_filter: None,
            as_of: Some(DateTime::<Utc>::UNIX_EPOCH),
            match_mode: Some(match_mode.to_owned()),
            fields: Some(fields.iter().map(|field| (*field).to_owned()).collect()),
            boost: None,
            fuzzy: None,
        }
    }

    fn assert_invalid(error: EngineError) {
        assert!(
            error
                .to_string()
                .contains("[ERR_OKF_INVALID_PREPARED_DOCUMENT]"),
            "unexpected error: {error}"
        );
    }

    fn count_term(engine: &Engine, field: Field, term: &str) -> usize {
        let query = TermQuery::new(Term::from_field_text(field, term), IndexRecordOption::Basic);
        engine
            .reader
            .searcher()
            .search(&query, &Count)
            .expect("term count")
    }

    #[test]
    fn strict_and_unclassified_staleness_contracts_are_enforced() {
        let mut cases = Vec::new();
        let mut missing_status = document(strict_section("missing-status", "needle"));
        missing_status.status = None;
        cases.push(("missing status", missing_status));
        let mut missing_trust = document(strict_section("missing-trust", "needle"));
        missing_trust.trust_tier = None;
        cases.push(("missing trust", missing_trust));
        let mut unclassified = document(strict_section("unclassified-strict", "needle"));
        unclassified.staleness_classified = false;
        cases.push(("unclassified strict staleness", unclassified));
        cases.push((
            "unclassified deadline",
            document_with_metadata(
                "unclassified-deadline",
                "Note",
                "degraded",
                &[],
                None,
                Some(FIRST_DEADLINE),
                false,
                None,
                vec![section("unclassified-deadline", "needle")],
            ),
        ));

        for (name, invalid) in cases {
            let error = Engine::new(vec![invalid]).err().expect(name);
            assert_invalid(error);
        }

        let classified_degraded = document_with_metadata(
            "classified-degraded",
            "Note",
            "degraded",
            &[],
            Some("draft"),
            Some(FIRST_DEADLINE),
            true,
            Some("unverified"),
            vec![section("classified-degraded", "needle")],
        );
        let unclassified_degraded = document_with_metadata(
            "unclassified-degraded",
            "Note",
            "degraded",
            &[],
            None,
            None,
            false,
            None,
            vec![section("unclassified-degraded", "needle")],
        );
        Engine::new(vec![classified_degraded, unclassified_degraded])
            .expect("valid degraded classifications should remain indexable");
    }

    #[test]
    fn parent_metadata_is_indexed_into_every_section_and_replacement_updates_it() {
        let mut initial = document(strict_section("metadata", "first section text"));
        let mut second = section("metadata", "second section text");
        second.section_id = "metadata#second".to_owned();
        initial.sections.push(second);
        initial.title = "Initial shared title".to_owned();
        initial.tags = vec!["initial-shared".to_owned()];

        let mut engine = Engine::new(vec![initial]).expect("initial document");
        assert_eq!(count_term(&engine, engine.fields.title, "initial"), 2);
        assert_eq!(
            count_term(&engine, engine.fields.tag_exact, "initial-shared"),
            2
        );

        let mut replacement = document(strict_section("metadata", "replacement section text"));
        let mut second = section("metadata", "replacement second section text");
        second.section_id = "metadata#second".to_owned();
        replacement.sections.push(second);
        replacement.title = "Replacement shared title".to_owned();
        replacement.tags = vec!["replacement-shared".to_owned()];
        engine.ingest(replacement).expect("replacement document");

        assert_eq!(count_term(&engine, engine.fields.title, "initial"), 0);
        assert_eq!(count_term(&engine, engine.fields.title, "replacement"), 2);
        assert_eq!(
            count_term(&engine, engine.fields.tag_exact, "replacement-shared"),
            2
        );
    }

    #[test]
    fn invalid_initial_sets_are_rejected_at_the_prepared_boundary() {
        let valid = document(strict_section("valid", "state needle"));
        let mut cases = Vec::new();

        for (name, change) in [
            ("empty documentId", 0),
            ("empty path", 1),
            ("empty type", 2),
            ("invalid conformance", 3),
        ] {
            let mut invalid = valid.clone();
            match change {
                0 => invalid.document_id = " ".to_owned(),
                1 => invalid.path = " ".to_owned(),
                2 => invalid.document_type = "".to_owned(),
                3 => invalid.conformance = "unknown".to_owned(),
                _ => unreachable!(),
            }
            cases.push((name, vec![invalid]));
        }

        let mut strict_diagnostic = valid.clone();
        strict_diagnostic.diagnostics.push(Diagnostic {
            code: "ERR_OKF_FIELD".to_owned(),
            message: "not allowed on strict".to_owned(),
            field: None,
            path: strict_diagnostic.path.clone(),
        });
        cases.push(("strict diagnostics", vec![strict_diagnostic]));

        let mut degraded_without_diagnostics = document_with_metadata(
            "degraded",
            "Note",
            "degraded",
            &[],
            None,
            None,
            false,
            None,
            vec![section("degraded", "state needle")],
        );
        degraded_without_diagnostics.diagnostics.clear();
        cases.push((
            "missing degraded diagnostics",
            vec![degraded_without_diagnostics],
        ));

        for (name, change) in [("diagnostic code", 0), ("diagnostic path", 1)] {
            let mut invalid = document_with_metadata(
                "diagnostic",
                "Note",
                "degraded",
                &[],
                None,
                None,
                false,
                None,
                vec![section("diagnostic", "state needle")],
            );
            if change == 0 {
                invalid.diagnostics[0].code = "ERR_OTHER".to_owned();
            } else {
                invalid.diagnostics[0].path = "other.md".to_owned();
            }
            cases.push((name, vec![invalid]));
        }

        let mut invalid_status = valid.clone();
        invalid_status.status = Some("future".to_owned());
        cases.push(("invalid status", vec![invalid_status]));
        let mut invalid_trust = valid.clone();
        invalid_trust.trust_tier = Some("manual".to_owned());
        cases.push(("invalid trust tier", vec![invalid_trust]));
        let mut invalid_deadline = valid.clone();
        invalid_deadline.stale_after_epoch = Some(f64::NAN);
        cases.push(("invalid staleAfterEpoch", vec![invalid_deadline]));
        let mut fractional_deadline = valid.clone();
        fractional_deadline.stale_after_epoch = Some(FIRST_DEADLINE as f64 + 0.5);
        cases.push(("fractional staleAfterEpoch", vec![fractional_deadline]));
        let mut unclassified_deadline = valid.clone();
        unclassified_deadline.staleness_classified = false;
        unclassified_deadline.stale_after_epoch = Some(FIRST_DEADLINE as f64);
        cases.push(("unclassified staleAfterEpoch", vec![unclassified_deadline]));

        let mut zero_start = valid.clone();
        zero_start.sections[0].start_line = 0.0;
        cases.push(("zero start line", vec![zero_start]));
        let mut reversed_bounds = valid.clone();
        reversed_bounds.sections[0].start_line = 3.0;
        reversed_bounds.sections[0].end_line = 2.0;
        cases.push(("reversed line bounds", vec![reversed_bounds]));
        let mut repeated = valid.clone();
        repeated.sections.push(repeated.sections[0].clone());
        cases.push(("repeated section id", vec![repeated]));

        let duplicate_document = {
            let mut other = valid.clone();
            other.path = "other.md".to_owned();
            vec![valid.clone(), other]
        };
        cases.push(("duplicate document ownership", duplicate_document));
        let duplicate_path = {
            let mut other = document(strict_section("other", "state needle"));
            other.path = valid.path.clone();
            vec![valid.clone(), other]
        };
        cases.push(("duplicate path ownership", duplicate_path));
        let duplicate_section = {
            let mut other = document(strict_section("other", "state needle"));
            other.sections[0].section_id = valid.sections[0].section_id.clone();
            vec![valid.clone(), other]
        };
        cases.push(("duplicate section ownership", duplicate_section));

        for (name, documents) in cases {
            let error = Engine::new(documents).err().expect(name);
            assert_invalid(error);
        }
    }

    #[test]
    fn rejected_ingest_keeps_search_and_inventory_unchanged() {
        let baseline = vec![
            document(strict_section("first", "baseline needle")),
            document(strict_section("second", "baseline needle")),
        ];
        let baseline_ids = BTreeSet::from(["first".to_owned(), "second".to_owned()]);

        let mut invalid_status = document(strict_section("new-status-value", "new needle"));
        invalid_status.status = Some("future".to_owned());
        let mut diagnostics = document(strict_section("new-diagnostic", "new needle"));
        diagnostics.diagnostics.push(Diagnostic {
            code: "ERR_OKF_FIELD".to_owned(),
            message: "invalid strict diagnostic".to_owned(),
            field: None,
            path: diagnostics.path.clone(),
        });
        let mut bounds = document(strict_section("new-bounds", "new needle"));
        bounds.sections[0].end_line = 0.0;
        let mut repeated = document(strict_section("new-repeat", "new needle"));
        repeated.sections.push(repeated.sections[0].clone());
        let mut missing_status = document(strict_section("new-status", "new needle"));
        missing_status.status = None;
        let mut missing_trust = document(strict_section("new-trust", "new needle"));
        missing_trust.trust_tier = None;
        let mut unclassified = document(strict_section("new-staleness", "new needle"));
        unclassified.staleness_classified = false;
        let unclassified_deadline = document_with_metadata(
            "new-deadline",
            "Note",
            "degraded",
            &[],
            None,
            Some(FIRST_DEADLINE),
            false,
            None,
            vec![section("new-deadline", "new needle")],
        );
        let mut path_conflict = document(strict_section("new-path", "new needle"));
        path_conflict.path = "first.md".to_owned();
        let mut section_conflict = document(strict_section("new-section", "new needle"));
        section_conflict.sections[0].section_id = "first#root".to_owned();
        let mut replacement_conflict = document(strict_section("first", "new needle"));
        replacement_conflict.path = "changed.md".to_owned();

        for (name, invalid) in [
            ("invalid status", invalid_status),
            ("diagnostics", diagnostics),
            ("line bounds", bounds),
            ("repeated section id", repeated),
            ("missing strict status", missing_status),
            ("missing strict trust", missing_trust),
            ("unclassified strict staleness", unclassified),
            ("unclassified staleAfterEpoch", unclassified_deadline),
            ("path ownership", path_conflict),
            ("section ownership", section_conflict),
            ("replacement ownership", replacement_conflict),
        ] {
            let mut engine = Engine::new(baseline.clone()).expect("baseline");
            let error = engine.ingest(invalid).expect_err(name);
            assert_invalid(error);
            let ids: BTreeSet<String> = engine
                .search("baseline", Some(search_options(&["body"], "any")))
                .expect("baseline search")
                .into_iter()
                .map(|hit| hit.document_id)
                .collect();
            assert_eq!(ids, baseline_ids, "search state changed after {name}");
            assert_eq!(engine.list_types().expect("inventory"), vec!["Note"]);
            assert!(
                engine
                    .list_degraded()
                    .expect("degraded inventory")
                    .is_empty()
            );
        }
    }

    fn assert_napi_unusable<T>(result: NapiResult<T>) {
        let error = match result {
            Ok(_) => panic!("operation unexpectedly succeeded"),
            Err(error) => error,
        };
        assert!(
            error.reason.starts_with("[ERR_OKF_INDEX_UNUSABLE]"),
            "unexpected error: {}",
            error.reason
        );
    }

    fn add_record_without_title(engine: &mut Engine) {
        let mut doc = TantivyDocument::default();
        doc.add_text(engine.fields.section_id, "corrupt#root");
        doc.add_text(engine.fields.document_id, "corrupt");
        doc.add_text(engine.fields.conformance, "strict");
        doc.add_text(engine.fields.path, "corrupt.md");
        doc.add_text(engine.fields.heading, "Corrupt");
        doc.add_text(engine.fields.body, "corruptneedle");
        doc.add_u64(engine.fields.start_line, 1);
        doc.add_u64(engine.fields.end_line, 1);
        engine
            .writer
            .add_document(doc)
            .expect("corrupt fixture should stage");
        engine.commit("corrupt fixture").expect("fixture commit");
    }

    #[test]
    fn missing_or_wrong_stored_fields_are_private_invariant_errors() {
        let (_, fields) = schema();
        let mut doc = TantivyDocument::default();

        assert!(matches!(
            required_text(&doc, fields.title, "title"),
            Err(EngineError::StoredInvariant(_))
        ));

        doc.add_u64(fields.title, 1);
        assert!(matches!(
            required_text(&doc, fields.title, "title"),
            Err(EngineError::StoredInvariant(_))
        ));
    }

    #[test]
    fn stored_record_invariant_failure_poisons_every_later_native_operation() {
        let native = NativeOkfSearch::from_prepared(vec![document(strict_section(
            "first",
            "healthy needle",
        ))])
        .expect("baseline");
        add_record_without_title(&mut native.inner.lock());

        assert_napi_unusable(native.search("corruptneedle".to_owned(), None));
        assert_napi_unusable(native.search("healthy".to_owned(), None));
        assert_napi_unusable(native.index_stats());
        assert_napi_unusable(native.list_types());
        assert_napi_unusable(native.list_degraded_documents());
        assert_napi_unusable(native.auto_suggest("healthy".to_owned(), None));
        assert_napi_unusable(native.ingest_prepared(document(strict_section("second", "healthy"))));
        assert_napi_unusable(native.remove_document("first".to_owned()));
    }

    #[test]
    fn search_option_and_query_failures_do_not_poison_the_engine() {
        let engine = Engine::new(vec![document(strict_section("first", "healthy needle"))])
            .expect("baseline");

        let mut invalid = search_options(&["body"], "any");
        invalid.match_mode = Some("invalid".to_owned());
        let error = engine
            .search("healthy", Some(invalid))
            .expect_err("invalid options");
        assert!(error.reason.starts_with("[ERR_OKF_INVALID_SEARCH_OPTIONS]"));
        assert!(engine.poisoned.lock().is_none());

        engine
            .query_results
            .lock()
            .push_back(Err(tantivy::TantivyError::InvalidArgument(
                "query failed".to_owned(),
            )));
        let error = engine
            .search("healthy", Some(search_options(&["body"], "any")))
            .expect_err("query failure");
        assert!(error.reason.starts_with("[ERR_OKF_NATIVE]"));
        assert!(engine.poisoned.lock().is_none());

        assert_eq!(engine.list_types().expect("still usable"), ["Note"]);
        assert_eq!(
            engine
                .search("healthy", Some(search_options(&["body"], "any")))
                .expect("later search")
                .len(),
            1
        );
    }

    #[test]
    fn count_verification_errors_follow_the_mutation_lifecycle() {
        let count_error = || tantivy::TantivyError::InvalidArgument("count failed".to_owned());

        let mut precommit = Engine::new(vec![document(strict_section("first", "needle"))])
            .expect("precommit baseline");
        precommit.count_results.push_back(Err(count_error()));
        let error = precommit
            .ingest(document(strict_section("second", "needle")))
            .expect_err("precommit count error");
        assert!(matches!(error, EngineError::Tantivy(_)));
        assert!(precommit.poisoned.lock().is_none());
        assert_eq!(precommit.list_types().expect("still usable"), ["Note"]);
        assert!(
            precommit
                .search("needle", Some(search_options(&["body"], "any")))
                .expect("unchanged search")
                .iter()
                .all(|hit| hit.document_id == "first")
        );

        let mut ingest = Engine::new(vec![document(strict_section("first", "needle"))])
            .expect("ingest baseline");
        ingest.count_results.push_back(Ok(0));
        ingest.count_results.push_back(Err(count_error()));
        let error = ingest
            .ingest(document(strict_section("second", "needle")))
            .expect_err("post-commit count error");
        assert!(matches!(error, EngineError::Poisoned(_)));
        assert!(matches!(ingest.list_types(), Err(EngineError::Poisoned(_))));

        let mut remove = Engine::new(vec![document(strict_section("first", "needle"))])
            .expect("remove baseline");
        remove.count_results.push_back(Ok(1));
        remove.count_results.push_back(Ok(1));
        let error = remove
            .remove("first")
            .expect_err("post-commit count mismatch");
        assert!(matches!(error, EngineError::Poisoned(_)));
        assert!(matches!(remove.list_types(), Err(EngineError::Poisoned(_))));
    }

    #[test]
    fn text_options_change_retrieval_and_ranking() {
        let mut both = document(strict_section("both", "alpha beta"));
        both.title = "plain".to_owned();
        let mut alpha = document(strict_section("alpha", "alpha"));
        alpha.title = "plain".to_owned();
        let engine = Engine::new(vec![both, alpha]).expect("engine");
        assert_eq!(
            engine
                .search("alpha beta", Some(search_options(&["body"], "any")))
                .expect("any")
                .len(),
            2
        );
        assert_eq!(
            engine
                .search("alpha beta", Some(search_options(&["body"], "all")))
                .expect("all")[0]
                .document_id,
            "both"
        );

        let mut cross_field = document(strict_section("cross-field", "beta"));
        cross_field.title = "alpha".to_owned();
        let cross_field = Engine::new(vec![cross_field]).expect("cross-field engine");
        assert_eq!(
            cross_field
                .search(
                    "alpha beta",
                    Some(search_options(&["title", "body"], "all")),
                )
                .expect("cross-field all")
                .len(),
            1
        );

        let mut title_hit = document(strict_section("title-hit", "plain body"));
        title_hit.title = "exclusive needle".to_owned();
        let fields = Engine::new(vec![title_hit]).expect("fields engine");
        assert_eq!(
            fields
                .search("exclusive", Some(search_options(&["title"], "any")))
                .expect("included field")
                .len(),
            1
        );
        assert!(
            fields
                .search("exclusive", Some(search_options(&["body"], "any")))
                .expect("excluded field")
                .is_empty()
        );

        let mut title_rank = document(strict_section("title-rank", "plain"));
        title_rank.title = "rankneedle".to_owned();
        let mut body_rank = document(strict_section("body-rank", "rankneedle"));
        body_rank.title = "plain".to_owned();
        let ranking = Engine::new(vec![title_rank, body_rank]).expect("ranking");
        let default = ranking
            .search(
                "rankneedle",
                Some(search_options(&["title", "body"], "any")),
            )
            .expect("default ranking");
        assert_eq!(default[0].document_id, "title-rank");
        let mut boosted = search_options(&["title", "body"], "any");
        boosted.boost = Some(SearchBoost {
            resource: None,
            title: Some(0.1),
            heading: None,
            description: None,
            tags: None,
            document_type: None,
            sources: None,
            body: Some(10.0),
        });
        let boosted = ranking
            .search("rankneedle", Some(boosted))
            .expect("boosted ranking");
        assert_eq!(boosted[0].document_id, "body-rank");
    }

    #[test]
    fn matched_fields_handles_nonmatching_probes_after_removal() {
        let mut kept = document(strict_section("kept", "a md inventoryneedle"));
        kept.title = "kept".to_owned();
        let removed = document(strict_section("removed", "nested removedneedle"));
        let mut engine = Engine::new(vec![kept, removed]).expect("engine");

        assert!(engine.remove("removed").expect("remove"));

        let hits = engine
            .search(
                "a nested md",
                Some(search_options(
                    &[
                        "resource",
                        "title",
                        "heading",
                        "description",
                        "tags",
                        "type",
                        "sources",
                        "body",
                    ],
                    "any",
                )),
            )
            .expect("search after removal");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].document_id, "kept");
        assert_eq!(hits[0].matched_fields, vec!["body"]);
    }

    #[test]
    fn prefix_fuzzy_matched_fields_and_snippets_use_production_search() {
        let mut value = document(strict_section(
            "search-contract",
            "alpha architecture retrieval",
        ));
        value.title = "alpha architecture retrieval".to_owned();
        value.description = "alpha architecture retrieval".to_owned();
        let engine = Engine::new(vec![value]).expect("engine");

        assert_eq!(
            engine
                .search("arc", Some(search_options(&["body"], "any")))
                .expect("three character prefix")
                .len(),
            1
        );
        assert!(
            engine
                .search("ar", Some(search_options(&["body"], "any")))
                .expect("short prefix guard")
                .is_empty()
        );
        assert!(
            engine
                .search("arc alpha", Some(search_options(&["body"], "all")))
                .expect("non-final prefix guard")
                .is_empty()
        );

        let mut fuzzy = search_options(&["body"], "any");
        fuzzy.fuzzy = Some(Either::A(false));
        assert!(
            engine
                .search("rexxieval", Some(fuzzy))
                .expect("fuzzy off")
                .is_empty()
        );
        let mut fuzzy = search_options(&["body"], "any");
        fuzzy.fuzzy = Some(Either::A(true));
        assert_eq!(
            engine
                .search("rexrieval", Some(fuzzy))
                .expect("fuzzy on")
                .len(),
            1
        );
        let mut fuzzy = search_options(&["body"], "any");
        fuzzy.fuzzy = Some(Either::B(0.1));
        assert!(
            engine
                .search("rexxieval", Some(fuzzy))
                .expect("distance one")
                .is_empty()
        );
        let mut fuzzy = search_options(&["body"], "any");
        fuzzy.fuzzy = Some(Either::B(0.2));
        assert_eq!(
            engine
                .search("rexxieval", Some(fuzzy))
                .expect("distance two")
                .len(),
            1
        );

        let hit = engine
            .search(
                "retrieval",
                Some(search_options(&["title", "description", "body"], "any")),
            )
            .expect("matched fields")
            .remove(0);
        assert_eq!(hit.matched_fields, ["title", "description", "body"]);

        let long_text = format!("{} exactsnippet {}", "x".repeat(190), "y".repeat(190));
        let snippet_engine = Engine::new(vec![document(strict_section("snippet", &long_text))])
            .expect("snippet engine");
        let snippet = &snippet_engine
            .search("exactsnippet", Some(search_options(&["body"], "any")))
            .expect("snippet search")[0]
            .snippet;
        assert!(snippet.contains("exactsnippet"));
        assert!(snippet.starts_with('…') && snippet.ends_with('…'));
        assert!(snippet.len() <= 246, "snippet was {} bytes", snippet.len());
    }

    #[test]
    fn collapse_ties_and_adaptive_overfetch_use_production_code() {
        let record = |document_id: &str, section_id: &str, conformance: &str| Record {
            address: DocAddress::new(0, 0),
            document_id: document_id.to_owned(),
            title: String::new(),
            section_id: section_id.to_owned(),
            conformance: conformance.to_owned(),
            heading_path: String::new(),
            path: String::new(),
            start_line: 1,
            end_line: 1,
            text: String::new(),
        };
        let collapsed = collapse(vec![
            Candidate {
                score: 1.0,
                record: record("same", "z", "degraded"),
            },
            Candidate {
                score: 1.0,
                record: record("same", "y", "strict"),
            },
            Candidate {
                score: 1.0,
                record: record("same", "a", "strict"),
            },
            Candidate {
                score: 2.0,
                record: record("higher", "higher", "degraded"),
            },
        ]);
        assert_eq!(
            collapsed
                .iter()
                .map(|candidate| candidate.record.section_id.as_str())
                .collect::<Vec<_>>(),
            ["higher", "a"]
        );

        let mut crowded = document(strict_section("crowded", "crowdterm crowdterm"));
        crowded.sections = (0..40)
            .map(|index| {
                let mut section = crowded.sections[0].clone();
                section.section_id = format!("crowded#{index:02}");
                section.heading_path = format!("Section {index}");
                section.start_line = index as f64 + 1.0;
                section.end_line = index as f64 + 1.0;
                section
            })
            .collect();
        let other = document(strict_section("other", "crowdterm"));
        let engine = Engine::new(vec![crowded, other]).expect("crowded engine");
        let mut options = search_options(&["body"], "any");
        options.limit = Some(2.0);
        let hits = engine
            .search("crowdterm", Some(options))
            .expect("adaptive search");
        assert_eq!(
            hits.iter()
                .map(|hit| hit.document_id.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["crowded", "other"])
        );
    }
}
