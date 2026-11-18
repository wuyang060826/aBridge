//! A single coordinator owns connection generations, admission and local policy.
use crate::{
    executor,
    protocol::{self, Dispatch, Welcome},
    storage::{self, Config, Journal},
};
use anyhow::{bail, Context, Result};
use futures_util::{FutureExt, SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::{mpsc, oneshot},
    time::{timeout, Instant},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
};
use tokio_util::sync::CancellationToken;

pub fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
struct Control {
    request: Value,
    response: oneshot::Sender<Value>,
}
enum Event {
    Ready(u64, Welcome, mpsc::Sender<Value>),
    Frame(u64, Value),
    Disconnected(u64, bool),
    Output(u64, String, String, String),
    Finished(u64, String, Result<Value, executor::ExecError>),
}
struct Running {
    cancel: CancellationToken,
    session: String,
    capability: String,
}
struct State {
    dir: PathBuf,
    config: Config,
    journal: Journal,
    journal_ready: bool,
    details: Value,
    operations: BTreeMap<String, Running>,
    closed_sessions: BTreeSet<String>,
    epoch: u64,
    generation: u64,
    sequence: u64,
    capabilities: Vec<String>,
    connection: &'static str,
    owner: String,
    name: String,
    device_id: String,
    sender: Option<mpsc::Sender<Value>>,
    connection_cancel: CancellationToken,
    last_ack: Instant,
    lease: Duration,
    next_connect: Instant,
    backoff: u64,
}
fn local_caps(config: &Config, ready: bool) -> Value {
    Value::Object(
        protocol::contract()
            .capabilities
            .iter()
            .map(|cap| {
                let enabled = ready
                    && matches!(cap.as_str(), "shell" | "files")
                    && config.capabilities.get(cap) == Some(&true);
                (cap.clone(), Value::Bool(enabled))
            })
            .collect(),
    )
}

fn binding_snapshot(config: &Config, connection: &str, details: &Value) -> Value {
    json!({
        "connection": connection,
        "paused": config.paused,
        "revoked": config.revoked,
        "url": config.url,
        "device_id": config.device_id,
        "version": env!("ABRIDGE_VERSION"),
        "platform": "linux",
        "details": details,
    })
}

pub fn offline_snapshot(config: &Config) -> Value {
    let connection = if config.revoked { "revoked" } else { "offline" };
    let mut snapshot = binding_snapshot(config, connection, &crate::system::details());
    snapshot["capabilities"] = local_caps(config, !config.revoked);
    snapshot["active_operations"] = json!(0);
    snapshot
}

impl State {
    fn caps(&self) -> Value {
        local_caps(&self.config, self.journal_ready && !self.config.revoked)
    }
    fn snapshot(&self) -> Value {
        let mut snapshot = binding_snapshot(&self.config, self.connection, &self.details);
        snapshot["device_id"] = json!(self.device_id);
        snapshot["device_name"] = json!(self.name);
        snapshot["owner_name"] = json!(self.owner);
        snapshot["capabilities"] = self.caps();
        snapshot["active_operations"] = json!(self.operations.len());
        snapshot["journal_ready"] = json!(self.journal_ready);
        snapshot
    }
    fn cancel_all(&self) {
        for op in self.operations.values() {
            op.cancel.cancel();
        }
    }
    fn disconnect(&mut self) {
        self.connection_cancel.cancel();
        self.sender = None;
        self.cancel_all();
        self.connection = if self.config.revoked {
            "revoked"
        } else {
            "offline"
        };
        self.next_connect = Instant::now() + Duration::from_millis(self.backoff);
        self.backoff = (self.backoff * 2).min(15000);
    }
    fn send(&mut self, value: Value) {
        if self
            .sender
            .as_ref()
            .is_some_and(|tx| tx.try_send(value).is_err())
        {
            self.disconnect();
        }
    }
    fn heartbeat(&mut self) {
        self.send(json!({"type":"heartbeat","connection_epoch":self.epoch,"capabilities":self.caps(),"paused":self.config.paused}));
    }
    fn refuse(&mut self, id: &str, code: &str) {
        self.send(json!({"type":"result","operation_id":id,"connection_epoch":self.epoch,"status":"refused","result":{},"error":{"code":code,"message":"Operation refused by device"}}));
    }
    fn dispatch(&mut self, raw: Value, events: &mpsc::Sender<Event>) -> Result<()> {
        let parsed = protocol::parse("operation", raw.clone())
            .and_then(|v| Ok(serde_json::from_value::<Dispatch>(v)?));
        let frame = match parsed {
            Ok(f) => f,
            Err(_) => {
                if let Some(id) = raw["operation_id"].as_str() {
                    self.refuse(id, "invalid_dispatch");
                }
                return Ok(());
            }
        };
        let id = &frame.operation_id;
        if frame.connection_epoch != self.epoch || frame.device_id != self.device_id {
            return Ok(());
        }
        if !valid_id(id) || !valid_id(&frame.session_id) {
            self.refuse(id, "invalid_dispatch");
            return Ok(());
        }
        if self.last_ack.elapsed() >= self.lease || self.sender.is_none() {
            self.disconnect();
            return Ok(());
        }
        let limits = &protocol::contract().limits;
        if frame.expires_at <= now()
            || frame.expires_at
                > now() + limits.operation_start_seconds + limits.operation_grace_seconds
        {
            self.refuse(id, "dispatch_expired");
            return Ok(());
        }
        let Some(cap) = protocol::contract()
            .tool_capabilities
            .get(&frame.tool)
            .filter(|c| matches!(c.as_str(), "shell" | "files"))
            .cloned()
        else {
            self.refuse(id, "capability_unavailable");
            return Ok(());
        };
        let identity =
            json!({"tool":frame.tool,"arguments":frame.arguments,"session_id":frame.session_id});
        let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&identity)?));
        if let Some(prior) = self.journal.get(id) {
            let conflict = prior.request_hash != hash;
            let status = if conflict {
                "refused"
            } else if prior.status == "executing" {
                "outcome_unknown"
            } else {
                &prior.status
            };
            self.send(json!({"type":"result","operation_id":id,"connection_epoch":self.epoch,"status":status,"result":{"deduplicated":true,"prior_status":prior.status},"error":{"code":if conflict{"idempotency_conflict"}else{"duplicate_operation"},"message":"Operation was already accepted; its effect will not be replayed"}}));
            return Ok(());
        }
        if frame.sequence <= self.sequence {
            self.refuse(id, "stale_sequence");
            return Ok(());
        }
        self.sequence = frame.sequence;
        if self.config.paused || self.config.revoked {
            self.refuse(id, "device_paused");
            return Ok(());
        }
        if self.closed_sessions.contains(&frame.session_id) {
            self.refuse(id, "session_closed");
            return Ok(());
        }
        if self.config.capabilities.get(&cap) != Some(&true)
            || !self.capabilities.contains(&cap)
            || !frame.session_capabilities.contains(&cap)
        {
            self.refuse(id, "capability_unavailable");
            return Ok(());
        }
        if self.operations.len() >= limits.operations {
            self.refuse(id, "device_busy");
            return Ok(());
        }
        let args = match protocol::parse(&frame.tool, frame.arguments) {
            Ok(v) => v,
            Err(_) => {
                self.refuse(id, "invalid_arguments");
                return Ok(());
            }
        };
        if !self.journal_ready || self.journal.start(id, &hash).is_err() {
            self.journal_ready = false;
            self.refuse(id, "journal_unavailable");
            self.heartbeat();
            return Ok(());
        }
        // Synchronous durable admission reserves identity before any async work.
        let cancel = CancellationToken::new();
        self.operations.insert(
            id.clone(),
            Running {
                cancel: cancel.clone(),
                session: frame.session_id,
                capability: cap,
            },
        );
        let tx = events.clone();
        let generation = self.generation;
        let id = id.clone();
        tokio::spawn(async move {
            let (output_tx, mut output_rx) = mpsc::channel(8);
            let output_events = tx.clone();
            let output_id = id.clone();
            let output_task = tokio::spawn(async move {
                while let Some((stream, data)) = output_rx.recv().await {
                    if output_events
                        .send(Event::Output(generation, output_id.clone(), stream, data))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
            let result = std::panic::AssertUnwindSafe(executor::execute(
                &frame.tool,
                args,
                cancel.clone(),
                output_tx,
            ))
            .catch_unwind()
            .await
            .unwrap_or_else(|_| {
                Err(executor::ExecError {
                    code: "outcome_unknown".into(),
                    message: "Execution could not be confirmed".into(),
                    status: "outcome_unknown".into(),
                })
            });
            let _ = output_task.await;
            let result = if cancel.is_cancelled() {
                Err(executor::ExecError {
                    code: "operation_cancelled".into(),
                    message: "Execution interrupted; effect will not be replayed".into(),
                    status: "outcome_unknown".into(),
                })
            } else {
                result
            };
            let _ = tx.send(Event::Finished(generation, id, result)).await;
        });
        Ok(())
    }
    fn receive(&mut self, value: Value, events: &mpsc::Sender<Event>) -> Result<()> {
        if value["connection_epoch"].as_u64() != Some(self.epoch) {
            return Ok(());
        }
        match value["type"].as_str() {
            Some("heartbeat_ack") => {
                self.last_ack = Instant::now();
                if let Some(name) = value["device_name"].as_str() {
                    self.name = name.to_owned();
                }
            }
            Some("dispatch") => self.dispatch(value, events)?,
            Some("cancel") => {
                if let Some(ids) = value["operation_ids"].as_array() {
                    for id in ids {
                        if let Some(op) = id.as_str().and_then(|id| self.operations.get(id)) {
                            op.cancel.cancel();
                        }
                    }
                }
            }
            Some("session_close") => {
                if let Some(id) = value["session_id"].as_str() {
                    self.closed_sessions.insert(id.to_owned());
                    for op in self.operations.values() {
                        if op.session == id {
                            op.cancel.cancel();
                        }
                    }
                }
            }
            Some("stop") => self.cancel_all(),
            Some("revoke") => {
                self.config.revoked = true;
                self.config.paused = true;
                self.disconnect();
                storage::save(&self.dir, &self.config)?;
            }
            _ => {}
        }
        Ok(())
    }
    fn control(&mut self, request: Value) -> Result<Value> {
        match request["command"].as_str() {
            Some("status") => return Ok(self.snapshot()),
            Some("pause") => {
                self.config.paused = true;
                self.cancel_all();
                storage::save(&self.dir, &self.config)?;
            }
            Some("resume") => {
                if self.config.revoked {
                    bail!("Device revoked; bind again");
                }
                let mut next = self.config.clone();
                next.paused = false;
                storage::save(&self.dir, &next)?;
                self.config = next;
            }
            Some("stop") => {
                self.cancel_all();
                self.send(json!({"type":"local_stop","connection_epoch":self.epoch}));
            }
            Some("capability") => {
                let cap = request["capability"]
                    .as_str()
                    .filter(|s| matches!(*s, "shell" | "files"))
                    .context("Capability must be shell or files")?;
                let enabled = request["enabled"]
                    .as_bool()
                    .context("Expected enabled boolean")?;
                let mut next = self.config.clone();
                next.capabilities.insert(cap.into(), enabled);
                if !enabled {
                    self.config = next.clone();
                    for op in self.operations.values() {
                        if op.capability == cap {
                            op.cancel.cancel();
                        }
                    }
                }
                storage::save(&self.dir, &next)?;
                self.config = next;
            }
            _ => bail!("Unknown local command"),
        }
        self.heartbeat();
        Ok(self.snapshot())
    }
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
pub fn socket_path(dir: &Path) -> PathBuf {
    dir.join("control.sock")
}
pub async fn local_control(dir: &Path, request: Value) -> Result<Value> {
    storage::private_dir(dir)?;
    timeout(Duration::from_secs(15), async {
        let mut socket = UnixStream::connect(socket_path(dir))
            .await
            .context("Client is not running")?;
        socket.write_all(format!("{request}\n").as_bytes()).await?;
        let value = read_line(socket, 131072).await?;
        if value["ok"] != true {
            bail!(
                "{}",
                value["error"].as_str().unwrap_or("Local command failed")
            );
        }
        Ok(value["result"].clone())
    })
    .await
    .context("Local command timed out")?
}
async fn read_line<S: tokio::io::AsyncRead + Unpin>(stream: S, max: usize) -> Result<Value> {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    loop {
        let data = reader.fill_buf().await?;
        if data.is_empty() {
            bail!("Incomplete local message");
        }
        let count = data
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(data.len());
        if line.len() + count > max {
            bail!("Local message too large");
        }
        line.extend_from_slice(&data[..count]);
        reader.consume(count);
        if line.last() == Some(&b'\n') {
            return Ok(serde_json::from_slice(&line)?);
        }
    }
}
async fn serve_controls(
    listener: UnixListener,
    tx: mpsc::Sender<Control>,
    cancel: CancellationToken,
) {
    let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(16));
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            accepted = listener.accept() => {
                let Ok((mut socket, _)) = accepted else { break; };
                let Ok(permit) = permits.clone().try_acquire_owned() else { continue; };
                let tx = tx.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let _ = timeout(Duration::from_secs(15), async {
                        let (reader, mut writer) = socket.split();
                        let request = read_line(reader, 8192).await?;
                        let (response, rx) = oneshot::channel();
                        tx.send(Control { request, response }).await?;
                        let result = rx.await?;
                        writer.write_all(format!("{result}\n").as_bytes()).await?;
                        Ok::<_, anyhow::Error>(())
                    }).await;
                });
            }
        }
    }
}
async fn network(
    generation: u64,
    config: Config,
    caps: Value,
    details: Value,
    events: mpsc::Sender<Event>,
    cancel: CancellationToken,
) {
    let work = async {
        let mut url = url::Url::parse(&config.url)?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme)
            .map_err(|_| anyhow::anyhow!("Invalid scheme"))?;
        url.set_path(&format!(
            "{}/ws/device",
            url.path().strip_suffix('/').unwrap_or(url.path())
        ));
        let mut request = url.as_str().into_client_request()?;
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {}", config.device_key).parse()?,
        );
        let ws_config = WebSocketConfig::default()
            .max_message_size(Some(protocol::contract().limits.message_bytes))
            .max_frame_size(Some(protocol::contract().limits.message_bytes));
        let connected = timeout(
            Duration::from_secs(10),
            connect_async_with_config(request, Some(ws_config), false),
        )
        .await?;
        let (mut socket, _) = match connected {
            Ok(v) => v,
            Err(tokio_tungstenite::tungstenite::Error::Http(ref response))
                if response.status().as_u16() == 401 =>
            {
                return Ok(true)
            }
            Err(e) => return Err(e.into()),
        };
        let hello = json!({
            "type": "hello",
            "protocol": protocol::contract().protocol,
            "platform": "linux",
            "version": env!("ABRIDGE_VERSION"),
            "capabilities": caps,
            "paused": config.paused,
            "details": details,
        });
        timeout(
            Duration::from_secs(5),
            socket.send(Message::Text(hello.to_string().into())),
        )
        .await??;
        let welcome = timeout(Duration::from_secs(10), async {
            while let Some(message) = socket.next().await {
                match message? {
                    Message::Text(text) => {
                        return Ok::<_, anyhow::Error>(serde_json::from_str::<Value>(&text)?)
                    }
                    Message::Ping(data) => socket.send(Message::Pong(data)).await?,
                    Message::Close(_) => bail!("Connection closed"),
                    _ => {}
                }
            }
            bail!("Connection closed")
        })
        .await??;
        let welcome: Welcome = serde_json::from_value(protocol::parse("welcome", welcome)?)?;
        if config
            .device_id
            .as_ref()
            .is_some_and(|id| id != &welcome.device_id)
        {
            bail!("Device identity mismatch");
        }
        let (sender, mut outgoing) = mpsc::channel::<Value>(64);
        events
            .send(Event::Ready(generation, welcome, sender))
            .await?;
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => break,
                value = outgoing.recv() => {
                    let Some(value) = value else { break; };
                    timeout(Duration::from_secs(5), socket.send(Message::Text(value.to_string().into()))).await??;
                }
                message = socket.next() => match message {
                    Some(Ok(Message::Text(text))) => {
                        let frame = serde_json::from_str(&text)?;
                        events.send(Event::Frame(generation, frame)).await?;
                    }
                    Some(Ok(Message::Ping(data))) => {
                        timeout(Duration::from_secs(5), socket.send(Message::Pong(data))).await??;
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    _ => break,
                },
            }
        }
        Ok::<bool, anyhow::Error>(false)
    };
    let revoked =
        tokio::select! {biased;_=cancel.cancelled()=>false,result=work=>result.unwrap_or(false)};
    let _ = events.send(Event::Disconnected(generation, revoked)).await;
}

pub async fn run(dir: PathBuf) -> Result<()> {
    let _lock = storage::lock(&dir)?;
    let config = storage::load(&dir)?;
    crate::normalize_server(&config.url, config.http_confirmed_origin.as_deref())?;
    let details = tokio::task::spawn_blocking(crate::system::details).await?;
    // Lock ownership makes replacement of a stale socket safe.
    let path = socket_path(&dir);
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        use std::os::unix::fs::FileTypeExt;
        if !metadata.file_type().is_socket() {
            bail!("Control path is not a socket");
        }
        fs::remove_file(&path)?;
    }
    let listener = UnixListener::bind(&path)
        .context("Cannot create private control socket (state path may be too long)")?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let journal = Journal::open(&dir)?;
    let (control_tx, mut controls) = mpsc::channel(16);
    let (events, mut incoming) = mpsc::channel(64);
    let shutdown = CancellationToken::new();
    let control_task = tokio::spawn(serve_controls(listener, control_tx, shutdown.clone()));
    let signal = shutdown.clone();
    let signal_task = tokio::spawn(async move {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
        signal.cancel();
    });
    let mut state = State {
        dir: dir.clone(),
        device_id: config.device_id.clone().unwrap_or_default(),
        connection: if config.revoked { "revoked" } else { "offline" },
        config,
        journal,
        journal_ready: true,
        details,
        operations: BTreeMap::new(),
        closed_sessions: BTreeSet::new(),
        epoch: 0,
        generation: 0,
        sequence: 0,
        capabilities: Vec::new(),
        owner: String::new(),
        name: String::new(),
        sender: None,
        connection_cancel: CancellationToken::new(),
        last_ack: Instant::now(),
        lease: Duration::from_secs_f64(protocol::contract().limits.lease_seconds),
        next_connect: Instant::now(),
        backoff: 1000,
    };
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut heartbeat_at = Instant::now();
    // Control replies that stop work wait for actual cleanup, without blocking the coordinator.
    let mut waiting: Vec<(BTreeSet<String>, oneshot::Sender<Value>, Value)> = Vec::new();
    let result: Result<()> = async {
        loop {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => break,
                Some(control) = controls.recv() => {
                    let command = control.request["command"].as_str().unwrap_or("").to_owned();
                    let response = match state.control(control.request) {
                        Ok(value) => json!({"ok": true, "result": value}),
                        Err(_) => json!({"ok": false, "error": "Local command failed; check binding and state permissions"}),
                    };
                    let pending = state.operations.iter()
                        .filter(|(_, op)| op.cancel.is_cancelled())
                        .map(|(id, _)| id.clone()).collect::<BTreeSet<_>>();
                    if !pending.is_empty() && command != "status" {
                        waiting.push((pending, control.response, response));
                    } else {
                        let _ = control.response.send(response);
                    }
                },
                Some(event) = incoming.recv() => match event {
                    Event::Ready(g, welcome, sender)
                        if g == state.generation && !state.connection_cancel.is_cancelled() => {
                        state.epoch = welcome.connection_epoch;
                        state.device_id = welcome.device_id;
                        state.name = welcome.device_name.unwrap_or_default();
                        state.owner = welcome.owner_name;
                        state.capabilities = welcome.capabilities;
                        state.sender = Some(sender);
                        state.sequence = 0;
                        state.closed_sessions.clear();
                        state.last_ack = Instant::now();
                        state.lease = Duration::from_secs_f64(welcome.lease_seconds.clamp(
                            1., protocol::contract().limits.lease_seconds,
                        ));
                        state.connection = "online";
                        eprintln!("Device connected to Server");
                        state.backoff = 1000;
                        heartbeat_at = Instant::now();
                        state.heartbeat();
                    },
                    Event::Frame(g, value) if g == state.generation && state.sender.is_some() => {
                        state.receive(value, &events)?;
                    },
                    Event::Disconnected(g, revoked) if g == state.generation => {
                        if revoked {
                            state.config.revoked = true;
                            state.config.paused = true;
                        }
                        state.disconnect();
                        if revoked {
                            storage::save(&dir, &state.config)?;
                            eprintln!("Device credential revoked; bind this device again");
                        } else {
                            eprintln!("Server connection unavailable; retrying");
                        }
                    },
                    Event::Output(g, id, stream, data)
                        if g == state.generation && state.sender.is_some() => {
                        if state.operations.get(&id).is_some_and(|op| !op.cancel.is_cancelled()) {
                            state.send(json!({"type": "output", "operation_id": id,
                                "connection_epoch": state.epoch, "stream": stream, "data": data}));
                        }
                    },
                    Event::Finished(g, id, result) => {
                        let (status, result, error) = match result {
                            Ok(value) => ("executed".to_owned(), value, None),
                            Err(error) => (error.status, json!({}),
                                Some(json!({"code": error.code, "message": error.message}))),
                        };
                        // Completion has already arrived: a failed journal write must not
                        // make shutdown wait for a second completion that will never arrive.
                        state.operations.remove(&id);
                        let journal_failed = state.journal.finish(&id, &status).is_err();
                        if journal_failed {
                            state.journal_ready = false;
                            eprintln!("Operation journal unavailable; restart after repairing storage");
                        }
                        if g == state.generation && state.sender.is_some() {
                            let mut value = json!({"type": "result", "operation_id": id,
                                "connection_epoch": state.epoch, "status": status, "result": result});
                            if let Some(error) = error { value["error"] = error; }
                            if journal_failed {
                                value["result"]["journal_error"] = json!({
                                    "code": "journal_unavailable",
                                    "message": "The receipt was not persisted; further operations are disabled until restart"
                                });
                            }
                            state.send(value);
                            if journal_failed { state.heartbeat(); }
                        }
                        let mut index = 0;
                        while index < waiting.len() {
                            if waiting[index].0.iter().all(|id| !state.operations.contains_key(id)) {
                                let (_, reply, mut response) = waiting.swap_remove(index);
                                if response["ok"] == true { response["result"] = state.snapshot(); }
                                let _ = reply.send(response);
                            } else { index += 1; }
                        }
                    },
                    _ => {},
                },
                _ = tick.tick() => {
                    if state.sender.is_some() {
                        if state.last_ack.elapsed() >= state.lease {
                            state.disconnect();
                        } else if heartbeat_at.elapsed().as_secs_f64()
                            >= protocol::contract().limits.heartbeat_seconds {
                            state.heartbeat();
                            heartbeat_at = Instant::now();
                        }
                    }
                    if state.sender.is_none() && state.connection != "connecting"
                        && !state.config.revoked && state.operations.is_empty()
                        && Instant::now() >= state.next_connect {
                        state.generation += 1;
                        state.connection = "connecting";
                        state.connection_cancel = CancellationToken::new();
                        tokio::spawn(network(state.generation, state.config.clone(), state.caps(), state.details.clone(),
                            events.clone(), state.connection_cancel.clone()));
                    }
                }
            }
        }
        Ok(())
    }.await;
    shutdown.cancel();
    state.disconnect();
    // Drain completion events while cancellation cleans pipes and process groups.
    while !state.operations.is_empty() {
        match incoming.recv().await {
            Some(Event::Finished(_, id, result)) => {
                let status = result
                    .map(|_| "executed".into())
                    .unwrap_or_else(|e| e.status);
                let _ = state.journal.finish(&id, &status);
                state.operations.remove(&id);
            }
            Some(_) => {}
            None => break,
        }
    }
    signal_task.abort();
    let _ = control_task.await;
    let _ = fs::remove_file(path);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    fn journal_write_failure_preserves_receipt_and_does_not_hang_shutdown() {
        // Limit only a dedicated subprocess: the shared test runner and other
        // tests must never inherit a changed file-size limit or signal handler.
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "runtime::tests::journal_failure_child",
                "--ignored",
                "--nocapture",
            ])
            .env("ABRIDGE_JOURNAL_FAILURE_CHILD", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            if child.try_wait().unwrap().is_some() {
                let output = child.wait_with_output().unwrap();
                assert!(
                    output.status.success(),
                    "isolated journal failure test failed:\n{}\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                break;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("journal persistence failure left the client running");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[tokio::test(flavor = "current_thread")]
    #[ignore = "Run only in the isolated subprocess created by the parent test"]
    async fn journal_failure_child() {
        if std::env::var("ABRIDGE_JOURNAL_FAILURE_CHILD").as_deref() != Ok("1") {
            return;
        }
        let dir = PathBuf::from(format!(
            "/tmp/abridge-journal-failure-{}",
            std::process::id()
        ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = Config {
            url: format!("http://{}", listener.local_addr().unwrap()),
            device_key: "abr_device_journal_fixture".into(),
            capabilities: BTreeMap::from([("shell".into(), true), ("files".into(), true)]),
            paused: false,
            revoked: false,
            http_confirmed_origin: None,
            device_id: Some("fixture-device".into()),
        };
        storage::save(&dir, &config).unwrap();
        let client = tokio::spawn(run(dir.clone()));
        let (stream, _) = timeout(Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        let hello = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&hello).unwrap()["type"],
            "hello"
        );
        socket
            .send(Message::Text(
                json!({
                    "type": "welcome", "protocol": protocol::contract().protocol,
                    "device_id": "fixture-device", "connection_epoch": 1,
                    "capabilities": ["shell", "files"], "owner_name": "Fixture",
                    "lease_seconds": 30, "heartbeat_interval": 10
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        socket
            .send(Message::Text(
                json!({
                    "type": "dispatch", "protocol": protocol::contract().protocol,
                    "device_id": "fixture-device", "connection_epoch": 1,
                    "device_credential_version": 1, "sequence": 1,
                    "session_capabilities": ["shell"], "operation_id": "op_Fixture1",
                    "session_id": "ses_Fixture1", "expires_at": now() + 30.,
                    "tool": "command_execute", "arguments": {"command": "sleep 0.5", "timeout": 5}
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        let journal_path = dir.join("journal.jsonl");
        let length = timeout(Duration::from_secs(5), async {
            loop {
                let length = fs::metadata(&journal_path).map(|m| m.len()).unwrap_or(0);
                if length > 0 {
                    break length;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        // The execution intent is durable; make the later terminal append fail.
        // Dropping/chmod'ing the pathname would not fail an already-open fd.
        let mut original = std::mem::MaybeUninit::<libc::rlimit>::uninit();
        assert_eq!(
            unsafe { libc::getrlimit(libc::RLIMIT_FSIZE, original.as_mut_ptr()) },
            0
        );
        let original = unsafe { original.assume_init() };
        let limited = libc::rlimit {
            rlim_cur: length as libc::rlim_t,
            rlim_max: original.rlim_max,
        };
        let old_signal = unsafe { libc::signal(libc::SIGXFSZ, libc::SIG_IGN) };
        assert_ne!(old_signal, libc::SIG_ERR);
        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &limited) }, 0);
        let receipt = timeout(Duration::from_secs(5), async {
            loop {
                let text = socket.next().await.unwrap().unwrap().into_text().unwrap();
                let frame: Value = serde_json::from_str(&text).unwrap();
                if frame["type"] == "result" && frame["operation_id"] == "op_Fixture1" {
                    break frame;
                }
            }
        })
        .await
        .expect("the completed operation must still publish its receipt");
        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &original) }, 0);
        unsafe { libc::signal(libc::SIGXFSZ, old_signal) };
        assert_eq!(receipt["status"], "executed");
        assert_eq!(
            receipt["result"]["journal_error"]["code"],
            "journal_unavailable"
        );
        let status = local_control(&dir, json!({"command":"status"}))
            .await
            .unwrap();
        assert_eq!(status["journal_ready"], false);
        assert_eq!(status["capabilities"]["shell"], false);
        assert_eq!(unsafe { libc::kill(libc::getpid(), libc::SIGTERM) }, 0);
        timeout(Duration::from_secs(5), client)
            .await
            .expect("completed operation must not remain in shutdown's pending set")
            .expect("client task must not panic")
            .expect("client must shut down cleanly after reporting the failure");
        assert!(
            storage::lock(&dir).is_ok(),
            "runtime must release its device lock"
        );
        let recovered = Journal::open(&dir).unwrap();
        assert_eq!(
            recovered.get("op_Fixture1").unwrap().status,
            "outcome_unknown"
        );
        drop(recovered);
        fs::remove_dir_all(dir).unwrap();
    }
}
