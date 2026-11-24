use std::cell::{Cell, RefCell};
use std::future::Future;
use std::rc::Rc;
use std::time::Duration;

use worker::js_sys::{
    self, Array, Date, Function, JSON, Object, Promise, Proxy, Reflect, Uint32Array,
};
use worker::wasm_bindgen::{JsCast, JsValue, closure::Closure};
use worker::wasm_bindgen_futures::{JsFuture, future_to_promise};
use worker::web_sys::{Headers, Response, WorkerGlobalScope};
use worker::worker_sys::R2Bucket;

use crate::html_rewriter::JsResult;
use crate::http::error;
use crate::public_cache::stream_response;
use crate::runtime::{get, js_number, object, only_if, parse_object, property, set};

const LEASE: &str = "state/content-mutation.json";
pub const LEASE_MS: f64 = 3.0 * 60_000.0;
const MUTATION_MS: f64 = 60_000.0;
const MUTATION_CALLS: u32 = 900;
const BACKUP_CALLS: u32 = 180;

#[derive(Clone, Copy)]
enum Operation {
    Get,
    Head,
    List,
    Put,
    Delete,
}

impl Operation {
    fn from_property(name: &JsValue) -> Option<Self> {
        Some(match name.as_string()?.as_str() {
            "get" => Self::Get,
            "head" => Self::Head,
            "list" => Self::List,
            "put" => Self::Put,
            "delete" => Self::Delete,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Self::Get => "get",
            Self::Head => "head",
            Self::List => "list",
            Self::Put => "put",
            Self::Delete => "delete",
        }
    }

    fn arguments(self, first: JsValue, second: JsValue, third: JsValue) -> Array {
        let args = Array::new();
        args.push(&first);
        if matches!(self, Self::Get | Self::Put) {
            args.push(&second);
        }
        if matches!(self, Self::Put) {
            args.push(&third);
        }
        args
    }
}

fn wrap(
    storage: &R2Bucket,
    call: impl Fn(Operation, &Function, &JsValue, &Array) -> JsResult<JsValue> + 'static,
) -> JsResult<R2Bucket> {
    let call = Rc::new(call);
    let get = Closure::wrap(Box::new(
        move |target: JsValue, field: JsValue| -> JsResult<JsValue> {
            let method = Reflect::get(&target, &field)?;
            if !method.is_function() {
                return Ok(method);
            }
            let method: Function = method.unchecked_into();
            let Some(operation) = Operation::from_property(&field) else {
                return Ok(method.bind0(&target).into());
            };
            let call = Rc::clone(&call);
            let callback = Closure::wrap(Box::new(move |first, second, third| {
                let args = operation.arguments(first, second, third);
                call(operation, &method, &target, &args)
            })
                as Box<dyn FnMut(JsValue, JsValue, JsValue) -> JsResult<JsValue>>);
            Ok(callback.into_js_value())
        },
    )
        as Box<dyn FnMut(JsValue, JsValue) -> JsResult<JsValue>>);
    let handler = Object::new();
    set(&handler, "get", get.into_js_value())?;
    Ok(Proxy::new(storage.as_ref(), &handler).unchecked_into())
}

pub fn uuid() -> JsResult<String> {
    let runtime = js_sys::global().unchecked_into::<WorkerGlobalScope>();
    Ok(runtime.crypto()?.random_uuid())
}

pub async fn with_mutation<F, T>(
    storage: &R2Bucket,
    work: impl FnOnce(R2Bucket) -> F,
) -> JsResult<T>
where
    F: Future<Output = JsResult<T>>,
{
    for attempt in 0..5 {
        let stored = get(storage, LEASE).await?;
        let prior = if stored.is_truthy() {
            parse_object(&stored).await?
        } else {
            JsValue::NULL
        };
        if !prior.is_truthy() || js_number(&property(&prior, "expires")) < Date::now() {
            let lease = object(&[
                ("expires", (Date::now() + LEASE_MS).into()),
                ("owner", uuid()?.into()),
            ])?;
            let condition = if stored.is_truthy() {
                only_if("etagMatches", property(&stored, "etag"))?
            } else {
                only_if("etagDoesNotMatch", "*".into())?
            };
            let locked = JsFuture::from(storage.put(
                LEASE.to_owned(),
                JSON::stringify(&lease)?.into(),
                condition.into(),
            )?)
            .await?;
            if locked.is_truthy() {
                let deadline = Date::now() + MUTATION_MS;
                let calls = Cell::new(0);
                let result = async {
                    let guarded = wrap(storage, move |_, method, target, args| {
                        if Date::now() >= deadline {
                            return Err(error(503, "本批操作已暂停，请重试；已保存内容保留。"));
                        }
                        calls.set(calls.get() + 1);
                        if calls.get() > MUTATION_CALLS {
                            return Err(error(503, "本批操作已暂停，请重试；已保存内容保留。"));
                        }
                        Reflect::apply(method, target, args)
                    })?;
                    work(guarded).await
                }
                .await;
                let reset = object(&[("expires", 0.into()), ("owner", "".into())])?;
                let condition = only_if("etagMatches", property(&locked, "etag"))?;
                JsFuture::from(storage.put(
                    LEASE.to_owned(),
                    JSON::stringify(&reset)?.into(),
                    condition.into(),
                )?)
                .await?;
                return result;
            }
        }
        if attempt < 4 {
            worker::Delay::from(Duration::from_millis(250)).await;
        }
    }
    Err(error(
        503,
        "另一项保存或图片清理正在进行，请稍后重试；当前内容仍保留。",
    ))
}

pub async fn with_backup_budget<F>(
    storage: &R2Bucket,
    work: impl FnOnce(R2Bucket) -> F,
) -> JsResult<Response>
where
    F: Future<Output = JsResult<Response>>,
{
    let calls = Rc::new(Cell::new(0));
    let observed = Rc::clone(&calls);
    let guarded = wrap(storage, move |_, method, target, args| {
        observed.set(observed.get() + 1);
        if observed.get() > BACKUP_CALLS {
            return Err(error(413, "当前批次超出存储操作预算，请缩小批次后重试。"));
        }
        Reflect::apply(method, target, args)
    })?;
    let response = work(guarded).await?;
    let headers = Headers::new_with_headers(&response.headers())?;
    headers.set("X-CloudInk-Storage-Calls", &calls.get().to_string())?;
    stream_response(response.body().as_ref(), response.status(), &headers)
}

#[derive(Default)]
struct Counts {
    get: u32,
    head: u32,
    list: u32,
    put: u32,
    delete: u32,
    objects: u32,
    errors: u32,
}

pub struct Stats {
    counts: Rc<RefCell<Counts>>,
    stage: Rc<RefCell<String>>,
    pub bucket: R2Bucket,
}

impl Stats {
    pub fn new(storage: &R2Bucket) -> JsResult<Self> {
        let counts = Rc::new(RefCell::new(Counts::default()));
        let stage = Rc::new(RefCell::new("routing".to_owned()));
        let counters = Rc::clone(&counts);
        let latest = Rc::clone(&stage);
        let bucket = wrap(storage, move |operation, method, target, args| {
            {
                let mut count = counters.borrow_mut();
                match operation {
                    Operation::Get => count.get += 1,
                    Operation::Head => count.head += 1,
                    Operation::List => count.list += 1,
                    Operation::Put => count.put += 1,
                    Operation::Delete => count.delete += 1,
                }
            }
            let key = args.get(0).as_string().unwrap_or_default();
            let prefix = key
                .split('/')
                .next()
                .filter(|prefix| !prefix.is_empty())
                .unwrap_or("catalog");
            *latest.borrow_mut() = format!("{}:{prefix}", operation.name());
            let result = Reflect::apply(method, target, args);
            let counters = Rc::clone(&counters);
            Ok(future_to_promise(async move {
                let result = match result {
                    Ok(pending) => JsFuture::from(Promise::resolve(&pending)).await,
                    Err(error) => Err(error),
                };
                match &result {
                    Ok(value) if matches!(operation, Operation::List) => {
                        let objects = property(value, "objects");
                        if Array::is_array(&objects) {
                            counters.borrow_mut().objects +=
                                objects.unchecked_ref::<Array>().length();
                        }
                    }
                    Err(_) => counters.borrow_mut().errors += 1,
                    _ => {}
                }
                result
            })
            .into())
        })?;
        Ok(Self {
            counts,
            stage,
            bucket,
        })
    }

    pub fn report(
        &self,
        id: &str,
        route: &str,
        method: &str,
        status: u16,
        started: f64,
    ) -> JsResult<()> {
        let counts = self.counts.borrow();
        let total = counts.get + counts.head + counts.list + counts.put + counts.delete;
        if status < 500 && total < 150 {
            let crypto = js_sys::global()
                .unchecked_into::<WorkerGlobalScope>()
                .crypto()?;
            let random = Uint32Array::new_with_length(1);
            crypto.get_random_values_with_array_buffer_view(random.unchecked_ref())?;
            if !random.get_index(0).is_multiple_of(100) {
                return Ok(());
            }
        }
        let code = if status >= 500 {
            "request_failed"
        } else if total >= 150 {
            "storage_budget_warning"
        } else {
            "sample"
        };
        let value = object(&[
            ("event", "storage_request".into()),
            ("request_id", id.into()),
            ("route", route.into()),
            ("method", method.into()),
            ("status", status.into()),
            ("code", code.into()),
            ("stage", self.stage.borrow().as_str().into()),
            ("elapsed_ms", (Date::now() - started).into()),
            ("get", counts.get.into()),
            ("head", counts.head.into()),
            ("list", counts.list.into()),
            ("put", counts.put.into()),
            ("delete", counts.delete.into()),
            ("objects", counts.objects.into()),
            ("errors", counts.errors.into()),
        ])?;
        worker::console_log!(
            "{}",
            JSON::stringify(&value)?.as_string().unwrap_or_default()
        );
        Ok(())
    }
}
