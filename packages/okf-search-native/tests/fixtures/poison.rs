use super::*;

// Only the fixture build exports this factory; production handles cannot be faulted.
#[napi(js_name = "createPoisonedSearchFixture")]
pub fn create_poisoned_search_fixture() -> NapiResult<NativeOkfSearch> {
    let handle = NativeOkfSearch::from_prepared(vec![])?;
    let _ = handle.inner.lock().poison::<()>("test fixture failure");
    Ok(handle)
}
