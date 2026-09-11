use napi::bindgen_prelude::Object;
use napi::{Env, Error, Result, Status};
use napi_derive::napi;
use okf_prepare_core::{self as core, Input, Prepared};

#[napi(object, object_to_js = false)]
pub struct PrepareInput {
    pub path: String,
    pub document_id: String,
    pub fallback_title: String,
    pub markdown: String,
}

impl PrepareInput {
    fn core_input(&self) -> Input<'_> {
        Input {
            path: &self.path,
            markdown: &self.markdown,
            fallback_title: &self.fallback_title,
        }
    }
}

#[napi]
pub fn prepare(env: Env, input: PrepareInput) -> Result<Object<'static>> {
    let mut result = Object::new(&env)?;
    match core::prepare(input.core_input(), &input.document_id) {
        Prepared::Fatal { diagnostics } => {
            result.set("kind", "fatal")?;
            result.set("diagnostics", project_diagnostics(&env, diagnostics)?)?;
        }
        Prepared::Accepted {
            document_id,
            fields,
            body,
            body_start_line,
            conformance,
            diagnostics,
            sections,
        } => {
            result.set("kind", "accepted")?;
            let mut identity = Object::new(&env)?;
            identity.set("path", input.path)?;
            identity.set("documentId", document_id)?;
            result.set("identity", identity)?;
            result.set("conformance", conformance.as_str())?;
            result.set("fields", project_fields(&env, fields)?)?;
            result.set("body", body)?;
            result.set("bodyStartLine", line_number(body_start_line)?)?;
            result.set("diagnostics", project_diagnostics(&env, diagnostics)?)?;
            let sections = sections
                .into_iter()
                .map(|section| {
                    let mut value = Object::new(&env)?;
                    value.set("id", section.id)?;
                    value.set("headingPath", section.heading_path)?;
                    value.set("text", section.text)?;
                    value.set("startLine", line_number(section.start_line)?)?;
                    value.set("endLine", line_number(section.end_line)?)?;
                    Ok(value)
                })
                .collect::<Result<Vec<_>>>()?;
            result.set("sections", sections)?;
        }
    }
    Ok(result)
}

#[napi]
pub fn validate(env: Env, input: PrepareInput) -> Result<Object<'static>> {
    let validation = core::validate(input.core_input());
    let mut result = Object::new(&env)?;
    result.set("isValid", validation.is_valid)?;
    result.set("isIndexable", validation.is_indexable)?;
    result.set("errors", project_diagnostics(&env, validation.errors)?)?;
    Ok(result)
}

fn line_number(line: usize) -> Result<f64> {
    if line as u128 > 9_007_199_254_740_991 {
        return Err(Error::new(
            Status::GenericFailure,
            "Line exceeds JavaScript safe integer range",
        ));
    }
    Ok(line as f64)
}

fn project_diagnostics(
    env: &Env,
    diagnostics: Vec<core::Diagnostic>,
) -> Result<Vec<Object<'static>>> {
    diagnostics
        .into_iter()
        .map(|diagnostic| {
            let mut value = Object::new(env)?;
            value.set("code", diagnostic.code)?;
            value.set("message", diagnostic.message)?;
            value.set("path", diagnostic.path)?;
            if let Some(field) = diagnostic.field {
                value.set("field", field)?;
            }
            Ok(value)
        })
        .collect()
}

fn project_fields(env: &Env, fields: core::ProjectedFields) -> Result<Object<'static>> {
    let mut value = Object::new(env)?;
    value.set("type", fields.type_)?;
    value.set("title", fields.title)?;
    if let Some(description) = fields.description {
        value.set("description", description)?;
    }
    if let Some(resource) = fields.resource {
        value.set("resource", resource)?;
    }
    value.set("tags", fields.tags)?;
    let sources = fields
        .sources
        .into_iter()
        .map(|source| {
            let mut value = Object::new(env)?;
            value.set("resource", source.resource)?;
            if let Some(id) = source.id {
                value.set("id", id)?;
            }
            if let Some(title) = source.title {
                value.set("title", title)?;
            }
            if let Some(author) = source.author {
                value.set("author", author)?;
            }
            if let Some(usage_count) = source.usage_count {
                value.set("usageCount", usage_count)?;
            }
            if let Some(last_modified) = source.last_modified {
                value.set("lastModified", last_modified)?;
            }
            if let Some(window) = source.usage_window {
                value.set("usageWindow", time_window(env, window)?)?;
            }
            Ok(value)
        })
        .collect::<Result<Vec<_>>>()?;
    value.set("sources", sources)?;
    value.set("sourceText", fields.source_text)?;
    if let Some(window) = fields.usage_window {
        value.set("usageWindow", time_window(env, window)?)?;
    }
    if let Some(generated) = fields.generated {
        let mut generation = Object::new(env)?;
        generation.set("by", generated.by)?;
        if let Some(at) = generated.at {
            generation.set("at", at)?;
        }
        value.set("generated", generation)?;
    }
    let verified = fields
        .verified
        .into_iter()
        .map(|event| {
            let mut value = Object::new(env)?;
            value.set("by", event.by)?;
            value.set("at", event.at)?;
            Ok(value)
        })
        .collect::<Result<Vec<_>>>()?;
    value.set("verified", verified)?;
    if let Some(tier) = fields.trust_tier {
        value.set("trustTier", tier.as_str())?;
    }
    if let Some(status) = fields.status {
        value.set("status", status.as_str())?;
    }
    if let Some(stale) = fields.stale_after {
        value.set("staleAfter", stale_after(env, stale)?)?;
    }
    let mut staleness = Object::new(env)?;
    staleness.set("classified", fields.staleness.classified)?;
    if let Some(stale) = fields.staleness.stale_after {
        staleness.set("staleAfter", stale_after(env, stale)?)?;
    }
    value.set("staleness", staleness)?;
    if let Some(runtime) = fields.runtime {
        value.set("runtime", runtime)?;
    }
    if let Some(parameters) = fields.parameters {
        let parameters = parameters
            .into_iter()
            .map(|parameter| {
                let mut value = Object::new(env)?;
                value.set("name", parameter.name)?;
                value.set("type", parameter.type_)?;
                value.set("required", parameter.required)?;
                Ok(value)
            })
            .collect::<Result<Vec<_>>>()?;
        value.set("parameters", parameters)?;
    }
    if let Some(computation) = fields.computation {
        value.set("computation", computation)?;
    }
    if let Some(executor) = fields.executor {
        let mut object = Object::new(env)?;
        object.set("resource", executor.resource)?;
        object.set("receipt", executor.receipt)?;
        value.set("executor", object)?;
    }
    if let Some(attester) = fields.attester {
        let mut object = Object::new(env)?;
        object.set("resource", attester.resource)?;
        value.set("attester", object)?;
    }
    Ok(value)
}

fn time_window(env: &Env, window: core::fields::TimeWindow) -> Result<Object<'static>> {
    let mut value = Object::new(env)?;
    value.set("from", window.from)?;
    value.set("to", window.to)?;
    Ok(value)
}

fn stale_after(env: &Env, stale: core::fields::StaleAfter) -> Result<Object<'static>> {
    let mut value = Object::new(env)?;
    value.set("value", stale.value)?;
    // The core accepts four-digit years; epoch milliseconds fit exactly in a JS number.
    value.set("epochMillis", stale.epoch_millis as f64)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::line_number;

    #[test]
    fn lines_are_numbers_without_truncation() {
        assert_eq!(line_number(0).unwrap(), 0.0);
        if let Ok(line) = usize::try_from(4_294_967_296_u64) {
            assert_eq!(line_number(line).unwrap(), 4_294_967_296.0);
        }
        if let Ok(line) = usize::try_from(9_007_199_254_740_991_u64) {
            assert_eq!(line_number(line).unwrap(), 9_007_199_254_740_991.0);
            assert!(line_number(line + 1).is_err());
        }
    }
}
