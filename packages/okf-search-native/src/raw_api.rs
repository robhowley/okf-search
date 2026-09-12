use napi::bindgen_prelude::{AsyncTask, JsObjectValue, Object, ToNapiValue, Unknown, Utf16String};
use napi::{Env, Error, Result, Task};
use okf_prepare_core::{self as core, Prepared};
use parking_lot::Mutex;

use crate::preparation::{self, Identity, PreparationError, PreparedEntry};
use crate::{Engine, NativeOkfSearch, native_error};

pub(super) fn invalid(code: &'static str, path: &str, field: Option<&str>) -> PreparationError {
    PreparationError {
        code,
        path: path.into(),
        field: field.map(Into::into),
        cause: None,
        diagnostics: vec![],
    }
}

pub(super) fn decode(
    value: &Utf16String,
    code: &'static str,
    path: &str,
    field: Option<&str>,
) -> std::result::Result<String, PreparationError> {
    String::from_utf16(value).map_err(|_| invalid(code, path, field))
}

pub(super) fn preparation_error(env: &Env, error: PreparationError) -> Error {
    let value = (|| -> Result<Unknown<'_>> {
        let mut value = env.create_error(Error::new(
            napi::Status::GenericFailure,
            format!("[{}] {error}", error.code),
        ))?;
        value.set("code", error.code)?;
        value.set("path", error.path)?;
        if let Some(field) = error.field {
            value.set("field", field)?;
        }
        if let Some(cause) = error.cause {
            value.set("cause", cause.to_string())?;
        }
        value.set("diagnostics", project_diagnostics(env, error.diagnostics)?)?;
        value.into_unknown(env)
    })();
    match value {
        Ok(value) => Error::from(value),
        Err(error) => error,
    }
}

pub(super) fn snapshot(input: Object<'_>) -> Result<(Utf16String, Utf16String)> {
    let path = input.get_named_property("path")?;
    let markdown = input.get_named_property("markdown")?;
    Ok((path, markdown))
}

pub(super) fn identity(path: Utf16String) -> std::result::Result<Identity, PreparationError> {
    preparation::normalize_identity(&decode(&path, "ERR_OKF_FIELD", "<input>", Some("path"))?)
}

pub(super) fn prepare(
    input: (Utf16String, Utf16String),
) -> std::result::Result<PreparedEntry, PreparationError> {
    let identity = identity(input.0)?;
    let markdown = decode(&input.1, "ERR_OKF_PARSE", &identity.path, None)?;
    preparation::prepare_normalized(identity, &markdown)
}

pub(super) fn validate_raw(env: Env, input: Object<'_>) -> Result<Object<'static>> {
    let outcome = prepare(snapshot(input)?);
    let mut value = Object::new(&env)?;
    let (valid, indexable, diagnostics) = match outcome {
        Ok(PreparedEntry {
            prepared: Prepared::Accepted { diagnostics, .. },
            ..
        }) => (diagnostics.is_empty(), true, diagnostics),
        Ok(_) => unreachable!(),
        Err(mut error) => {
            if error.diagnostics.is_empty() {
                error.diagnostics.push(core::Diagnostic {
                    code: error.code,
                    message: error.to_string(),
                    path: error.path,
                    field: error.field,
                });
            }
            (false, false, error.diagnostics)
        }
    };
    value.set("isValid", valid)?;
    value.set("isIndexable", indexable)?;
    value.set("errors", project_diagnostics(&env, diagnostics)?)?;
    Ok(value)
}

pub struct OpenTask {
    root: Utf16String,
}
impl Task for OpenTask {
    type Output = std::result::Result<NativeOkfSearch, PreparationError>;
    type JsValue = NativeOkfSearch;
    fn compute(&mut self) -> Result<Self::Output> {
        let root = match decode(&self.root, "ERR_OKF_FIELD", "<input>", Some("path")) {
            Ok(root) => root,
            Err(error) => return Ok(Err(error)),
        };
        let entries = match crate::filesystem::prepare_directory(std::path::Path::new(&root)) {
            Ok(entries) => entries,
            Err(error) => return Ok(Err(error)),
        };
        let documents = entries
            .into_iter()
            .map(PreparedEntry::into_document)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(native_error)?;
        let engine = Engine::new(documents).map_err(native_error)?;
        Ok(Ok(NativeOkfSearch {
            inner: Mutex::new(engine),
        }))
    }
    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        output.map_err(|error| preparation_error(&env, error))
    }
    fn reject(&mut self, _env: Env, error: Error) -> Result<Self::JsValue> {
        Err(error)
    }
}

pub(super) fn open_raw(root: Utf16String) -> AsyncTask<OpenTask> {
    AsyncTask::new(OpenTask { root })
}

pub(super) fn ingest_result(env: &Env, entry: &PreparedEntry) -> Result<Object<'static>> {
    let Prepared::Accepted {
        fields,
        body,
        conformance,
        diagnostics,
        document_id,
        ..
    } = &entry.prepared
    else {
        unreachable!()
    };
    let mut result = Object::new(env)?;
    result.set("conformance", conformance.as_str())?;
    if conformance.as_str() == "strict" {
        let mut document = project_fields(env, fields.clone())?;
        document.set("id", document_id.clone())?;
        document.set("body", body.clone())?;
        result.set("document", document)?;
    } else {
        result.set("documentId", document_id.clone())?;
        result.set("path", entry.identity.path.clone())?;
        result.set(
            "diagnostics",
            project_diagnostics(env, diagnostics.clone())?,
        )?;
    }
    Ok(result)
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
    value.set(
        "extensions",
        yaml_value(env, core::yaml::YamlOwned::Mapping(fields.extensions))?,
    )?;
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
    if let Some(status) = fields.status {
        value.set("status", status.as_str())?;
    }
    if let Some(stale) = fields.stale_after {
        value.set("staleAfter", stale.value)?;
    }
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

fn yaml_value<'a>(env: &'a Env, value: core::yaml::YamlOwned) -> Result<Unknown<'a>> {
    use core::yaml::YamlOwned;
    match value {
        YamlOwned::Null => napi::bindgen_prelude::Null.into_unknown(env),
        YamlOwned::Boolean(value) => value.into_unknown(env),
        YamlOwned::Integer(value) => (value as f64).into_unknown(env),
        YamlOwned::Float(value) => value.into_unknown(env),
        YamlOwned::String(value) => value.into_unknown(env),
        YamlOwned::Tagged { value, .. } => yaml_value(env, *value),
        YamlOwned::Sequence(values) => values
            .into_iter()
            .map(|value| yaml_value(env, value))
            .collect::<Result<Vec<_>>>()?
            .into_unknown(env),
        YamlOwned::Mapping(entries) => {
            let mut object = Object::new(env)?;
            for (key, value) in entries {
                let value = yaml_value(env, value)?;
                object.define_properties(&[napi::Property::new()
                    .with_name(env, key)?
                    .with_value(&value)
                    .with_property_attributes(
                        napi::PropertyAttributes::Writable
                            | napi::PropertyAttributes::Enumerable
                            | napi::PropertyAttributes::Configurable,
                    )])?;
            }
            object.into_unknown(env)
        }
    }
}

pub(super) fn mutation_error(env: &Env, error: crate::EngineError, path: &str) -> Error {
    let value = (|| -> Result<Unknown<'_>> {
        let mut value = env.create_error(native_error(error))?;
        value.set("path", path)?;
        value.into_unknown(env)
    })();
    match value {
        Ok(value) => Error::from(value),
        Err(error) => error,
    }
}
