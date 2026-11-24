use std::cell::Cell;
use worker::console_error;
use worker::js_sys::{Array, Date, JSON, Object, Reflect, RegExp, Set};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;
use worker::web_sys::ReadableStream;
use worker::worker_sys::R2Bucket;

use crate::feed::{object_json, read_json};
use crate::html_rewriter::JsResult;
use crate::runtime::{js_number, js_string, property, set};
use crate::{http, reference_index, storage as r2};

const STATUS: &str = "state/maintenance.json";
const GRACE: f64 = 24.0 * 60.0 * 60_000.0;

thread_local! {
    static HASH: RegExp = RegExp::new(r"^[a-f0-9]{64}$", "");
    static CONTENT: RegExp = RegExp::new(r"^public/content/([a-f0-9]{64})$", "");
    static VERSION: RegExp = RegExp::new(
        r"^(?:public/([a-f0-9-]{36})/|releases/([a-f0-9-]{36})(?:\.manifest|\.posts)?\.json$)", "",
    );
    static TEMPORARY: RegExp = RegExp::new(
        r"^backup-tasks/([a-f0-9-]{36})/(?:state|chunks/\d+)\.json$", "",
    );
    static REFERENCE: RegExp = RegExp::new(r"^image-reference-index/[a-f0-9]{2}\.json$", "");
    static SESSION: RegExp = RegExp::new(r"^auth/sessions/[a-f0-9]{64}$", "");
}

pub async fn run(storage: &R2Bucket) -> JsResult<JsValue> {
    let attempted = now();
    let acquired = Cell::new(false);
    let result = r2::with_mutation(storage, |guarded| {
        acquired.set(true);
        let attempted = &attempted;
        async move { run_acquired(storage, &guarded, attempted).await }
    })
    .await;
    match result {
        Err(error) if !acquired.get() => record_lease_failure(storage, &attempted, &error).await,
        result => result,
    }
}

async fn run_acquired(
    storage: &R2Bucket,
    guarded: &R2Bucket,
    attempted: &JsValue,
) -> JsResult<JsValue> {
    let prior = read_json(guarded, STATUS.into()).await?;
    let state = copy_fields(&prior);
    copy_last_success(&state, &prior)?;
    set(&state, "last_attempt_at", attempted)?;
    set(&state, "status", "running")?;
    set(&state, "reason", JsValue::UNDEFINED)?;
    set(&state, "stage", "initializing")?;
    for field in [
        "scanned_objects",
        "deleted_objects",
        "deleted_bytes",
        "pruned_references",
        "expired_sessions",
    ] {
        set(&state, field, 0)?;
    }
    let cursors = copy_fields(&property(&prior, "cursors"));
    set(&state, "cursors", &cursors)?;
    let started = write_status(guarded, &state, JsValue::UNDEFINED).await?;
    if !started.is_truthy() {
        return Err(worker::js_sys::Error::new("Maintenance status write failed").into());
    }
    let (status, reason) = match clean(guarded, &state, &cursors).await {
        Ok(None) => ("success", None),
        Ok(Some(reason)) => ("skipped", Some(reason)),
        Err(error) => {
            let stage = JSON::stringify(&property(&state, "stage"))?;
            let kind = error
                .dyn_ref::<worker::js_sys::Error>()
                .map(|error| error.name())
                .unwrap_or_else(|| "unknown".into());
            let kind = JSON::stringify(kind.as_ref())?;
            console_error!(
                "{{\"event\":\"storage_maintenance_failed\",\"stage\":{stage},\"type\":{kind}}}"
            );
            let reason = if http::status(&error).is_some() {
                "bounded_work_or_storage_conflict"
            } else {
                "storage_error"
            };
            ("failed", Some(reason))
        }
    };
    set(&state, "status", status)?;
    set(
        &state,
        "reason",
        reason.map(JsValue::from_str).unwrap_or(JsValue::UNDEFINED),
    )?;
    if status == "success" {
        let finished = now();
        set(&state, "last_success_at", &finished)?;
        set(&state, "finished_at", finished)?;
    }
    // A successor may have acquired the lease before this invocation finishes.
    let condition = only_if("etagMatches", property(&started, "etag"))?;
    if !write_status(storage, &state, condition).await?.is_truthy() {
        return Err(http::error(409, "维护状态已由后续任务更新。"));
    }
    Ok(state.into())
}

async fn record_lease_failure(
    storage: &R2Bucket,
    attempted: &JsValue,
    error: &JsValue,
) -> JsResult<JsValue> {
    let object = JsFuture::from(storage.get(STATUS.into(), JsValue::UNDEFINED)?).await?;
    let prior = if object.is_null() {
        JsValue::NULL
    } else {
        object_json(object.clone()).await?
    };
    let last_attempt = property(&prior, "last_attempt_at");
    if property(&prior, "status").as_string().as_deref() == Some("running")
        && last_attempt.is_truthy()
        && Date::now() - date(&last_attempt) < r2::LEASE_MS
    {
        return Ok(prior);
    }
    let state = copy_fields(&prior);
    copy_last_success(&state, &prior)?;
    set(&state, "last_attempt_at", attempted)?;
    let busy = http::status(error) == Some(503);
    set(&state, "status", if busy { "skipped" } else { "failed" })?;
    set(
        &state,
        "reason",
        if busy {
            "mutation_busy"
        } else {
            "storage_error"
        },
    )?;
    set(&state, "stage", "lease")?;
    let condition = if object.is_null() {
        only_if("etagDoesNotMatch", "*".into())?
    } else {
        only_if("etagMatches", property(&object, "etag"))?
    };
    write_status(storage, &state, condition).await?;
    Ok(state.into())
}

async fn clean(
    storage: &R2Bucket,
    state: &Object,
    cursors: &Object,
) -> JsResult<Option<&'static str>> {
    let pointer = read_json(storage, "state/published.json".into()).await?;
    if !pointer.is_truthy() {
        return Ok(Some("uninitialized"));
    }
    let published_at = property(&pointer, "published_at");
    if published_at.is_truthy() && Date::now() - date(&published_at) < 5.0 * 60_000.0 {
        return Ok(Some("publication_settling"));
    }
    let pending = read_json(storage, "state/pending.json".into()).await?;
    if matches!(
        property(&pending, "status").as_string().as_deref(),
        Some("queued" | "building" | "built")
    ) && Date::now() - date(&property(&pending, "started_at")) <= 30.0 * 60_000.0
    {
        return Ok(Some("publication_busy"));
    }

    let task = crate::backup_jobs::active(storage).await?;
    let current = property(&pointer, "id");
    let retained = Set::new(&JsValue::UNDEFINED);
    retained.add(&current);
    let previous = property(&pointer, "previous_ids");
    if previous.is_truthy() {
        for id in Array::from(&previous).iter() {
            retained.add(&id);
        }
    }
    let backup_release = property(&task, "releaseId");
    if property(&task, "mode").as_string().as_deref() == Some("export")
        && backup_release.is_truthy()
    {
        retained.add(&backup_release);
    }
    let pages = property(&pointer, "pages");
    let referenced = Set::new(values(&pages).as_ref());
    set(state, "stage", "retained_manifests")?;
    for id in Array::from(retained.as_ref()).iter() {
        let manifest = read_json(
            storage,
            format!("releases/{}.manifest.json", js_string(&id)),
        )
        .await?;
        if manifest.is_truthy() {
            let pages = property(&manifest, "pages");
            let hashes = values(&pages);
            if !pages.is_truthy()
                || hashes.iter().any(|hash| {
                    !HASH.with(|pattern| {
                        pattern.test(&js_string(&hash).as_string().unwrap_or_default())
                    })
                })
            {
                return Err(
                    worker::js_sys::Error::new("Invalid retained publication manifest").into(),
                );
            }
            for hash in hashes.iter() {
                referenced.add(&hash);
            }
        } else if id == current && pages.is_truthy() {
            return Err(worker::js_sys::Error::new("Missing live publication manifest").into());
        }
    }

    let task_id = property(&task, "id");
    for (prefix, limit) in [("public", 250), ("releases", 100), ("backup-tasks", 100)] {
        set(state, "stage", prefix)?;
        let page = list(
            storage,
            &format!("{prefix}/"),
            limit,
            property(cursors, prefix),
            false,
        )
        .await?;
        let objects: Array = property(&page, "objects").unchecked_into();
        increment(state, "scanned_objects", f64::from(objects.length()))?;
        let remove = Array::new();
        let mut bytes = 0.0;
        for object in objects.iter() {
            if uploaded(&object) > Date::now() - GRACE {
                continue;
            }
            let key = property(&object, "key");
            let path = key.as_string().unwrap_or_default();
            let obsolete = if let Some(task) = TEMPORARY.with(|pattern| pattern.exec(&path)) {
                JsValue::from(task.get(1)) != task_id
            } else if let Some(content) = CONTENT.with(|pattern| pattern.exec(&path)) {
                !referenced.has(&content.get(1))
            } else {
                VERSION
                    .with(|pattern| pattern.exec(&path))
                    .is_some_and(|version| {
                        let directory = version.get(1);
                        !retained.has(&if directory.is_truthy() {
                            directory.into()
                        } else {
                            version.get(2).into()
                        })
                    })
            };
            if obsolete {
                remove.push(&key);
                bytes += js_number(&property(&object, "size"));
            }
        }
        delete_many(storage, &remove).await?;
        increment(state, "deleted_objects", f64::from(remove.length()))?;
        increment(state, "deleted_bytes", bytes)?;
        update_cursor(cursors, prefix, &page)?;
    }

    set(state, "stage", "references")?;
    let refs = list(
        storage,
        reference_index::ROOT,
        1,
        property(cursors, "references"),
        false,
    )
    .await?;
    let objects: Array = property(&refs, "objects").unchecked_into();
    for object in objects.iter() {
        increment(state, "scanned_objects", 1.0)?;
        let key = property(&object, "key").as_string().unwrap_or_default();
        if REFERENCE.with(|pattern| pattern.test(&key)) && uploaded(&object) <= Date::now() - GRACE
        {
            let pruned = reference_index::prune(storage, &key).await?;
            increment(state, "pruned_references", f64::from(pruned))?;
        }
    }
    update_cursor(cursors, "references", &refs)?;

    set(state, "stage", "sessions")?;
    let sessions = list(
        storage,
        "auth/sessions/",
        32,
        property(cursors, "sessions"),
        true,
    )
    .await?;
    let objects: Array = property(&sessions, "objects").unchecked_into();
    let expired = Array::new();
    for object in objects.iter() {
        increment(state, "scanned_objects", 1.0)?;
        let key = property(&object, "key");
        let path = key.as_string().unwrap_or_default();
        if !SESSION.with(|pattern| pattern.test(&path)) {
            continue;
        }
        let raw_expiry = property(&property(&object, "customMetadata"), "expires");
        let mut expiry = if raw_expiry.is_truthy() {
            js_number(&raw_expiry)
        } else {
            f64::NAN
        };
        if !expiry.is_finite() {
            let legacy = JsFuture::from(storage.get(path, JsValue::UNDEFINED)?).await?;
            if legacy.is_truthy() {
                if js_number(&property(&legacy, "size")) <= 4096.0 {
                    if let Ok(data) = object_json(legacy).await {
                        expiry = js_number(&property(&data, "expires"));
                    }
                } else {
                    let body: ReadableStream = property(&legacy, "body").unchecked_into();
                    JsFuture::from(body.cancel()).await?;
                }
            }
        }
        if expiry.is_finite() && expiry > 0.0 && expiry < Date::now() {
            expired.push(&key);
        }
    }
    delete_many(storage, &expired).await?;
    set(state, "expired_sessions", expired.length())?;
    update_cursor(cursors, "sessions", &sessions)?;
    set(state, "stage", "complete")?;
    Ok(None)
}

fn copy_fields(value: &JsValue) -> Object {
    let target = Object::create(JsValue::NULL.unchecked_ref());
    Object::assign(&target, value.unchecked_ref())
}

fn copy_last_success(state: &Object, prior: &JsValue) -> JsResult<()> {
    let last = property(prior, "last_success_at");
    set(
        state,
        "last_success_at",
        if last.is_truthy() {
            last
        } else {
            property(prior, "finished_at")
        },
    )
}

fn values(object: &JsValue) -> Array {
    if object.is_truthy() {
        Object::values(object.unchecked_ref::<Object>())
    } else {
        Array::new()
    }
}

fn now() -> JsValue {
    Date::new_0().to_iso_string().into()
}

fn date(value: &JsValue) -> f64 {
    Date::parse(&js_string(value).as_string().unwrap_or_default())
}

fn uploaded(object: &JsValue) -> f64 {
    property(object, "uploaded")
        .unchecked_into::<Date>()
        .get_time()
}

fn increment(state: &Object, field: &str, amount: f64) -> JsResult<()> {
    set(state, field, js_number(&property(state, field)) + amount)
}

async fn list(
    storage: &R2Bucket,
    prefix: &str,
    limit: u32,
    cursor: JsValue,
    metadata: bool,
) -> JsResult<JsValue> {
    let options = Object::new();
    set(&options, "prefix", prefix)?;
    set(&options, "limit", limit)?;
    set(&options, "cursor", cursor)?;
    if metadata {
        set(&options, "include", Array::of1(&"customMetadata".into()))?;
    }
    JsFuture::from(storage.list(options.into())?).await
}

fn update_cursor(cursors: &Object, prefix: &str, page: &JsValue) -> JsResult<()> {
    if property(page, "truncated").is_truthy() {
        set(cursors, prefix, property(page, "cursor"))?;
    } else {
        Reflect::delete_property(cursors, &prefix.into())?;
    }
    Ok(())
}

async fn delete_many(storage: &R2Bucket, keys: &Array) -> JsResult<()> {
    if keys.length() != 0 {
        JsFuture::from(storage.delete_multiple(keys.to_vec())?).await?;
    }
    Ok(())
}

fn only_if(key: &str, etag: JsValue) -> JsResult<JsValue> {
    let conditional = Object::new();
    set(&conditional, key, etag)?;
    let options = Object::new();
    set(&options, "onlyIf", conditional)?;
    Ok(options.into())
}

async fn write_status(storage: &R2Bucket, state: &Object, options: JsValue) -> JsResult<JsValue> {
    JsFuture::from(storage.put(STATUS.into(), JSON::stringify(state)?.into(), options)?).await
}
