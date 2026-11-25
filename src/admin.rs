// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

//! The admin page's data (`/admin`): every `AgentSandbox` the kubeconfig may list, the banlieue
//! `VirtualMachine`s (the gateways and the pools' members), the `SandboxPolicy`s, and the
//! gateways' decisions. Watched once for every viewer, from the first viewer on; each viewer gets
//! the whole picture, then each change, over one server-sent event stream.
//!
//! SPIRE and OpenBao, as far as they show: the claims' `ClusterStaticEntry`s (mediatore
//! ADR-0006), and the sealed Secrets in the broker's namespace, watched as metadata only (their
//! data is never requested: the metadata API returns none), each one an envelope OpenBao's
//! transit key sealed.
//!
//! Where the decisions come from: `status.egress` on the `AgentSandbox` (mediatore ADR-0063,
//! proposed) when the broker writes it, else the broker's own log, one "gateway decision" line
//! per decision (ADR-0062), folded here into the same shape. Read-only throughout: nothing on
//! this page changes the cluster, and Secrets are not watched at all.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::{StreamExt as _, TryStreamExt as _};
use kube::api::{ApiResource, DynamicObject, GroupVersionKind};
use kube::runtime::{WatchStreamExt as _, watcher};
use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::egress::Decision;

/// A Secret's metadata, without its data.
type SecretMeta = kube::core::PartialObjectMeta<k8s_openapi::api::core::v1::Secret>;
use crate::util::str_at;

/// What is watched, cluster-wide: the page's name for it, then group, version, kind, plural.
const KINDS: [(&str, &str, &str, &str, &str); 11] = [
    (
        "sandbox",
        "mediatore.io",
        "v1beta1",
        "AgentSandbox",
        "agentsandboxes",
    ),
    (
        "vm",
        "banlieue.io",
        "v1alpha1",
        "VirtualMachine",
        "virtualmachines",
    ),
    (
        "policy",
        "sandbox.firestoned.io",
        "v1alpha2",
        "SandboxPolicy",
        "sandboxpolicies",
    ),
    // Each policy's approved maximum (notaio ADR-0007): the same name, in its namespace.
    (
        "ceiling",
        "sandbox.firestoned.io",
        "v1alpha2",
        "ExposureCeiling",
        "exposureceilings",
    ),
    (
        "pool",
        "banlieue.io",
        "v1alpha1",
        "VirtualMachinePool",
        "virtualmachinepools",
    ),
    (
        "entry",
        "spire.spiffe.io",
        "v1alpha1",
        "ClusterStaticEntry",
        "clusterstaticentries",
    ),
    // What the cross-references run through: mediatore's node registry (one per attested
    // guest, by EK hash) and policy floors; banlieue's machines, providers; faubourg's hosts.
    (
        "node",
        "mediatore.io",
        "v1alpha1",
        "SandboxNode",
        "sandboxnodes",
    ),
    (
        "floor",
        "mediatore.io",
        "v1alpha1",
        "PolicyFloor",
        "policyfloors",
    ),
    (
        "machine",
        "infrastructure.banlieue.io",
        "v1alpha1",
        "LibvirtMachine",
        "libvirtmachines",
    ),
    (
        "provider",
        "banlieue.io",
        "v1alpha1",
        "Provider",
        "providers",
    ),
    (
        "host",
        "faubourg.firestoned.io",
        "v1alpha1",
        "Host",
        "hosts",
    ),
];

/// Where the page finds what Recess derived from an object, beside the object's own fields.
const DERIVED: &str = "x-recess";

/// The EK hash of a VM's TPM, from `status.tpmEndorsementCertificates`, as mediatore computes it
/// (`ek_hash_from_pems`): the key its SandboxNode, its SPIRE node entry and its agent's SPIFFE
/// ID are named by.
fn ek_hash_of(v: &Value) -> Option<String> {
    let pems: Vec<&str> = v
        .pointer("/status/tpmEndorsementCertificates")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    if pems.is_empty() {
        return None;
    }
    mediatore_proto::ek::ek_hash_from_pems(&pems).ok()
}

/// The sealed Secrets, as metadata: the page's name for each set, and its label selector. The
/// session and delegation envelopes carry the sandbox's UID; the output segments, the claim's.
const ENVELOPES: [(&str, &str); 2] = [
    ("envelope", "mediatore.io/sandbox-uid"),
    ("segment", "mediatore.io/logs=segment"),
];

/// Routes kept per claim, the bound ADR-0063 puts on `status.egress.routes`; past it a
/// decision is only counted.
pub const MAX_ROUTES: usize = 32;

/// How long a claim's decisions read from the log are kept after its last one.
const EGRESS_KEEP: Duration = Duration::from_hours(2);

/// The shared picture and the stream of its changes.
pub struct Fleet {
    inner: Mutex<Inner>,
    tx: broadcast::Sender<Arc<str>>,
    started: AtomicBool,
}

#[derive(Default)]
struct Inner {
    /// By `kind/namespace/name` (or `egress/<claim uid>`): the kind and the object.
    items: BTreeMap<String, (String, Value)>,
    /// What could not be watched, by kind.
    notes: BTreeMap<String, String>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Fleet {
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner::default()),
            tx: broadcast::channel(4096).0,
            started: AtomicBool::new(false),
        })
    }

    /// True once only: the first viewer starts the watches.
    pub fn first(&self) -> bool {
        !self.started.swap(true, Ordering::SeqCst)
    }

    // Sent under the lock, so a viewer's snapshot and the changes after it never overlap.
    fn send(&self, msg: &Value) {
        let _ = self.tx.send(Arc::from(msg.to_string()));
    }

    pub fn put(&self, kind: &str, key: String, obj: Value) {
        let mut g = lock(&self.inner);
        if g.items.get(&key).is_some_and(|(_, o)| *o == obj) {
            return;
        }
        self.send(&json!({"op": "put", "kind": kind, "key": key, "obj": obj}));
        g.items.insert(key, (kind.to_owned(), obj));
    }

    pub fn del(&self, key: &str) {
        let mut g = lock(&self.inner);
        if g.items.remove(key).is_some() {
            self.send(&json!({"op": "del", "key": key}));
        }
    }

    /// After a (re)list: the kind's items are exactly `fresh`.
    fn reset(&self, kind: &str, fresh: BTreeMap<String, Value>) {
        let stale: Vec<String> = lock(&self.inner)
            .items
            .iter()
            .filter(|(k, (kd, _))| kd == kind && !fresh.contains_key(*k))
            .map(|(k, _)| k.clone())
            .collect();
        for k in stale {
            self.del(&k);
        }
        for (k, v) in fresh {
            self.put(kind, k, v);
        }
    }

    /// Why `kind` cannot be shown, or "" once it can.
    pub fn note(&self, kind: &str, text: &str) {
        let mut g = lock(&self.inner);
        if g.notes.get(kind).map_or("", String::as_str) == text {
            return;
        }
        if text.is_empty() {
            g.notes.remove(kind);
        } else {
            g.notes.insert(kind.to_owned(), text.to_owned());
        }
        self.send(&json!({"op": "note", "kind": kind, "text": text}));
    }

    /// The whole picture as one message, and the changes after it.
    pub fn subscribe(&self) -> (String, broadcast::Receiver<Arc<str>>) {
        let g = lock(&self.inner);
        let rx = self.tx.subscribe();
        let items: Vec<Value> = g
            .items
            .iter()
            .map(|(k, (kind, o))| json!({"key": k, "kind": kind, "obj": o}))
            .collect();
        (
            json!({"op": "snapshot", "items": items, "notes": g.notes}).to_string(),
            rx,
        )
    }
}

/// An object as the page gets it: without its managed fields and last-applied copy.
fn keyed(kind: &str, obj: &DynamicObject) -> (String, Value) {
    let mut v = serde_json::to_value(obj).unwrap_or_default();
    if let Some(m) = v.pointer_mut("/metadata").and_then(Value::as_object_mut) {
        m.remove("managedFields");
    }
    if let Some(a) = v
        .pointer_mut("/metadata/annotations")
        .and_then(Value::as_object_mut)
    {
        a.remove("kubectl.kubernetes.io/last-applied-configuration");
    }
    let key = format!(
        "{kind}/{}/{}",
        str_at(&v, "/metadata/namespace"),
        str_at(&v, "/metadata/name")
    );
    if kind == "vm"
        && let Some(h) = ek_hash_of(&v)
    {
        v[DERIVED] = json!({"ekHash": h});
    }
    (key, v)
}

/// Start the watches, and the reading of the broker's log in `broker_ns` (none when empty).
/// Their handles stop them, when the person they were started for signs out.
pub fn spawn(
    fleet: &Arc<Fleet>,
    client: &kube::Client,
    broker_ns: String,
) -> Vec<tokio::task::AbortHandle> {
    let mut tasks = Vec::new();
    for (kind, group, version, k, plural) in KINDS {
        let ar =
            ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(group, version, k), plural);
        let api: kube::Api<DynamicObject> = kube::Api::all_with(client.clone(), &ar);
        tasks.push(tokio::spawn(watch_kind(fleet.clone(), api, kind)).abort_handle());
    }
    if !broker_ns.is_empty() {
        for (kind, selector) in ENVELOPES {
            let api: kube::Api<SecretMeta> = kube::Api::namespaced(client.clone(), &broker_ns);
            tasks.push(
                tokio::spawn(watch_envelopes(fleet.clone(), api, kind, selector)).abort_handle(),
            );
        }
    }
    tasks.push(
        tokio::spawn(read_decisions(fleet.clone(), client.clone(), broker_ns)).abort_handle(),
    );
    tasks
}

/// Only mediatore's own SPIRE entries are kept: the cluster may hold many others.
fn wanted(kind: &str, key: &str) -> bool {
    kind != "entry" || key.starts_with("entry//mediatore-")
}

async fn watch_kind(fleet: Arc<Fleet>, api: kube::Api<DynamicObject>, kind: &'static str) {
    let mut stream = watcher(api, watcher::Config::default())
        .default_backoff()
        .boxed();
    let mut fresh: Option<BTreeMap<String, Value>> = None;
    loop {
        match stream.try_next().await {
            Ok(Some(ev)) => {
                fleet.note(kind, "");
                match ev {
                    watcher::Event::Init => fresh = Some(BTreeMap::new()),
                    watcher::Event::InitApply(o) => {
                        if let Some(f) = fresh.as_mut() {
                            let (k, v) = keyed(kind, &o);
                            if wanted(kind, &k) {
                                f.insert(k, v);
                            }
                        }
                    }
                    watcher::Event::InitDone => {
                        if let Some(f) = fresh.take() {
                            fleet.reset(kind, f);
                        }
                    }
                    watcher::Event::Apply(o) => {
                        let (k, v) = keyed(kind, &o);
                        if wanted(kind, &k) {
                            fleet.put(kind, k, v);
                        }
                    }
                    watcher::Event::Delete(o) => fleet.del(&keyed(kind, &o).0),
                }
            }
            Ok(None) => {
                fleet.note(kind, "the watch ended");
                return;
            }
            // The backoff retries; the page says why until it works.
            Err(e) => fleet.note(kind, &e.to_string()),
        }
    }
}

/// A sealed Secret as the page gets it: its name, mediatore's labels and annotations, and when
/// it was made. Never its data, which a metadata watch does not carry.
fn envelope(kind: &str, m: &SecretMeta) -> (String, Value) {
    let md = &m.metadata;
    let name = md.name.clone().unwrap_or_default();
    let ns = md.namespace.clone().unwrap_or_default();
    let ours = |map: &Option<BTreeMap<String, String>>| -> BTreeMap<String, String> {
        map.iter()
            .flatten()
            .filter(|(k, _)| k.starts_with("mediatore.io/"))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    };
    (
        format!("{kind}/{ns}/{name}"),
        json!({"name": name, "namespace": ns, "labels": ours(&md.labels), "annotations": ours(&md.annotations),
            "created": md.creation_timestamp.as_ref().map(|t| t.0.to_string()).unwrap_or_default()}),
    )
}

async fn watch_envelopes(
    fleet: Arc<Fleet>,
    api: kube::Api<SecretMeta>,
    kind: &'static str,
    selector: &'static str,
) {
    let cfg = watcher::Config::default().labels(selector);
    // An Api of metadata asks for metadata only: the Secrets' data never crosses the wire.
    let mut stream = watcher(api, cfg).default_backoff().boxed();
    let mut fresh: Option<BTreeMap<String, Value>> = None;
    loop {
        match stream.try_next().await {
            Ok(Some(ev)) => {
                fleet.note(kind, "");
                match ev {
                    watcher::Event::Init => fresh = Some(BTreeMap::new()),
                    watcher::Event::InitApply(m) => {
                        if let Some(f) = fresh.as_mut() {
                            let (k, v) = envelope(kind, &m);
                            f.insert(k, v);
                        }
                    }
                    watcher::Event::InitDone => {
                        if let Some(f) = fresh.take() {
                            fleet.reset(kind, f);
                        }
                    }
                    watcher::Event::Apply(m) => {
                        let (k, v) = envelope(kind, &m);
                        fleet.put(kind, k, v);
                    }
                    watcher::Event::Delete(m) => fleet.del(&envelope(kind, &m).0),
                }
            }
            Ok(None) => {
                fleet.note(kind, "the watch ended");
                return;
            }
            Err(e) => fleet.note(kind, &e.to_string()),
        }
    }
}

/// One host a claim's traffic went to through one gateway, with one verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Route {
    count: u64,
    first_at: String,
    last_at: String,
}

/// (gateway, kind, authority, audience, verdict, reason): ADR-0063's key for an entry.
type RouteKey = (String, String, String, String, String, String);

/// One claim's decisions, folded as ADR-0063 folds them onto `status.egress`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Folded {
    /// Gateway checks from a broker without ADR-0062 ("claim egress answered to the gateway"):
    /// how many, how many refused, the last; which gateway and which host are not in them.
    checks: u64,
    refused: u64,
    last_check: String,
    routes: BTreeMap<RouteKey, Route>,
    /// Decisions no entry counts: those past the bound, and the counts of evicted entries.
    overflow: u64,
    updated: String,
}

impl Folded {
    /// Count `d` into its entry. With [`MAX_ROUTES`] kept, a new entry evicts the deny entry
    /// seen longest ago, its count moving to the overflow; with no deny to evict, `d` itself
    /// is overflow. So a workload spraying hosts churns its own refusals, never its allows.
    pub fn add(&mut self, d: &Decision) {
        let key = (
            d.gateway.clone(),
            d.kind.clone(),
            d.authority.clone(),
            d.audience.clone(),
            d.verdict.clone(),
            d.reason.clone(),
        );
        if d.at > self.updated {
            self.updated.clone_from(&d.at);
        }
        if let Some(r) = self.routes.get_mut(&key) {
            r.count += 1;
            if d.at > r.last_at {
                r.last_at.clone_from(&d.at);
            }
            return;
        }
        if self.routes.len() >= MAX_ROUTES {
            let oldest_deny = self
                .routes
                .iter()
                .filter(|(k, _)| k.4 == "deny")
                .min_by(|a, b| a.1.last_at.cmp(&b.1.last_at))
                .map(|(k, _)| k.clone());
            let Some(k) = oldest_deny else {
                self.overflow += 1;
                return;
            };
            if let Some(r) = self.routes.remove(&k) {
                self.overflow += r.count;
            }
        }
        self.routes.insert(
            key,
            Route {
                count: 1,
                first_at: d.at.clone(),
                last_at: d.at.clone(),
            },
        );
    }

    /// The `status.egress` shape (ADR-0063), so the page reads both sources the same way:
    /// entries newest first, an empty audience or reason left out, the overflow only when set.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut entries: Vec<(&RouteKey, &Route)> = self.routes.iter().collect();
        entries.sort_by(|a, b| b.1.last_at.cmp(&a.1.last_at).then_with(|| a.0.cmp(b.0)));
        let routes: Vec<Value> = entries
            .into_iter()
            .map(|((gateway, kind, authority, audience, verdict, reason), r)| {
                let mut e = json!({"gateway": gateway, "kind": kind, "authority": authority,
                    "verdict": verdict, "count": r.count, "firstAt": r.first_at, "lastAt": r.last_at});
                if !audience.is_empty() {
                    e["audience"] = json!(audience);
                }
                if !reason.is_empty() {
                    e["reason"] = json!(reason);
                }
                e
            })
            .collect();
        let mut out = json!({"updatedAt": self.updated, "routes": routes});
        if self.overflow > 0 {
            out["overflow"] = json!(self.overflow);
        }
        out
    }
}

/// A claim's summary read from the broker's log, as the page gets it beside the sandboxes.
fn from_log(claim_uid: &str, f: &Folded) -> Value {
    json!({"claimUid": claim_uid, "source": "broker log", "egress": f.to_json(),
        "checks": {"count": f.checks, "refused": f.refused, "lastAt": f.last_check}})
}

/// The broker's log, every 3 s: each "gateway decision" line, folded by claim. Says once
/// when the log cannot be read (no RBAC on pods/log in the broker's namespace, or no broker).
async fn read_decisions(fleet: Arc<Fleet>, client: kube::Client, broker_ns: String) {
    use k8s_openapi::api::core::v1::Pod;
    if broker_ns.is_empty() {
        return;
    }
    let pods: kube::Api<Pod> = kube::Api::namespaced(client, &broker_ns);
    let list = kube::api::ListParams::default().labels("app.kubernetes.io/name=mediatore");
    let mut folded: BTreeMap<String, (Folded, std::time::Instant)> = BTreeMap::new();
    // The newest line read from each pod: a later read starts after it.
    let mut newest: BTreeMap<String, String> = BTreeMap::new();
    let mut newest_check: BTreeMap<String, String> = BTreeMap::new();
    let mut since: i64 = 3600;
    loop {
        let mut error = String::new();
        let mut changed: Vec<String> = Vec::new();
        match pods.list(&list).await {
            Ok(found) => {
                for pod in found {
                    let Some(name) = pod.metadata.name else {
                        continue;
                    };
                    let params = kube::api::LogParams {
                        since_seconds: Some(since),
                        ..Default::default()
                    };
                    match pods.logs(&name, &params).await {
                        Ok(text) => {
                            let cmark = newest_check.entry(name.clone()).or_default();
                            for (uid, c) in crate::egress::all_checks(&text) {
                                if c.at <= *cmark {
                                    continue;
                                }
                                let e = folded.entry(uid.clone()).or_insert_with(|| {
                                    (Folded::default(), std::time::Instant::now())
                                });
                                e.0.checks += 1;
                                if !c.live {
                                    e.0.refused += 1;
                                }
                                if c.at > e.0.last_check {
                                    e.0.last_check.clone_from(&c.at);
                                }
                                e.1 = std::time::Instant::now();
                                changed.push(uid);
                                cmark.clone_from(&c.at);
                            }
                            let mark = newest.entry(name).or_default();
                            for d in crate::egress::decisions(&text) {
                                if d.at <= *mark {
                                    continue;
                                }
                                let e = folded.entry(d.claim_uid.clone()).or_insert_with(|| {
                                    (Folded::default(), std::time::Instant::now())
                                });
                                e.0.add(&d);
                                e.1 = std::time::Instant::now();
                                changed.push(d.claim_uid.clone());
                                mark.clone_from(&d.at);
                            }
                        }
                        Err(e) => error = format!("the broker's log in {broker_ns} not read: {e}"),
                    }
                }
            }
            Err(e) => error = format!("the broker's pods in {broker_ns} not listed: {e}"),
        }
        fleet.note("egress", &error);
        changed.sort();
        changed.dedup();
        for uid in changed {
            if let Some((f, _)) = folded.get(&uid) {
                fleet.put("egress", format!("egress/{uid}"), from_log(&uid, f));
            }
        }
        folded.retain(|uid, (_, at)| {
            let keep = at.elapsed() < EGRESS_KEEP;
            if !keep {
                fleet.del(&format!("egress/{uid}"));
            }
            keep
        });
        since = 15;
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

// ------------------------------------------------------------------------------ one sandbox's output

/// One sandbox's output, for the admin page's Output tab: the broker's own stream
/// (`GET /v1/claims/{name}/logs`, the last 1000 records then live), as the signed-in user.
/// The broker lets only a sandbox's owner read it, so anyone else's is refused, and said so.
/// Each item is one event for the page: `line`, `gap`, `header`, `end`, `closed` or `error`.
pub fn output(
    claim: crate::settings::ClaimSettings,
    ns: String,
    name: String,
    demo: bool,
) -> futures::stream::BoxStream<'static, Value> {
    if demo {
        return demo_output(name).boxed();
    }
    futures::stream::once(async move { open_output(&claim, &ns, &name).await })
        .flat_map(|opened| match opened {
            Ok(resp) => records(resp).boxed(),
            Err(text) => futures::stream::iter([json!({"t": "error", "text": text})]).boxed(),
        })
        .boxed()
}

async fn open_output(
    claim: &crate::settings::ClaimSettings,
    ns: &str,
    name: &str,
) -> Result<reqwest::Response, String> {
    let path = crate::engine::session_path().map_err(|e| format!("no mediatore session: {e}"))?;
    let session = mediatore_client::Session::load(&path).map_err(|_| {
        "no mediatore session on this machine: sign in first (in the Classic or AgentSandbox view); \
         the broker shows a sandbox's output only to its owner"
            .to_owned()
    })?;
    if !session.is_fresh(30) {
        return Err(
            "your mediatore session has expired: sign in again (in the Classic or AgentSandbox view)"
                .into(),
        );
    }
    let api = crate::engine::user_api(claim).map_err(|e| format!("{e:#}"))?;
    let query = mediatore_client::logs::LogsQuery {
        follow: true,
        since: None,
        tail: Some(1000),
    };
    api.logs(&session, name, Some(ns), &query)
        .await
        .map_err(|e| refusal(&format!("{e:#}")))
}

/// The broker's refusal, in the page's words.
fn refusal(e: &str) -> String {
    if e.contains("403") {
        "The broker shows a sandbox's output only to its owner, and this one belongs to someone \
         else: your session's subject is not the claim's."
            .into()
    } else if e.contains("404") {
        "The broker no longer knows this claim: its record is past retention.".into()
    } else if e.contains("501") {
        "This broker stores no workload output (logs are not enabled).".into()
    } else if e.contains("401") {
        "The broker refused your session: sign in again.".into()
    } else {
        e.to_owned()
    }
}

/// The broker's NDJSON stream, one page event per record.
fn records(resp: reqwest::Response) -> impl futures::Stream<Item = Value> {
    let start = (
        resp,
        Vec::<u8>::new(),
        std::collections::VecDeque::<Value>::new(),
        false,
    );
    futures::stream::unfold(start, |(mut resp, mut buf, mut out, mut done)| async move {
        loop {
            if let Some(v) = out.pop_front() {
                return Some((v, (resp, buf, out, done)));
            }
            if done {
                return None;
            }
            match resp.chunk().await {
                Ok(Some(c)) => {
                    buf.extend_from_slice(&c);
                    while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                        let raw: Vec<u8> = buf.drain(..=pos).collect();
                        if let Some(v) = output_event(String::from_utf8_lossy(&raw).trim()) {
                            out.push_back(v);
                        }
                    }
                }
                Ok(None) => {
                    done = true;
                    out.push_back(json!({"t": "closed"}));
                }
                Err(e) => {
                    done = true;
                    out.push_back(json!({"t": "error", "text": format!("the stream broke: {e}")}));
                }
            }
        }
    })
}

/// One NDJSON line of the broker's stream as a page event; a keepalive or a line it cannot
/// read is none. Control characters are escaped, as the run view escapes them.
fn output_event(text: &str) -> Option<Value> {
    use mediatore_proto::{LogLine, LogStream};
    if text.is_empty() {
        return None;
    }
    Some(match serde_json::from_str::<LogLine>(text).ok()? {
        LogLine::Header(h) => json!({"t": "header", "header": h}),
        LogLine::Record(r) => json!({"t": "line", "seq": r.seq, "ts": r.ts.to_string(),
            "stream": match r.stream { LogStream::Stdout => "stdout", LogStream::Stderr => "stderr" },
            "text": mediatore_client::logs::escape_controls(&r.text)}),
        LogLine::Gap(g) => json!({"t": "gap", "stdout": g.lost_stdout, "stderr": g.lost_stderr}),
        LogLine::End(e) => json!({"t": "end", "reason": e.reason}),
    })
}

/// The demo's output for one agent: a few lines a second, as a workload would write them.
fn demo_output(name: String) -> impl futures::Stream<Item = Value> {
    let lines = [
        ("stdout", "resolving dependencies"),
        ("stdout", "fetching https://pypi.org/simple/requests/"),
        ("stdout", "collected 3 packages"),
        ("stderr", "warning: no cache directory, downloading again"),
        ("stdout", "running the task"),
        ("stdout", "reading the repository"),
        ("stdout", "calling the model (anthropic)"),
        ("stdout", "writing the summary"),
    ];
    futures::stream::iter(0..).then(move |i: usize| {
        let (stream, text) = lines[i % lines.len()];
        let line = json!({"t": "line", "seq": i, "ts": now(), "stream": stream,
                "text": if i == 0 { format!("{name}: starting") } else { text.to_owned() }});
        async move {
            crate::demo::pause(700).await;
            line
        }
    })
}

// ------------------------------------------------------------------------------ the demo

/// A small, steady pseudo-random sequence: the demo needs variety, not secrecy.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }
    #[allow(clippy::cast_possible_truncation)] // n is small
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn chance(&mut self, pct: u64) -> bool {
        self.next() % 100 < pct
    }
}

const NAMESPACES: [&str; 3] = ["team-a", "team-b", "research"];
const PEOPLE: [&str; 8] = [
    "ada", "grace", "alan", "edsger", "barbara", "ken", "frances", "donald",
];
const GATEWAYS: [&str; 3] = ["gateway-01", "gateway-02", "gateway-03"];
/// The audiences every demo policy grants and every demo agent names: (name, endpoint).
const DEMO_AUDIENCES: [(&str, &str); 2] = [
    ("anthropic", "api.anthropic.com:443"),
    ("github", "api.github.com:443"),
];
/// Hosts a demo workload reaches: (kind, authority, audience).
const HOSTS: [(&str, &str, &str); 6] = [
    ("tunnel", "pypi.org:443", ""),
    ("tunnel", "github.com:443", ""),
    ("tunnel", "registry.npmjs.org:443", ""),
    ("tunnel", "crates.io:443", ""),
    ("inject", "api.anthropic.com", "anthropic"),
    ("inject", "api.github.com", "github"),
];

/// One demo agent and where it is in its life.
struct Agent {
    ns: &'static str,
    name: String,
    who: &'static str,
    uid: String,
    claim_uid: String,
    created: String,
    /// Ticks lived, and the tick it exits at.
    age: u32,
    life: u32,
    /// 0 pending, 1 running, 2 exited, 3 refused.
    stage: u8,
    vm: String,
    gateway: usize,
    gaps: bool,
    /// Odd agents report egress on their status (ADR-0063), even ones through the log.
    on_status: bool,
    egress: Folded,
    exit_code: i64,
}

fn now() -> String {
    jiff::Timestamp::now().to_string()
}

/// The demo's pools: `pool-standard`, whose claimed members are the agents' VMs and which keeps
/// `warm` more booted and unclaimed; and a small `pool-gpu`, warm and idle.
fn demo_pools(fleet: &Fleet, claimed: usize, warm: usize, provisioning: usize) {
    for (name, claimed, warm, provisioning) in [
        ("pool-standard", claimed, warm, provisioning),
        ("pool-gpu", 0, 2, 0),
    ] {
        let obj = json!({"apiVersion": "banlieue.io/v1alpha1", "kind": "VirtualMachinePool",
            "metadata": {"name": name, "namespace": "banlieue-system", "uid": format!("7c00{}-0000-4000-8000-0000000000b0", &name[5..8])},
            "spec": {"classRef": {"name": if name == "pool-gpu" { "sandbox-gpu" } else { "sandbox-small" }},
                "imageRef": {"name": "mediatore-guest"}, "warm": warm},
            "status": {"replicas": claimed + warm + provisioning, "available": warm, "claimed": claimed, "provisioning": provisioning,
                "conditions": [{"type": "Warm", "status": if warm > 0 { "True" } else { "False" },
                    "message": format!("{warm}/{warm} warm member(s) available")}]}});
        fleet.put("pool", format!("pool/banlieue-system/{name}"), obj);
    }
    for i in 1..=2 {
        let name = format!("pool-gpu-w{i}");
        put_vm(fleet, warm_json(&name, "pool-gpu", true), true);
    }
}

/// A demo VM's EK hash: 64 hex characters from its name, as a TPM's would be from its key.
fn demo_ek(vm: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(64);
    for seed in 0u64..4 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ seed.wrapping_mul(0x9e37_79b9_7f4a_7c15);
        for b in vm.bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
        let _ = write!(out, "{h:016x}");
    }
    out
}

/// A UUID from an EK hash, for the demo's libvirt domain and SMBIOS (DMI) UUIDs, which match.
fn demo_uuid(ek: &str) -> String {
    format!(
        "{}-{}-4{}-8{}-{}",
        &ek[0..8],
        &ek[8..12],
        &ek[13..16],
        &ek[17..20],
        &ek[20..32]
    )
}

/// A demo VM with everything its status links it to: its EK hash (as Recess derives it), its
/// LibvirtMachine (the same domain UUID), and once its guest is ready, its SandboxNode.
fn put_vm(fleet: &Fleet, mut vm: Value, sandbox: bool) {
    let name = str_at(&vm, "/metadata/name").to_owned();
    let ek = demo_ek(&name);
    let uuid = demo_uuid(&ek);
    let ready = vm
        .pointer("/status/conditions")
        .and_then(Value::as_array)
        .is_some_and(|cs| {
            cs.iter()
                .any(|c| str_at(c, "/type") == "GuestReady" && str_at(c, "/status") == "True")
        });
    vm["status"]["infrastructureRef"] = json!({"apiGroup": "infrastructure.banlieue.io", "kind": "LibvirtMachine", "name": name, "namespace": "banlieue-system"});
    vm[DERIVED] = json!({"ekHash": ek});
    let mut machine = json!({"apiVersion": "infrastructure.banlieue.io/v1alpha1", "kind": "LibvirtMachine",
        "metadata": {"name": name, "namespace": "banlieue-system", "labels": vm["metadata"]["labels"].clone()},
        "status": {"domainUuid": uuid, "addressSource": "guestAgent", "addresses": vm["status"]["addresses"].clone()}});
    if machine["status"]["addresses"].is_null() {
        machine["status"]["addresses"] = json!([]);
    }
    fleet.put(
        "machine",
        format!("machine/banlieue-system/{name}"),
        machine,
    );
    if sandbox && ready {
        fleet.put("node", format!("node/banlieue-system/{ek}"), json!({"apiVersion": "mediatore.io/v1alpha1", "kind": "SandboxNode",
            "metadata": {"name": ek, "namespace": "banlieue-system", "labels": {"mediatore.io/dmi-uuid": uuid}},
            "spec": {"ekHash": ek, "dmiUuid": uuid, "hostname": format!("kairos-{}", &ek[..4]), "provider": "libvirt",
                "nodeId": format!("spiffe://sandbox.example/spire/agent/tpm/{ek}")}}));
    } else {
        fleet.del(&format!("node/banlieue-system/{ek}"));
    }
    fleet.put("vm", format!("vm/banlieue-system/{name}"), vm);
}

/// A demo VM gone, with its machine and node.
fn del_vm(fleet: &Fleet, name: &str) {
    fleet.del(&format!("vm/banlieue-system/{name}"));
    fleet.del(&format!("machine/banlieue-system/{name}"));
    fleet.del(&format!("node/banlieue-system/{}", demo_ek(name)));
}

/// A pool member with no claim: booted and waiting (`ready`), or still provisioning.
fn warm_json(name: &str, pool: &str, ready: bool) -> Value {
    json!({"apiVersion": "banlieue.io/v1alpha1", "kind": "VirtualMachine",
        "metadata": {"name": name, "namespace": "banlieue-system", "uid": format!("{name}-uid"), "creationTimestamp": now(),
            "labels": {"banlieue.io/pool": pool},
            "ownerReferences": [{"apiVersion": "banlieue.io/v1alpha1", "kind": "VirtualMachinePool", "name": pool, "uid": "pool"}]},
        "spec": {"classRef": {"name": "sandbox-small"}, "imageRef": {"name": "mediatore-guest"}},
        "status": {"observedPowerState": "PoweredOn",
            "conditions": [{"type": "Ready", "status": if ready { "True" } else { "False" }, "reason": if ready { "GuestReady" } else { "Booting" }},
                {"type": "GuestReady", "status": if ready { "True" } else { "False" }}],
            "scheduled": {"providerName": "host-2", "failureDomain": "fd-2"}}})
}

fn demo_static(fleet: &Fleet) {
    // Three hosts, each a banlieue Provider and the faubourg Host behind it.
    for h in ["host-1", "host-2", "host-3"] {
        fleet.put(
            "provider",
            format!("provider/banlieue-system/{h}"),
            json!({"apiVersion": "banlieue.io/v1alpha1", "kind": "Provider",
            "metadata": {"name": h, "namespace": "banlieue-system", "labels": {"host": h}},
            "spec": {"providerClass": "libvirt"},
            "status": {"conditions": [{"type": "Ready", "status": "True", "reason": "Connected"}],
                "failureDomains": [{"name": format!("fd-{}", &h[5..]), "labels": {"host": h}}]}}),
        );
        fleet.put("host", format!("host//{h}"), json!({"apiVersion": "faubourg.firestoned.io/v1alpha1", "kind": "Host",
            "metadata": {"name": h}, "spec": {"address": format!("198.51.100.{}", 200 + h[5..].parse::<u8>().unwrap_or(0)), "zoneRef": "home"},
            "status": {"providerRef": h}}));
    }
    for (i, g) in GATEWAYS.iter().enumerate() {
        let obj = json!({"apiVersion": "banlieue.io/v1alpha1", "kind": "VirtualMachine",
            "metadata": {"name": g, "namespace": "banlieue-system", "uid": format!("9a7e0000-0000-4000-8000-00000000a00{i}"),
                "creationTimestamp": now(), "labels": {"mediatore.io/role": "gateway"}},
            "spec": {"classRef": {"name": "gateway-small"}, "imageRef": {"name": "mediatore-gateway"}},
            "status": {"observedPowerState": "PoweredOn", "addresses": [{"type": "InternalIP", "address": format!("198.51.100.{}", 10 + i)}],
                "conditions": [{"type": "Ready", "status": "True", "reason": "GuestReady"}],
                "scheduled": {"providerName": format!("host-{}", i + 1), "failureDomain": format!("fd-{}", i + 1)}}});
        put_vm(fleet, obj, false);
    }
    for (i, (ns, name, profile)) in [
        ("team-a", "default", "Standard"),
        ("team-b", "default", "Hardened"),
        ("research", "lab", "Lab"),
    ]
    .into_iter()
    .enumerate()
    {
        let obj = json!({"apiVersion": "sandbox.firestoned.io/v1alpha2", "kind": "SandboxPolicy",
        "metadata": {"name": name, "namespace": ns, "uid": format!("5d0c1b2a-0000-4000-8000-00000000b00{i}"), "creationTimestamp": now()},
        "spec": {"profileRef": profile, "audiences": DEMO_AUDIENCES.iter()
            .map(|(name, endpoint)| json!({"name": name, "endpoints": [endpoint]})).collect::<Vec<_>>()},
        "status": {"bundleVersion": 7 + i, "conditions": [if ns == "research" {
            json!({"type": "Ready", "status": "False", "reason": "NoApprovedCeiling", "message": "no ExposureCeiling research/lab"})
        } else {
            json!({"type": "Ready", "status": "True", "reason": "Published"})
        }]}});
        fleet.put("policy", format!("policy/{ns}/{name}"), obj);
        // research/lab has no ceiling: notaio does not publish it (Ready=False, NoApprovedCeiling).
        if ns != "research" {
            fleet.put("ceiling", format!("ceiling/{ns}/{name}"), json!({"apiVersion": "sandbox.firestoned.io/v1alpha2", "kind": "ExposureCeiling",
                "metadata": {"name": name, "namespace": ns, "creationTimestamp": now()},
                "spec": {"audiences": DEMO_AUDIENCES.iter()
                    .map(|(name, endpoint)| json!({"name": name, "access": "Read", "maxTtlSeconds": 3600, "endpoints": [endpoint], "dataScope": "Internal"})).collect::<Vec<_>>(),
                    "egressHosts": [], "tools": [], "maxLeaseSeconds": 28800,
                    "approvals": [{"role": "Security", "reference": "https://example.com/approvals/1"}]}}));
        }
        fleet.put("floor", format!("floor/banlieue-system/{ns}.{name}"), json!({"apiVersion": "mediatore.io/v1alpha1", "kind": "PolicyFloor",
            "metadata": {"name": format!("{ns}.{name}"), "namespace": "banlieue-system"},
            "spec": {"policyName": name, "policyNamespace": ns, "uid": format!("5d0c1b2a-0000-4000-8000-00000000b00{i}"), "version": 7 + i}}));
    }
}

/// The demo policy's index (and so its uid and bundle) for a namespace.
fn ns_index(ns: &str) -> usize {
    NAMESPACES.iter().position(|n| *n == ns).unwrap_or(0)
}

fn policy_of(ns: &str) -> &'static str {
    if ns == "research" { "lab" } else { "default" }
}

fn sandbox_json(a: &Agent) -> Value {
    let policy = policy_of(a.ns);
    let mut obj = json!({"apiVersion": "mediatore.io/v1beta1", "kind": "AgentSandbox",
        "metadata": {"name": a.name, "namespace": a.ns, "uid": a.uid, "creationTimestamp": a.created,
            "labels": {"mediatore.io/claim-uid": a.claim_uid}},
        "spec": {"subject": {"issuer": "https://dex.example.com", "id": format!("Cg{}", a.who), "display": a.who},
            "ttlSeconds": 3600, "policyRef": {"name": policy},
            "audiences": DEMO_AUDIENCES.iter().map(|(name, _)| *name).collect::<Vec<_>>(),
            "workload": {"image": "ghcr.io/example/agent:1.4", "args": ["--task", "triage"], "restart": "Never", "logs": true}},
        "status": {"phase": "Pending"}});
    let s = &mut obj["status"];
    if a.stage == 3 {
        s["phase"] = json!("Failed");
        s["reason"] = json!(format!(
            "policy_not_resolved: no SandboxPolicy named {policy} in {}",
            a.ns
        ));
        return obj;
    }
    s["claimUid"] = json!(a.claim_uid);
    s["record"] = json!({"claimUid": a.claim_uid, "sandboxUid": a.uid, "createdAt": a.created,
        "policyUid": format!("5d0c1b2a-0000-4000-8000-00000000b00{}", ns_index(a.ns)), "bundleVersion": 7 + ns_index(a.ns)});
    s["conditions"] = if a.gaps {
        json!([{"type": "PolicyConformant", "status": "False", "reason": "Gaps",
            "message": "shadow: the sandbox's egress is wider than the bundle allows", "lastTransitionTime": a.created}])
    } else {
        json!([{"type": "PolicyConformant", "status": "True", "reason": "Conformant",
            "message": format!("the sandbox is within policy {policy}, bundle {}", 7 + ns_index(a.ns)), "lastTransitionTime": a.created}])
    };
    if a.stage >= 1 {
        s["phase"] = json!("Bound");
        s["ready"] = json!(true);
        s["virtualMachineRef"] = json!({"name": a.vm});
        s["record"]["nodeId"] = json!(format!(
            "spiffe://sandbox.example/spire/agent/tpm/{}",
            demo_ek(&a.vm)
        ));
        s["record"]["entryId"] = json!(format!("mediatore-claim-{}", a.claim_uid));
        s["poolRef"] = json!({"name": "pool-standard"});
        if a.on_status && !a.egress.routes.is_empty() {
            s["egress"] = a.egress.to_json();
        }
    }
    if a.stage == 2 {
        s["phase"] = json!("Released");
        s["ready"] = json!(false);
        s["record"]["exit"] = json!({"exited_at": now(), "code": a.exit_code, "restarts": 0});
    }
    obj
}

/// The agent's two SPIRE entries (ADR-0006): its claim's, and its node's, under one agent.
fn entries_json(a: &Agent) -> [(String, Value); 2] {
    let ek = demo_ek(&a.vm);
    let agent = format!("spiffe://sandbox.example/spire/agent/tpm/{ek}");
    let entry = |name: String, id: String, selectors: Value, ttl: &str| {
        let mut spec = json!({"spiffeID": id, "parentID": agent, "selectors": selectors, "className": "mediatore"});
        if !ttl.is_empty() {
            spec["x509SVIDTTL"] = json!(ttl);
        }
        (
            format!("entry//{name}"),
            json!({"apiVersion": "spire.spiffe.io/v1alpha1", "kind": "ClusterStaticEntry",
                "metadata": {"name": name, "creationTimestamp": now()},
                "spec": spec, "status": {"rendered": true, "masked": false, "set": true}}),
        )
    };
    [
        entry(
            format!("mediatore-claim-{}", a.claim_uid),
            format!("spiffe://sandbox.example/banlieue/claim/{}", a.claim_uid),
            json!(["unix:user:sandbox"]),
            "1h0m0s",
        ),
        entry(
            format!("mediatore-node-{ek}"),
            format!("spiffe://sandbox.example/banlieue/node/{}", &ek[..12]),
            json!(["unix:uid:0", "unix:path:/usr/bin/mediatore"]),
            "",
        ),
    ]
}

/// The Secret keys an agent's envelopes can have, by kind.
fn envelope_keys(a: &Agent) -> [(&'static str, String); 3] {
    [
        (
            "envelope",
            format!("envelope/banlieue-system/mediatore-session-{}", a.uid),
        ),
        (
            "envelope",
            format!(
                "envelope/banlieue-system/mediatore-delegation-{}-anthropic",
                a.uid
            ),
        ),
        (
            "segment",
            format!(
                "segment/banlieue-system/mediatore-logs-{}-000001",
                a.claim_uid
            ),
        ),
    ]
}

/// The agent's sealed Secrets now: its issuer session and, in team-a, a delegated credential
/// while it runs; its output segment once it has run a while, kept after the release.
fn envelopes_json(a: &Agent) -> Vec<(&'static str, String, Value)> {
    let [session, delegation, segment] = envelope_keys(a);
    let mut out = Vec::new();
    let item = |key: &str, labels: Value, sealed: bool| {
        let name = key.rsplit('/').next().unwrap_or_default().to_owned();
        let seal = if sealed {
            json!({"mediatore.io/seal": "v1"})
        } else {
            json!({})
        };
        json!({"name": name, "namespace": "banlieue-system", "labels": labels, "annotations": seal, "created": a.created})
    };
    if a.stage == 1 {
        out.push((
            session.0,
            session.1.clone(),
            item(
                &session.1,
                json!({"mediatore.io/session": "claimed", "mediatore.io/sandbox-uid": a.uid}),
                false,
            ),
        ));
        if a.ns == "team-a" {
            out.push((delegation.0, delegation.1.clone(), item(&delegation.1, json!({"mediatore.io/audience": "anthropic", "mediatore.io/sandbox-uid": a.uid}), false)));
        }
    }
    if (a.stage == 1 && a.age >= 6) || a.stage == 2 {
        out.push((
            segment.0,
            segment.1.clone(),
            item(
                &segment.1,
                json!({"mediatore.io/logs": "segment", "mediatore.io/claim-uid": a.claim_uid}),
                true,
            ),
        ));
    }
    out
}

fn member_json(a: &Agent) -> Value {
    json!({"apiVersion": "banlieue.io/v1alpha1", "kind": "VirtualMachine",
        "metadata": {"name": a.vm, "namespace": "banlieue-system", "uid": format!("{}-vm", a.uid), "creationTimestamp": a.created,
            "labels": {"banlieue.io/pool": "pool-standard"},
            "ownerReferences": [{"apiVersion": "banlieue.io/v1alpha1", "kind": "VirtualMachinePool", "name": "pool-standard", "uid": "pool"}]},
        "spec": {"classRef": {"name": "sandbox-small"}, "imageRef": {"name": "mediatore-guest"}},
        "status": {"observedPowerState": "PoweredOn", "conditions": [{"type": "Ready", "status": "True", "reason": "GuestReady"},
            {"type": "GuestReady", "status": "True"}], "scheduled": {"providerName": "host-1", "failureDomain": "fd-1"}}})
}

/// The demo's fleet: agents arriving in three namespaces, running, reaching hosts through the
/// gateways, exiting and going; now and then one refused, one with gaps. Placeholder names only.
pub async fn demo(fleet: Arc<Fleet>) {
    let mut rng = Lcg(0x5eed_1e55);
    demo_static(&fleet);
    let mut agents: Vec<Agent> = Vec::new();
    let mut serial = 0u32;
    let mut spawn = |rng: &mut Lcg, agents: &mut Vec<Agent>| {
        serial += 1;
        let ns = NAMESPACES[rng.below(NAMESPACES.len())];
        let who = PEOPLE[rng.below(PEOPLE.len())];
        let refused = rng.chance(6);
        agents.push(Agent {
            ns,
            name: format!("{who}-{:05x}", rng.next() & 0xf_ffff),
            who,
            uid: format!("0b9a{serial:04x}-0000-4000-8000-0000000000aa"),
            claim_uid: format!("6f1e{serial:04x}-0000-4000-8000-0000000000c1"),
            created: now(),
            age: 0,
            life: 18 + u32::try_from(rng.below(40)).unwrap_or(0),
            stage: if refused { 3 } else { 0 },
            vm: format!("pool-standard-{serial}"),
            gateway: rng.below(GATEWAYS.len()),
            gaps: rng.chance(10),
            on_status: serial % 2 == 1,
            egress: Folded::default(),
            exit_code: i64::from(rng.chance(15)),
        });
    };
    for _ in 0..11 {
        spawn(&mut rng, &mut agents);
    }
    // The first ones are already well into their lives.
    for (i, a) in agents.iter_mut().enumerate() {
        if a.stage == 0 {
            a.age = u32::try_from(i).unwrap_or(0) * 2;
        }
    }
    loop {
        if agents.len() < 16 && rng.chance(35) {
            spawn(&mut rng, &mut agents);
        }
        let mut gone = Vec::new();
        for (i, a) in agents.iter_mut().enumerate() {
            a.age += 1;
            match a.stage {
                0 if a.age >= 3 => {
                    a.stage = 1;
                    put_vm(&fleet, member_json(a), true);
                }
                1 => {
                    for _ in 0..rng.below(3) {
                        let (kind, authority, audience) = HOSTS[rng.below(HOSTS.len())];
                        let deny = rng.chance(if a.gaps { 30 } else { 6 });
                        // Mostly one gateway; now and then another, as a new tunnel lands elsewhere.
                        let gw = if rng.chance(85) {
                            a.gateway
                        } else {
                            rng.below(GATEWAYS.len())
                        };
                        let d = Decision {
                            at: now(),
                            claim_uid: a.claim_uid.clone(),
                            gateway: GATEWAYS[gw].into(),
                            kind: kind.into(),
                            authority: if deny && kind == "tunnel" {
                                "example.net:443".into()
                            } else {
                                authority.into()
                            },
                            audience: audience.into(),
                            verdict: if deny { "deny" } else { "allow" }.into(),
                            reason: if deny { "not_allowed" } else { "" }.into(),
                        };
                        a.egress.add(&d);
                    }
                    if !a.on_status && !a.egress.routes.is_empty() {
                        fleet.put(
                            "egress",
                            format!("egress/{}", a.claim_uid),
                            from_log(&a.claim_uid, &a.egress),
                        );
                    }
                    if a.age >= a.life {
                        a.stage = 2;
                        del_vm(&fleet, &a.vm);
                    }
                }
                2 | 3 if a.age >= a.life + 5 || (a.stage == 3 && a.age >= 8) => gone.push(i),
                _ => {}
            }
            fleet.put(
                "sandbox",
                format!("sandbox/{}/{}", a.ns, a.name),
                sandbox_json(a),
            );
            // SPIRE entries while it runs; its envelopes as it has them.
            for (key, obj) in entries_json(a) {
                if a.stage == 1 {
                    fleet.put("entry", key, obj);
                } else {
                    fleet.del(&key);
                }
            }
            let have = envelopes_json(a);
            for (_, key) in envelope_keys(a) {
                if !have.iter().any(|(_, k, _)| *k == key) {
                    fleet.del(&key);
                }
            }
            for (kind, key, obj) in have {
                fleet.put(kind, key, obj);
            }
        }
        for i in gone.into_iter().rev() {
            let a = agents.remove(i);
            fleet.del(&format!("sandbox/{}/{}", a.ns, a.name));
            fleet.del(&format!("egress/{}", a.claim_uid));
            for (_, key) in envelope_keys(&a) {
                fleet.del(&key);
            }
        }
        // The pools: two warm members always, one booting while an agent waits for its VM.
        let claimed = agents.iter().filter(|a| a.stage == 1).count();
        let waiting = agents.iter().any(|a| a.stage == 0);
        for i in 1..=2 {
            let name = format!("pool-standard-w{i}");
            put_vm(&fleet, warm_json(&name, "pool-standard", true), true);
        }
        if waiting {
            put_vm(
                &fleet,
                warm_json("pool-standard-p1", "pool-standard", false),
                true,
            );
        } else {
            del_vm(&fleet, "pool-standard-p1");
        }
        demo_pools(&fleet, claimed, 2, usize::from(waiting));
        crate::demo::pause(1300).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_vm_without_endorsement_certificates_has_no_ek_hash() {
        assert_eq!(ek_hash_of(&json!({"status": {}})), None);
        assert_eq!(
            ek_hash_of(&json!({"status": {"tpmEndorsementCertificates": []}})),
            None
        );
        assert_eq!(
            ek_hash_of(&json!({"status": {"tpmEndorsementCertificates": ["not a certificate"]}})),
            None
        );
    }

    #[test]
    fn the_demo_links_a_vm_its_machine_and_its_node_by_one_ek_hash() {
        let ek = demo_ek("pool-standard-1");
        assert_eq!(ek.len(), 64);
        assert!(ek.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(demo_ek("pool-standard-1"), ek, "stable");
        assert_ne!(demo_ek("pool-standard-2"), ek);
        let fleet = Fleet::new();
        put_vm(
            &fleet,
            warm_json("pool-standard-1", "pool-standard", true),
            true,
        );
        let (snap, _) = fleet.subscribe();
        let snap: Value = serde_json::from_str(&snap).unwrap();
        let items = snap["items"].as_array().unwrap();
        let get = |k: &str| {
            items
                .iter()
                .find(|i| i["key"] == k)
                .map(|i| i["obj"].clone())
        };
        let vm = get("vm/banlieue-system/pool-standard-1").unwrap();
        let machine = get("machine/banlieue-system/pool-standard-1").unwrap();
        let node = get(&format!("node/banlieue-system/{ek}")).unwrap();
        assert_eq!(vm[DERIVED]["ekHash"], json!(ek));
        assert_eq!(node["spec"]["dmiUuid"], machine["status"]["domainUuid"]);
        assert_eq!(vm["status"]["infrastructureRef"]["name"], "pool-standard-1");
    }

    fn d(gw: &str, host: &str, verdict: &str, at: &str) -> Decision {
        Decision {
            at: at.into(),
            claim_uid: "c".into(),
            gateway: gw.into(),
            kind: "tunnel".into(),
            authority: host.into(),
            audience: String::new(),
            verdict: verdict.into(),
            reason: if verdict == "deny" {
                "not_allowed".into()
            } else {
                String::new()
            },
        }
    }

    #[test]
    fn decisions_fold_into_one_route_per_gateway_host_and_verdict() {
        let mut f = Folded::default();
        f.add(&d(
            "gateway-02",
            "pypi.org:443",
            "allow",
            "2026-11-22T10:00:00Z",
        ));
        f.add(&d(
            "gateway-02",
            "pypi.org:443",
            "allow",
            "2026-11-22T10:00:05Z",
        ));
        f.add(&d(
            "gateway-01",
            "pypi.org:443",
            "allow",
            "2026-11-22T10:00:03Z",
        ));
        f.add(&d(
            "gateway-02",
            "example.net:443",
            "deny",
            "2026-11-22T10:00:04Z",
        ));
        let j = f.to_json();
        let routes = j["routes"].as_array().unwrap();
        assert_eq!(routes.len(), 3);
        assert_eq!(routes[0]["lastAt"], "2026-11-22T10:00:05Z", "newest first");
        assert_eq!(routes[1]["reason"], "not_allowed");
        assert!(routes[0].get("reason").is_none() && routes[0].get("audience").is_none());
        let pypi = routes
            .iter()
            .find(|r| r["gateway"] == "gateway-02" && r["authority"] == "pypi.org:443")
            .unwrap();
        assert_eq!(pypi["count"], 2);
        assert_eq!(pypi["firstAt"], "2026-11-22T10:00:00Z");
        assert_eq!(pypi["lastAt"], "2026-11-22T10:00:05Z");
        assert_eq!(j["updatedAt"], "2026-11-22T10:00:05Z");
        assert!(j.get("overflow").is_none(), "absent while 0");
    }

    #[test]
    fn a_workload_spraying_hosts_churns_its_refusals_and_keeps_its_allows() {
        let mut f = Folded::default();
        f.add(&d(
            "gateway-01",
            "pypi.org:443",
            "allow",
            "2026-11-22T10:00:00Z",
        ));
        for i in 0..(MAX_ROUTES + 10) {
            f.add(&d(
                "gateway-01",
                &format!("h{i}.example:443"),
                "deny",
                &format!("2026-11-22T10:01:{i:02}Z"),
            ));
        }
        let j = f.to_json();
        let routes = j["routes"].as_array().unwrap();
        assert_eq!(routes.len(), MAX_ROUTES);
        assert!(
            routes.iter().any(|r| r["authority"] == "pypi.org:443"),
            "the allow stays"
        );
        assert!(
            !routes.iter().any(|r| r["authority"] == "h0.example:443"),
            "the oldest deny went"
        );
        let counted: u64 = routes.iter().map(|r| r["count"].as_u64().unwrap()).sum();
        assert_eq!(
            counted + j["overflow"].as_u64().unwrap(),
            1 + MAX_ROUTES as u64 + 10
        );
    }

    #[test]
    fn with_only_allows_kept_a_new_host_is_overflow() {
        let mut f = Folded::default();
        for i in 0..=MAX_ROUTES {
            f.add(&d(
                "gateway-01",
                &format!("h{i}.example:443"),
                "allow",
                "2026-11-22T10:00:00Z",
            ));
        }
        let j = f.to_json();
        assert_eq!(j["routes"].as_array().unwrap().len(), MAX_ROUTES);
        assert_eq!(j["overflow"], 1);
    }

    #[test]
    fn a_viewer_gets_the_picture_then_only_what_changed() {
        let fleet = Fleet::new();
        fleet.put("sandbox", "sandbox/a/x".into(), json!({"n": 1}));
        let (snap, mut rx) = fleet.subscribe();
        let snap: Value = serde_json::from_str(&snap).unwrap();
        assert_eq!(snap["items"].as_array().unwrap().len(), 1);
        fleet.put("sandbox", "sandbox/a/x".into(), json!({"n": 1}));
        fleet.put("sandbox", "sandbox/a/x".into(), json!({"n": 2}));
        fleet.del("sandbox/a/x");
        fleet.del("sandbox/a/x");
        let a: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        let b: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(
            (a["op"].as_str(), a["obj"]["n"].as_i64()),
            (Some("put"), Some(2))
        );
        assert_eq!(b["op"], "del");
        assert!(
            rx.try_recv().is_err(),
            "an unchanged put and a second delete send nothing"
        );
    }

    #[test]
    fn a_relist_drops_what_is_gone_and_keeps_other_kinds() {
        let fleet = Fleet::new();
        fleet.put("sandbox", "sandbox/a/x".into(), json!(1));
        fleet.put("sandbox", "sandbox/a/y".into(), json!(1));
        fleet.put("vm", "vm/b/g".into(), json!(1));
        fleet.reset(
            "sandbox",
            BTreeMap::from([("sandbox/a/y".to_owned(), json!(1))]),
        );
        let (snap, _) = fleet.subscribe();
        let snap: Value = serde_json::from_str(&snap).unwrap();
        let keys: Vec<&str> = snap["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["key"].as_str().unwrap())
            .collect();
        assert_eq!(keys, ["sandbox/a/y", "vm/b/g"]);
    }
}
