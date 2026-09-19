use super::*;

#[test]
fn abandoned_save_permit_reopens_admission_without_losing_engine() {
    let engine = Engine::new_with_storage(vec![], StorageMode::Mmap).unwrap();
    let workspace = engine.workspace.clone().unwrap();
    let handle = HandleState::new(engine);
    if let State::Open { saving, .. } = &mut *handle.state.lock() {
        *saving = true;
    }
    drop(SavePermit(Some(handle.clone())));
    assert!(matches!(
        &*handle.state.lock(),
        State::Open { saving: false, .. }
    ));
    assert!(workspace.exists());
    assert!(handle.admit().unwrap().index_stats().is_ok());
    drop(handle);
    assert!(!workspace.exists());
}

#[test]
fn recovered_save_completion_owns_pending_teardown_even_if_settlement_panics() {
    for panic in [false, true] {
        let engine = Engine::new_with_storage(vec![], StorageMode::Mmap).unwrap();
        let workspace = engine.workspace.clone().unwrap();
        let handle = Arc::new(HandleState {
            state: Mutex::new(State::ClosingAfterSave {
                engine,
                waiters: vec![],
            }),
            #[cfg(feature = "test-fixtures")]
            hooks: Default::default(),
        });
        let permit = SavePermit(Some(handle.clone()));
        let mut enqueued = false;
        permit.complete(|| {
            assert!(
                workspace.exists(),
                "teardown must follow settlement enqueue attempt"
            );
            enqueued = true;
            assert!(!panic, "injected unavailable settlement");
        });
        assert!(enqueued);
        assert!(!workspace.exists());
        assert!(matches!(
            &*handle.state.lock(),
            State::Closed { result: Ok(()) }
        ));
        assert!(handle.admit().is_err());
    }
}
