//! The handle owns admission and save draining; workers own detached jobs/teardown.
#[cfg(test)]
#[path = "../tests/fixtures/lifecycle_state.rs"]
mod tests;
use super::*;
use parking_lot::{MappedMutexGuard, MutexGuard};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

type Resolver = Box<dyn FnOnce(Env) -> NapiResult<()> + Send>;
type Deferred = napi::JsDeferred<(), Resolver>;
type CloseResult = std::result::Result<(), shutdown::ShutdownError>;

enum State {
    Open {
        engine: Engine,
        saving: bool,
    },
    ClosingAfterSave {
        engine: Engine,
        waiters: Vec<Deferred>,
    },
    ClosingTeardown {
        waiters: Vec<Deferred>,
    },
    Closed {
        result: CloseResult,
    },
}

struct SavePermit(Option<Arc<HandleState>>);
impl SavePermit {
    fn complete(mut self, settle: impl FnOnce()) {
        self.0.take().unwrap().finish_save(settle);
    }
}
impl Drop for SavePermit {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            handle.finish_save(|| {});
        }
    }
}

pub(super) struct HandleState {
    state: Mutex<State>,
    #[cfg(feature = "test-fixtures")]
    pub(crate) hooks: crate::lifecycle_fixture::Hooks,
}
impl HandleState {
    pub(super) fn new(engine: Engine) -> Arc<Self> {
        Arc::new(Self {
            #[cfg(feature = "test-fixtures")]
            hooks: Default::default(),
            state: Mutex::new(State::Open {
                engine,
                saving: false,
            }),
        })
    }
    pub(super) fn admit(&self) -> NapiResult<MappedMutexGuard<'_, Engine>> {
        MutexGuard::try_map(self.state.lock(), |state| match state {
            State::Open { engine, .. } => Some(engine),
            _ => None,
        })
        .map_err(|_| {
            Error::new(
                Status::GenericFailure,
                "[ERR_OKF_INDEX_CLOSED] index is closing or closed",
            )
        })
    }

    pub(super) fn save(
        self: &Arc<Self>,
        env: Env,
        path: Unknown<'_>,
    ) -> NapiResult<Object<'static>> {
        let permit;
        let mut state = self.state.lock();
        let State::Open { engine, saving } = &mut *state else {
            return Err(closed());
        };
        engine.usable().map_err(native_error)?;
        if *saving {
            return Err(Error::new(
                Status::GenericFailure,
                "[ERR_OKF_PERSISTENCE_BUSY] a save is outstanding",
            ));
        }
        *saving = true;
        permit = SavePermit(Some(self.clone()));
        let prepared = (|| {
            let path = unsafe { Utf16String::from_napi_value(env.raw(), path.raw())? };
            let path = persistence::path(&path, "path").map_err(|e| preparation_error(&env, e))?;
            let guard =
                persistence::WriterGuard::acquire(&path).map_err(|e| preparation_error(&env, e))?;
            #[cfg(feature = "test-fixtures")]
            self.inject("capture")?;
            let snapshot =
                persistence::Snapshot::capture(engine).map_err(|e| preparation_error(&env, e))?;
            #[cfg(feature = "test-fixtures")]
            self.inject("save-deferred")?;
            let (deferred, promise) = env.create_deferred::<(), Resolver>()?;
            let promise = unsafe { Object::from_napi_value(env.raw(), promise.raw())? };
            Ok::<_, Error>((snapshot, guard, deferred, promise, path))
        })();
        drop(state);
        let (snapshot, guard, deferred, promise, path) = prepared?;
        let job = Arc::new(Mutex::new(Some((snapshot, guard, deferred, permit))));
        let worker_job = job.clone();
        if let Err(error) = self.spawn("okf-save", move || {
            let (snapshot, guard, deferred, permit) = worker_job.lock().take().unwrap();
            let result = catch_unwind(AssertUnwindSafe(|| {
                #[cfg(feature = "test-fixtures")]
                {
                    permit.0.as_ref().unwrap().hooks.event("publication");
                    assert!(
                        !permit.0.as_ref().unwrap().hooks.fail("publication-panic"),
                        "injected publication panic"
                    );
                    if permit.0.as_ref().unwrap().hooks.fail("publication") {
                        return Err(invalid(
                            "ERR_OKF_WRITE",
                            "injected publication failure",
                            None,
                        ));
                    }
                }
                snapshot.publish(&guard)
            }));
            drop(guard);
            #[cfg(feature = "test-fixtures")]
            permit.0.as_ref().unwrap().hooks.event("handoff");
            permit.complete(|| match result {
                Ok(result) => deferred.resolve(Box::new(move |env| {
                    result.map_err(|e| preparation_error(&env, e))
                })),
                Err(_) => deferred.reject(Error::new(
                    Status::GenericFailure,
                    "[ERR_OKF_NATIVE] publication panicked",
                )),
            });
        }) {
            let (snapshot, guard, deferred, permit) = job.lock().take().unwrap();
            drop(snapshot);
            drop(guard);
            let mut failure = invalid("ERR_OKF_WRITE", &path, None);
            failure.cause = Some(Box::new(error));
            permit.complete(|| {
                deferred.resolve(Box::new(move |env| Err(preparation_error(&env, failure))))
            });
        }
        Ok(promise)
    }

    fn finish_save(&self, settle: impl FnOnce()) {
        let mut state = self.state.lock();
        match &mut *state {
            State::Open { saving, .. } => {
                *saving = false;
                // Enqueue only, never execute JS callbacks. The mutex keeps a
                // racing close from taking ownership before this attempt finishes.
                let _ = catch_unwind(AssertUnwindSafe(settle));
                drop(state);
                #[cfg(feature = "test-fixtures")]
                self.hooks.event("idle");
            }
            State::ClosingAfterSave { .. } => {
                let _ = catch_unwind(AssertUnwindSafe(settle));
                let State::ClosingAfterSave { engine, waiters } =
                    std::mem::replace(&mut *state, State::ClosingTeardown { waiters: vec![] })
                else {
                    unreachable!()
                };
                *state = State::ClosingTeardown { waiters };
                drop(state);
                self.teardown(engine, None);
            }
            _ => unreachable!("save completion has one owner"),
        }
    }

    pub(super) fn close(self: &Arc<Self>, env: Env) -> NapiResult<Object<'static>> {
        // Allocation failure must not change admission or existing waiters.
        #[cfg(feature = "test-fixtures")]
        self.inject("close-deferred")?;
        let (deferred, promise) = env.create_deferred::<(), Resolver>()?;
        let promise = unsafe { Object::from_napi_value(env.raw(), promise.raw())? };
        let mut state = self.state.lock();
        match &mut *state {
            State::Closed { result } => {
                let result = result.clone();
                drop(state);
                settle(deferred, result);
            }
            State::ClosingAfterSave { waiters, .. } | State::ClosingTeardown { waiters } => {
                waiters.push(deferred)
            }
            State::Open { .. } => {
                let State::Open { engine, saving } =
                    std::mem::replace(&mut *state, State::ClosingTeardown { waiters: vec![] })
                else {
                    unreachable!()
                };
                if saving {
                    *state = State::ClosingAfterSave {
                        engine,
                        waiters: vec![deferred],
                    };
                } else {
                    *state = State::ClosingTeardown {
                        waiters: vec![deferred],
                    };
                    drop(state);
                    let job = Arc::new(Mutex::new(Some(engine)));
                    let worker_job = job.clone();
                    let handle = self.clone();
                    if let Err(error) = self.spawn("okf-close", move || {
                        let engine = worker_job.lock().take().unwrap();
                        handle.teardown(engine, None);
                    }) {
                        let engine = job.lock().take().unwrap();
                        self.teardown(engine, Some(format!("close scheduling failed: {error}")));
                    }
                }
            }
        }
        Ok(promise)
    }

    fn spawn(
        &self,
        name: &str,
        job: impl FnOnce() + Send + 'static,
    ) -> std::io::Result<std::thread::JoinHandle<()>> {
        #[cfg(feature = "test-fixtures")]
        if self.hooks.fail(name) {
            return Err(std::io::Error::other("injected spawn failure"));
        }
        std::thread::Builder::new().name(name.into()).spawn(job)
    }

    #[cfg(feature = "test-fixtures")]
    fn inject(&self, point: &str) -> NapiResult<()> {
        if self.hooks.fail(point) {
            return Err(Error::new(
                Status::GenericFailure,
                format!("injected {point} failure"),
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn test_teardown(engine: Engine) -> CloseResult {
        let handle = Self {
            state: Mutex::new(State::ClosingTeardown { waiters: vec![] }),
            #[cfg(feature = "test-fixtures")]
            hooks: Default::default(),
        };
        handle.teardown(engine, None);
        let state = handle.state.lock();
        let State::Closed { result } = &*state else {
            panic!("teardown did not close")
        };
        let result = result.clone();
        drop(state);
        assert!(handle.admit().is_err());
        result
    }

    fn teardown(&self, engine: Engine, scheduling_error: Option<String>) {
        #[cfg(feature = "test-fixtures")]
        self.hooks.event("teardown");
        let workspace = engine.workspace.clone();
        let result = catch_unwind(AssertUnwindSafe(|| engine.shutdown())).unwrap_or_else(|_| {
            Err(shutdown::ShutdownError {
                message: "shutdown panicked".into(),
                workspace,
            })
        });
        let result = match (scheduling_error, result) {
            (Some(message), Ok(())) => Err(shutdown::ShutdownError {
                message,
                workspace: None,
            }),
            (Some(message), Err(mut error)) => {
                error.message = format!("{message}; {}", error.message);
                Err(error)
            }
            (None, result) => result,
        };
        let mut state = self.state.lock();
        let State::ClosingTeardown { waiters } = std::mem::replace(
            &mut *state,
            State::Closed {
                result: result.clone(),
            },
        ) else {
            unreachable!("teardown has one owner")
        };
        drop(state);
        for waiter in waiters {
            let _ = catch_unwind(AssertUnwindSafe(|| settle(waiter, result.clone())));
        }
    }
}
fn closed() -> Error {
    Error::new(
        Status::GenericFailure,
        "[ERR_OKF_INDEX_CLOSED] index is closing or closed",
    )
}
fn settle(deferred: Deferred, result: CloseResult) {
    match result {
        Ok(()) => deferred.resolve(Box::new(|_| Ok(()))),
        Err(error) => deferred.resolve(Box::new(move |env| {
            let path = error
                .workspace
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| "<index>".into());
            Err(preparation_error(
                &env,
                PreparationError::caused("ERR_OKF_CLOSE", &path, error),
            ))
        })),
    }
}
