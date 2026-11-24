use futures_util::try_join;
use worker::Env;
use worker::js_sys::{Array, Date, JSON, JsString, RegExp, Uint8Array};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;
use worker::web_sys::{CryptoKey, Request, Response, Url};
use worker::worker_sys::R2Bucket;

use crate::config::Config;
use crate::html_rewriter::JsResult;
use crate::http::{error, json_input};
use crate::runtime::{
    crypto, digest_text, encode_utf8, get, hex, js_number, js_string, json, object, only_if,
    parse_object, property, read_json, same_bytes, set, sha256,
};
use crate::{browser_publish, models, publishing};

const ACCOUNT: &str = "auth/account.json";
const COOKIE: &str = "__Host-cloudink_session=";
const SESSION_SECONDS: u32 = 7 * 86400;

thread_local! {
    static EMAIL: RegExp = RegExp::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", "");
}

pub async fn route(
    request: &Request,
    url: &Url,
    env: &Env,
    storage: &R2Bucket,
    config: &Config,
    path: &str,
) -> JsResult<Option<Response>> {
    let response = match (path, request.method().as_str()) {
        ("/api/session", "GET") => {
            let session = require_session(request, url, storage).await?;
            session_response(&session)?
        }
        ("/api/login" | "/api/setup", "POST") => {
            same_origin(request, url)?;
            let ip = request
                .headers()
                .get("CF-Connecting-IP")?
                .filter(|ip| !ip.is_empty())
                .unwrap_or_else(|| "local".into());
            let limit = env
                .rate_limiter("LOGIN_LIMITER")
                .map_err(runtime_error)?
                .limit(ip)
                .await
                .map_err(runtime_error)?;
            if !limit.success {
                return Err(error(429, "尝试次数过多，请一分钟后再试。"));
            }
            let input = json_input(request, 16_384).await?;
            let account = read_json(storage, ACCOUNT).await?;
            if path == "/api/setup" {
                setup(request, storage, config, &input, &account).await?
            } else {
                login(storage, &input, &account).await?
            }
        }
        ("/api/logout", "POST") => {
            require_session(request, url, storage).await?;
            delete_session(request, storage).await?;
            let response = json(200, &[("ok", true.into())])?;
            response.headers().set("Set-Cookie", &cookie("", 0))?;
            response
        }
        ("/api/account", "PUT") => {
            require_session(request, url, storage).await?;
            update_account(request, storage).await?
        }
        _ => return Ok(None),
    };
    Ok(Some(response))
}

fn runtime_error(failure: worker::Error) -> JsValue {
    worker::js_sys::Error::new(&failure.to_string()).into()
}

fn same_origin(request: &Request, url: &Url) -> JsResult<()> {
    if request.headers().get("Origin")?.as_deref() != Some(url.origin().as_str()) {
        return Err(error(403, "请求来源不正确，请重新打开后台。"));
    }
    Ok(())
}

fn cookie(token: &str, age: u32) -> String {
    format!("{COOKIE}{token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age={age}")
}

fn cookie_token(request: &Request) -> JsResult<String> {
    Ok(request
        .headers()
        .get("Cookie")?
        .unwrap_or_default()
        .split(';')
        .map(str::trim)
        .find_map(|item| item.strip_prefix(COOKIE))
        .unwrap_or_default()
        .to_owned())
}

async fn session_key(token: &str) -> JsResult<String> {
    Ok(format!(
        "auth/sessions/{}",
        digest_text(&token.into()).await?
    ))
}

async fn delete_session(request: &Request, storage: &R2Bucket) -> JsResult<()> {
    let key = session_key(&cookie_token(request)?).await?;
    JsFuture::from(storage.delete(key)?).await?;
    Ok(())
}

pub async fn require_session(
    request: &Request,
    url: &Url,
    storage: &R2Bucket,
) -> JsResult<JsValue> {
    let token = cookie_token(request)?;
    if !browser_publish::is_hash(&token.as_str().into()) {
        return Err(error(401, "请先登录。"));
    }
    let key = session_key(&token).await?;
    let (session, account) = try_join!(read_json(storage, &key), read_json(storage, ACCOUNT))?;
    if !session.is_truthy()
        || !account.is_truthy()
        || js_number(&property(&session, "expires")) < Date::now()
        || property(&session, "version") != property(&account, "version")
    {
        return Err(error(401, "登录已过期，请重新登录。"));
    }
    if !matches!(request.method().as_str(), "GET" | "HEAD") {
        same_origin(request, url)?;
        let supplied = request.headers().get("X-CSRF-Token")?.unwrap_or_default();
        let expected = stored_string(&session, "csrf")?;
        if !same_secret(&supplied.into(), &expected).await? {
            return Err(error(403, "登录校验已失效，请刷新页面。"));
        }
    }
    let session = browser_publish::copy(&session);
    set(&session, "email", property(&account, "email"))?;
    Ok(session.into())
}

async fn setup(
    request: &Request,
    storage: &R2Bucket,
    config: &Config,
    input: &JsValue,
    prior: &JsValue,
) -> JsResult<Response> {
    let already_initialized = || error(409, "后台已经初始化，请使用登录页面。");
    if prior.is_truthy() {
        return Err(already_initialized());
    }
    if !(16..=128).contains(&config.setup_token.length()) {
        return Err(error(
            503,
            "请在 Cloudflare 设置 16–128 个字符的 SETUP_TOKEN Secret，再打开初始化页面。",
        ));
    }
    let supplied = request.headers().get("Authorization")?.unwrap_or_default();
    let expected = JsString::from("Bearer ").concat(&config.setup_token);
    if !same_secret(&supplied.into(), &expected).await? {
        return Err(error(403, "初始化口令不正确。"));
    }
    let email = email_input(&property(input, "email"))?;
    let password = password_input(&property(input, "password"))?;
    let salt: JsString = random_token()?.into();
    let site = models::validate_site(&property(input, "site"))?;
    let hash = password_hash(&password, &salt).await?;
    let account = object(&[
        ("email", email.into()),
        ("salt", salt.into()),
        ("hash", hash.into()),
        ("version", random_token()?.into()),
        ("initialSite", site.clone()),
    ])?;
    let condition = only_if("etagDoesNotMatch", "*".into())?;
    let saved = JsFuture::from(storage.put(
        ACCOUNT.into(),
        JSON::stringify(&account)?.into(),
        condition.into(),
    )?)
    .await?;
    if !saved.is_truthy() {
        return Err(already_initialized());
    }
    publishing::initialize(storage, &site).await?;
    login_response(storage, &account).await
}

async fn login(storage: &R2Bucket, input: &JsValue, account: &JsValue) -> JsResult<Response> {
    let email = string_or_empty(property(input, "email"))
        .trim()
        .to_lower_case();
    let password = string_or_empty(property(input, "password"));
    if password.length() > 128 {
        return Err(error(401, "邮箱或密码不正确。"));
    }
    let salt = property(account, "salt");
    let salt = if salt.is_truthy() {
        js_string(&salt)
    } else {
        "uninitialized-cloudink".into()
    };
    // Derive even for a missing account, as the TypeScript implementation did.
    let hash = password_hash(&password, &salt).await?;
    if !account.is_truthy()
        || property(account, "email") != JsValue::from(email)
        || !same_secret(&hash.into(), &stored_string(account, "hash")?).await?
    {
        return Err(error(401, "邮箱或密码不正确，或后台尚未初始化。"));
    }
    publishing::initialize(storage, &property(account, "initialSite")).await?;
    login_response(storage, account).await
}

async fn update_account(request: &Request, storage: &R2Bucket) -> JsResult<Response> {
    let input = json_input(request, 4096).await?;
    let stored = get(storage, ACCOUNT).await?;
    if !stored.is_truthy() {
        return Err(error(401, "请重新登录。"));
    }
    let account = parse_object(&stored).await?;
    let current = property(&input, "current_password");
    if !current.is_string()
        || current.unchecked_ref::<JsString>().length() > 128
        || !same_secret(
            &password_hash(current.unchecked_ref(), &stored_string(&account, "salt")?)
                .await?
                .into(),
            &stored_string(&account, "hash")?,
        )
        .await?
    {
        return Err(error(400, "当前密码不正确。"));
    }
    let salt: JsString = random_token()?.into();
    let updated = browser_publish::copy(&account);
    let email = email_input(&property(&input, "email"))?;
    set(&updated, "email", email)?;
    set(&updated, "version", random_token()?)?;
    let password = property(&input, "password");
    if password.is_truthy() {
        let password = password_input(&password)?;
        set(&updated, "salt", &salt)?;
        set(&updated, "hash", password_hash(&password, &salt).await?)?;
    }
    let condition = only_if("etagMatches", property(&stored, "etag"))?;
    let saved = JsFuture::from(storage.put(
        ACCOUNT.into(),
        JSON::stringify(&updated)?.into(),
        condition.into(),
    )?)
    .await?;
    if !saved.is_truthy() {
        return Err(error(409, "账户刚刚发生了修改，请重新登录。"));
    }
    delete_session(request, storage).await?;
    login_response(storage, &updated).await
}

async fn login_response(storage: &R2Bucket, account: &JsValue) -> JsResult<Response> {
    let token = random_token()?;
    let csrf = random_token()?;
    let expires = Date::now() + f64::from(SESSION_SECONDS) * 1000.0;
    let session = object(&[
        ("csrf", csrf.clone().into()),
        ("expires", expires.into()),
        ("version", property(account, "version")),
    ])?;
    let metadata = object(&[("expires", js_string(&expires.into()).into())])?;
    let options = object(&[("customMetadata", metadata.into())])?;
    JsFuture::from(storage.put(
        session_key(&token).await?,
        JSON::stringify(&session)?.into(),
        options.into(),
    )?)
    .await?;
    set(&session, "email", property(account, "email"))?;
    let response = session_response(&session)?;
    response
        .headers()
        .set("Set-Cookie", &cookie(&token, SESSION_SECONDS))?;
    Ok(response)
}

fn session_response(session: &JsValue) -> JsResult<Response> {
    json(
        200,
        &[
            ("email", property(session, "email")),
            ("csrf", property(session, "csrf")),
        ],
    )
}

fn string_or_empty(value: JsValue) -> JsString {
    if value.is_string() {
        value.unchecked_into()
    } else {
        "".into()
    }
}

fn stored_string(object: &JsValue, field: &str) -> JsResult<JsString> {
    let field = property(object, field);
    if !field.is_string() {
        return Err(worker::js_sys::Error::new("Invalid account or session record").into());
    }
    Ok(field.unchecked_into())
}

fn email_input(value: &JsValue) -> JsResult<JsString> {
    let value = string_or_empty(value.clone());
    let email = value.trim();
    if value.length() > 254 || !EMAIL.with(|pattern| email.match_(pattern).is_some()) {
        return Err(error(400, "请输入有效的登录邮箱。"));
    }
    Ok(email.to_lower_case())
}

fn password_input(value: &JsValue) -> JsResult<JsString> {
    let password = string_or_empty(value.clone());
    if !(12..=128).contains(&password.length()) {
        return Err(error(400, "密码需要 12–128 个字符。"));
    }
    Ok(password)
}

fn random_token() -> JsResult<String> {
    let bytes = Uint8Array::new_with_length(32);
    crypto()?.get_random_values_with_array_buffer_view(bytes.unchecked_ref())?;
    Ok(hex(&bytes))
}

async fn same_secret(first: &JsString, second: &JsString) -> JsResult<bool> {
    let first = encode_utf8(first);
    let second = encode_utf8(second);
    let (first, second) = try_join!(sha256(&first), sha256(&second))?;
    same_bytes(&first, &second)
}

async fn password_hash(password: &JsString, salt: &JsString) -> JsResult<String> {
    let crypto = crypto()?.subtle();
    let password = encode_utf8(password);
    let usage: Array = [JsValue::from_str("deriveBits")].into_iter().collect();
    let key: CryptoKey = JsFuture::from(crypto.import_key_with_str(
        "raw",
        password.unchecked_ref(),
        "PBKDF2",
        false,
        &usage,
    )?)
    .await?
    .unchecked_into();
    let options = object(&[
        ("name", "PBKDF2".into()),
        ("hash", "SHA-256".into()),
        ("salt", encode_utf8(salt).into()),
        ("iterations", 100_000.into()),
    ])?;
    let bits = JsFuture::from(crypto.derive_bits_with_object(&options, &key, 256)?).await?;
    Ok(hex(&Uint8Array::new(&bits)))
}
