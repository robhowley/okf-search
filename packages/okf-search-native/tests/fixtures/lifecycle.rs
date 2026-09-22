//! Only JS lifecycle failure/race tests use these hooks. Never shipped.
use crate::*;
use parking_lot::Condvar;
use std::time::{Duration, Instant};

#[derive(Default)]
pub(crate) struct Hooks {
    state: Mutex<HooksState>,
    changed: Condvar,
}
#[derive(Default)]
struct HooksState {
    failures: BTreeSet<String>,
    pause: Option<String>,
    reached: bool,
    events: Vec<String>,
}
impl Hooks {
    pub(crate) fn fail(&self, point: &str) -> bool {
        self.state.lock().failures.remove(point)
    }
    pub(crate) fn event(&self, point: &str) {
        let mut state = self.state.lock();
        state.events.push(format!(
            "{point}:{}",
            std::thread::current().name().unwrap_or("caller")
        ));
        if state.pause.as_deref() == Some(point) {
            state.reached = true;
            self.changed.notify_all();
            let deadline = Instant::now() + Duration::from_secs(20);
            while state.pause.is_some() {
                let remaining = deadline.saturating_duration_since(Instant::now());
                assert!(
                    !remaining.is_zero(),
                    "lifecycle barrier timed out at {point}"
                );
                self.changed.wait_for(&mut state, remaining);
            }
        }
    }
}

#[napi]
pub fn lifecycle_fixture(handle: &NativeOkfSearch, action: String) -> Vec<String> {
    let hooks = &handle.inner.hooks;
    let mut state = hooks.state.lock();
    if let Some(point) = action.strip_prefix("fail:") {
        state.failures.insert(point.into());
    }
    if let Some(point) = action.strip_prefix("pause:") {
        state.pause = Some(point.into());
        state.reached = false;
    }
    if action == "release" {
        state.pause = None;
        hooks.changed.notify_all();
    }
    if action == "wait" {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !state.reached {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "lifecycle wait timed out");
            hooks.changed.wait_for(&mut state, remaining);
        }
    }
    state.events.clone()
}

type Registry = Mutex<BTreeMap<String, std::sync::Weak<lifecycle::HandleState>>>;
static HANDLES: std::sync::OnceLock<Registry> = std::sync::OnceLock::new();

#[napi]
pub fn lifecycle_mapped_fixture() -> NapiResult<NativeOkfSearch> {
    let engine = Engine::new_with_storage(vec![], StorageMode::Mmap).map_err(native_error)?;
    let workspace = engine
        .workspace
        .as_ref()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let inner = lifecycle::HandleState::new(engine);
    HANDLES
        .get_or_init(Default::default)
        .lock()
        .insert(workspace, std::sync::Arc::downgrade(&inner));
    Ok(NativeOkfSearch { inner })
}

/// Release a held native worker after the JS environment owning its handle died.
#[napi]
pub fn lifecycle_release_workspace_fixture(workspace: String) {
    let handle = HANDLES
        .get()
        .unwrap()
        .lock()
        .remove(&workspace)
        .unwrap()
        .upgrade()
        .unwrap();
    handle.hooks.state.lock().pause = None;
    handle.hooks.changed.notify_all();
}

#[napi]
pub fn lifecycle_workspace_fixture(handle: &NativeOkfSearch) -> NapiResult<String> {
    Ok(handle
        .inner
        .admit()?
        .workspace
        .as_ref()
        .unwrap()
        .to_string_lossy()
        .into_owned())
}
