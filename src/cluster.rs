// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

//! The Kubernetes view's data (`/kubernetes`): the cluster as the viewer's own credentials may
//! list it. Every namespace, every pod (its containers are in its spec and status), and every
//! namespaced custom resource, found by API discovery: the groups the API server serves, less
//! Kubernetes' own. Discovery runs again every few minutes, so a CRD installed later appears.
//!
//! Each kind is listed and watched across all namespaces, as the person: a kind their RBAC does
//! not let them list cluster-wide is named on the page (and tried again at the next discovery),
//! never read with anyone else's access. Read-only throughout.
//!
//! Secrets are watched as metadata only (the metadata API returns no data), the safety deposit
//! boxes of each namespace's vault. A drawer is opened only when the person asks, one Secret at
//! a time ([`open_secret`]): its keys and sizes, then a value only when one is asked for, each a
//! read made with their own credentials, so their RBAC decides; nothing of it is kept here.
//!
//! The picture is kept in an [`admin::Fleet`](crate::admin::Fleet), the store the Admin view
//! uses: the whole of it, then each change, over one server-sent event stream.

use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use futures::{StreamExt as _, TryStreamExt as _};
use kube::api::{ApiResource, DynamicObject, GroupVersionKind};
use kube::discovery::{Discovery, Scope, verbs};
use kube::runtime::{WatchStreamExt as _, watcher};
use serde_json::{Value, json};
use tokio::task::{AbortHandle, JoinSet};

use k8s_openapi::api::core::v1::Secret;
use kube::core::PartialObjectMeta;

use crate::admin::Fleet;
use crate::util::str_at;

/// Kubernetes' own API groups: what discovery finds there is not a custom resource. The Gateway
/// API (`gateway.networking.k8s.io`) and the snapshot CRDs (`snapshot.storage.k8s.io`) are CRDs
/// in `.k8s.io` groups, so the list is exact rather than a suffix match.
const BUILTIN: &[&str] = &[
    "",
    "apps",
    "batch",
    "autoscaling",
    "policy",
    "admissionregistration.k8s.io",
    "apiextensions.k8s.io",
    "apiregistration.k8s.io",
    "authentication.k8s.io",
    "authorization.k8s.io",
    "certificates.k8s.io",
    "coordination.k8s.io",
    "discovery.k8s.io",
    "events.k8s.io",
    "flowcontrol.apiserver.k8s.io",
    "internal.apiserver.k8s.io",
    "networking.k8s.io",
    "node.k8s.io",
    "rbac.authorization.k8s.io",
    "resource.k8s.io",
    "scheduling.k8s.io",
    "storage.k8s.io",
    "storagemigration.k8s.io",
    "metrics.k8s.io",
];

/// How often discovery runs again: new CRDs appear, removed ones go, refused ones are retried.
const REDISCOVER: Duration = Duration::from_mins(3);

/// The page's name for a custom resource kind: `cr:<group>/<plural>`.
fn cr_kind(ar: &ApiResource) -> String {
    format!("cr:{}/{}", ar.group, ar.plural)
}

/// Start the watches for one viewer (or every viewer, on your machine). The handle stops
/// discovery and every watch it started.
pub fn spawn(fleet: &Arc<Fleet>, client: &kube::Client) -> Vec<AbortHandle> {
    vec![tokio::spawn(run(fleet.clone(), client.clone())).abort_handle()]
}

/// Namespaces and pods, then the custom resources discovery finds, kept in step with it. The
/// watches live in a `JoinSet` owned here: when this task is aborted, they all are.
async fn run(fleet: Arc<Fleet>, client: kube::Client) {
    let mut tasks = JoinSet::new();
    for (kind, gvk, plural) in [
        (
            "namespace",
            GroupVersionKind::gvk("", "v1", "Namespace"),
            "namespaces",
        ),
        ("pod", GroupVersionKind::gvk("", "v1", "Pod"), "pods"),
    ] {
        let ar = ApiResource::from_gvk_with_plural(&gvk, plural);
        let api = kube::Api::all_with(client.clone(), &ar);
        tasks.spawn(watch(fleet.clone(), api, ar, kind.to_owned()));
    }
    tasks.spawn(watch_secrets(fleet.clone(), kube::Api::all(client.clone())));
    let mut running: HashMap<String, AbortHandle> = HashMap::new();
    loop {
        // Watches that ended (refused, or their kind gone) leave the map, so the next round
        // tries them again.
        while tasks.try_join_next().is_some() {}
        running.retain(|_, h| !h.is_finished());
        match discover(&client).await {
            Ok(found) => {
                fleet.note("cluster", "");
                let mut kinds = BTreeMap::new();
                for ar in &found {
                    let kind = cr_kind(ar);
                    kinds.insert(
                        format!("crd/{}/{}", ar.group, ar.plural),
                        json!({"group": ar.group, "version": ar.version, "kind": ar.kind,
                               "plural": ar.plural, "watch": kind}),
                    );
                    if let Entry::Vacant(slot) = running.entry(kind.clone()) {
                        let api = kube::Api::all_with(client.clone(), ar);
                        slot.insert(tasks.spawn(watch(fleet.clone(), api, ar.clone(), kind)));
                    }
                }
                fleet.reset("crd", kinds);
                // A CRD that is gone: its watch stops, its objects and its note with it.
                let gone: Vec<String> = running
                    .keys()
                    .filter(|k| !found.iter().any(|ar| cr_kind(ar) == **k))
                    .cloned()
                    .collect();
                for k in gone {
                    if let Some(h) = running.remove(&k) {
                        h.abort();
                    }
                    fleet.reset(&k, BTreeMap::new());
                    fleet.note(&k, "");
                }
            }
            Err(e) => fleet.note("cluster", &format!("discovery: {e}")),
        }
        tokio::time::sleep(REDISCOVER).await;
    }
}

/// The namespaced custom resources the API server serves that can be listed and watched, at
/// each group's preferred version. Aggregated discovery first (two requests); the per-group
/// walk where the server has none.
async fn discover(client: &kube::Client) -> Result<Vec<ApiResource>, kube::Error> {
    let d = match Discovery::new(client.clone())
        .exclude(BUILTIN)
        .run_aggregated()
        .await
    {
        Ok(d) => d,
        Err(_) => {
            Discovery::new(client.clone())
                .exclude(BUILTIN)
                .run()
                .await?
        }
    };
    let mut out = Vec::new();
    for g in d.groups() {
        if BUILTIN.contains(&g.name()) {
            continue;
        }
        for (ar, caps) in g.recommended_resources() {
            if caps.scope == Scope::Namespaced
                && caps.supports_operation(verbs::LIST)
                && caps.supports_operation(verbs::WATCH)
            {
                out.push(ar);
            }
        }
    }
    out.sort_by(|a, b| (&a.group, &a.plural).cmp(&(&b.group, &b.plural)));
    Ok(out)
}

/// An object as the page gets it: its kind named (a listed item may carry none), without its
/// managed fields and last-applied copy.
fn keyed(kind: &str, ar: &ApiResource, obj: &DynamicObject) -> (String, Value) {
    let mut v = serde_json::to_value(obj).unwrap_or_default();
    v["apiVersion"] = json!(ar.api_version);
    v["kind"] = json!(ar.kind);
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
    (key, v)
}

/// Whether the API server refused the person (401 or 403): no retry until the next discovery.
fn refused(e: &watcher::Error) -> bool {
    let code = match e {
        watcher::Error::InitialListFailed(kube::Error::Api(s))
        | watcher::Error::WatchStartFailed(kube::Error::Api(s))
        | watcher::Error::WatchFailed(kube::Error::Api(s))
        | watcher::Error::WatchError(s) => s.code,
        _ => 0,
    };
    code == 401 || code == 403
}

async fn watch(fleet: Arc<Fleet>, api: kube::Api<DynamicObject>, ar: ApiResource, kind: String) {
    let mut stream = watcher(api, watcher::Config::default())
        .default_backoff()
        .boxed();
    let mut fresh: Option<BTreeMap<String, Value>> = None;
    loop {
        match stream.try_next().await {
            Ok(Some(ev)) => {
                fleet.note(&kind, "");
                match ev {
                    watcher::Event::Init => fresh = Some(BTreeMap::new()),
                    watcher::Event::InitApply(o) => {
                        if let Some(f) = fresh.as_mut() {
                            let (k, v) = keyed(&kind, &ar, &o);
                            f.insert(k, v);
                        }
                    }
                    watcher::Event::InitDone => {
                        if let Some(f) = fresh.take() {
                            fleet.reset(&kind, f);
                        }
                    }
                    watcher::Event::Apply(o) => {
                        let (k, v) = keyed(&kind, &ar, &o);
                        fleet.put(&kind, k, v);
                    }
                    watcher::Event::Delete(o) => fleet.del(&keyed(&kind, &ar, &o).0),
                }
            }
            Ok(None) => {
                fleet.note(&kind, "the watch ended");
                return;
            }
            Err(e) if refused(&e) => {
                fleet.note(
                    &kind,
                    &format!("not allowed to list {} in all namespaces", ar.plural),
                );
                return;
            }
            // The backoff retries; the page says why until it works.
            Err(e) => fleet.note(&kind, &e.to_string()),
        }
    }
}

// ------------------------------------------------------------------------------ the vaults

type SecretMeta = PartialObjectMeta<Secret>;

/// A Secret as the page gets it: its metadata, without its managed fields and last-applied copy
/// (which, for a Secret applied with kubectl, holds its data).
fn secret_keyed(m: &SecretMeta) -> (String, Value) {
    let mut v = json!({"metadata": serde_json::to_value(&m.metadata).unwrap_or_default()});
    if let Some(md) = v.pointer_mut("/metadata").and_then(Value::as_object_mut) {
        md.remove("managedFields");
    }
    if let Some(a) = v
        .pointer_mut("/metadata/annotations")
        .and_then(Value::as_object_mut)
    {
        a.remove("kubectl.kubernetes.io/last-applied-configuration");
    }
    v["kind"] = json!("Secret");
    v["apiVersion"] = json!("v1");
    let key = format!(
        "secret/{}/{}",
        str_at(&v, "/metadata/namespace"),
        str_at(&v, "/metadata/name")
    );
    (key, v)
}

/// Every Secret's metadata, across all namespaces. An Api of metadata asks for metadata only:
/// no Secret's data crosses the wire here.
async fn watch_secrets(fleet: Arc<Fleet>, api: kube::Api<SecretMeta>) {
    const KIND: &str = "secret";
    let mut stream = watcher(api, watcher::Config::default())
        .default_backoff()
        .boxed();
    let mut fresh: Option<BTreeMap<String, Value>> = None;
    loop {
        match stream.try_next().await {
            Ok(Some(ev)) => {
                fleet.note(KIND, "");
                match ev {
                    watcher::Event::Init => fresh = Some(BTreeMap::new()),
                    watcher::Event::InitApply(m) => {
                        if let Some(f) = fresh.as_mut() {
                            let (k, v) = secret_keyed(&m);
                            f.insert(k, v);
                        }
                    }
                    watcher::Event::InitDone => {
                        if let Some(f) = fresh.take() {
                            fleet.reset(KIND, f);
                        }
                    }
                    watcher::Event::Apply(m) => {
                        let (k, v) = secret_keyed(&m);
                        fleet.put(KIND, k, v);
                    }
                    watcher::Event::Delete(m) => fleet.del(&secret_keyed(&m).0),
                }
            }
            Ok(None) => {
                fleet.note(KIND, "the watch ended");
                return;
            }
            Err(e) if refused(&e) => {
                fleet.note(KIND, "not allowed to list secrets in all namespaces");
                return;
            }
            Err(e) => fleet.note(KIND, &e.to_string()),
        }
    }
}

/// Whether this client may read (get) Secrets in `ns`: the API server's own answer, a
/// SelfSubjectAccessReview, so the page can show a drawer locked before anyone pulls it.
///
/// # Errors
/// The review could not be made.
pub async fn can_read_secrets(client: &kube::Client, ns: &str) -> Result<bool, kube::Error> {
    use k8s_openapi::api::authorization::v1::{
        ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec,
    };
    let review = SelfSubjectAccessReview {
        spec: SelfSubjectAccessReviewSpec {
            resource_attributes: Some(ResourceAttributes {
                namespace: Some(ns.to_owned()),
                verb: Some("get".to_owned()),
                resource: Some("secrets".to_owned()),
                ..Default::default()
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    let api: kube::Api<SelfSubjectAccessReview> = kube::Api::all(client.clone());
    let r = api
        .create(&kube::api::PostParams::default(), &review)
        .await?;
    Ok(r.status.is_some_and(|s| s.allowed))
}

/// Why a drawer stays shut: the API server's code (403, 404) and what it said.
pub struct Refusal {
    pub code: u16,
    pub message: String,
}

/// One value as the page shows it: text when it is UTF-8, else base64, and its size.
fn shown(bytes: &[u8]) -> Value {
    use base64::Engine as _;
    match std::str::from_utf8(bytes) {
        Ok(t) => json!({"bytes": bytes.len(), "text": true, "value": t}),
        Err(_) => json!({"bytes": bytes.len(), "text": false,
                         "value": base64::engine::general_purpose::STANDARD.encode(bytes)}),
    }
}

/// What a drawer holds: without `key`, the Secret's type and each key with its size (no
/// value); with `key`, that one value.
fn drawer(sec: &Secret, key: Option<&str>) -> Result<Value, Refusal> {
    let data = sec.data.clone().unwrap_or_default();
    match key {
        None => Ok(json!({
            "type": sec.type_.clone().unwrap_or_else(|| "Opaque".to_owned()),
            "immutable": sec.immutable.unwrap_or(false),
            "keys": data.iter().map(|(k, v)| json!({"name": k, "bytes": v.0.len(),
                                                     "text": std::str::from_utf8(&v.0).is_ok()}))
                        .collect::<Vec<_>>(),
        })),
        Some(k) => data
            .get(k)
            .map(|v| {
                let mut out = shown(&v.0);
                out["key"] = json!(k);
                out
            })
            .ok_or_else(|| Refusal {
                code: 404,
                message: format!("no key {k:?} in this Secret"),
            }),
    }
}

/// Pull a drawer open: read one Secret with this client (the person's own credentials) and
/// return what [`drawer`] shows of it. Nothing is kept.
///
/// # Errors
/// The API server refused or could not find it, or could not be reached.
pub async fn open_secret(
    client: &kube::Client,
    ns: &str,
    name: &str,
    key: Option<&str>,
) -> Result<Value, Refusal> {
    let api: kube::Api<Secret> = kube::Api::namespaced(client.clone(), ns);
    match api.get(name).await {
        Ok(sec) => drawer(&sec, key),
        Err(kube::Error::Api(s)) => Err(Refusal {
            code: s.code,
            message: s.message,
        }),
        Err(e) => Err(Refusal {
            code: 502,
            message: e.to_string(),
        }),
    }
}

// ------------------------------------------------------------------------------ the demo

/// One of the demo's Secrets: namespace, name, type, and each key with a placeholder value.
type DemoSecret = (
    &'static str,
    &'static str,
    &'static str,
    &'static [(&'static str, &'static str)],
);
/// The demo's Secrets.
const DEMO_SECRETS: &[DemoSecret] = &[
    (
        "team-a",
        "api-db-credentials",
        "Opaque",
        &[
            ("username", "demo-user"),
            ("password", "demo-password-not-real"),
        ],
    ),
    (
        "team-a",
        "api-tls",
        "kubernetes.io/tls",
        &[
            (
                "tls.crt",
                "-----BEGIN CERTIFICATE-----\n(demo placeholder)\n-----END CERTIFICATE-----\n",
            ),
            (
                "tls.key",
                "-----BEGIN PRIVATE KEY-----\n(demo placeholder)\n-----END PRIVATE KEY-----\n",
            ),
        ],
    ),
    (
        "team-a",
        "worker-queue",
        "Opaque",
        &[("QUEUE_URL", "amqp://queue.example.invalid:5672")],
    ),
    (
        "team-b",
        "web-tls",
        "kubernetes.io/tls",
        &[
            ("tls.crt", "(demo placeholder)"),
            ("tls.key", "(demo placeholder)"),
        ],
    ),
    (
        "team-b",
        "registry-pull",
        "kubernetes.io/dockerconfigjson",
        &[(
            ".dockerconfigjson",
            "{\"auths\":{\"ghcr.io\":{\"auth\":\"ZGVtbzpkZW1v\"}}}",
        )],
    ),
    (
        "kube-system",
        "bootstrap-token-abcdef",
        "bootstrap.kubernetes.io/token",
        &[("token-id", "abcdef"), ("token-secret", "0123456789abcdef")],
    ),
    (
        "kube-system",
        "coredns-config-backup",
        "Opaque",
        &[("Corefile", ".:53 { forward . /etc/resolv.conf }")],
    ),
    (
        "mediatore-system",
        "broker-oidc-client",
        "Opaque",
        &[("client-secret", "demo-client-secret")],
    ),
    (
        "mediatore-system",
        "broker-tls",
        "kubernetes.io/tls",
        &[
            ("tls.crt", "(demo placeholder)"),
            ("tls.key", "(demo placeholder)"),
            ("ca.crt", "(demo placeholder)"),
        ],
    ),
    (
        "cert-manager",
        "cert-manager-webhook-ca",
        "Opaque",
        &[
            ("ca.crt", "(demo placeholder)"),
            ("tls.crt", "(demo placeholder)"),
            ("tls.key", "(demo placeholder)"),
        ],
    ),
    (
        "banlieue-system",
        "libvirt-client-tls",
        "kubernetes.io/tls",
        &[
            ("tls.crt", "(demo placeholder)"),
            ("tls.key", "(demo placeholder)"),
        ],
    ),
];

/// The demo's access: every namespace's Secrets are readable but kube-system's, so a locked
/// drawer shows.
#[must_use]
pub fn demo_can_read(ns: &str) -> bool {
    ns != "kube-system"
}

/// A drawer in the demo, as [`open_secret`] answers for a cluster.
///
/// # Errors
/// kube-system's (refused, as RBAC would) and an unknown Secret (not found).
pub fn demo_secret(ns: &str, name: &str, key: Option<&str>) -> Result<Value, Refusal> {
    if !demo_can_read(ns) {
        return Err(Refusal {
            code: 403,
            message: format!(
                "secrets \"{name}\" is forbidden: the demo user cannot get resource \"secrets\" in the namespace \"{ns}\""
            ),
        });
    }
    let (_, _, ty, kv) = DEMO_SECRETS
        .iter()
        .find(|(n, s, _, _)| *n == ns && *s == name)
        .ok_or_else(|| Refusal {
            code: 404,
            message: format!("secrets \"{name}\" not found"),
        })?;
    let sec = Secret {
        type_: Some((*ty).to_owned()),
        data: Some(
            kv.iter()
                .map(|(k, v)| {
                    (
                        (*k).to_owned(),
                        k8s_openapi::ByteString(v.as_bytes().to_vec()),
                    )
                })
                .collect(),
        ),
        ..Default::default()
    };
    drawer(&sec, key)
}

/// A container for the demo: name, image, and its state as the kubelet reports it.
struct DemoCtr {
    name: &'static str,
    image: &'static str,
    state: Value,
    ready: bool,
    restarts: u32,
}

fn running(since: &str) -> Value {
    json!({"running": {"startedAt": since}})
}

fn waiting(reason: &str) -> Value {
    json!({"waiting": {"reason": reason}})
}

fn pod_json(ns: &str, name: &str, node: &str, ip: &str, phase: &str, ctrs: &[DemoCtr]) -> Value {
    let since = "2026-11-25T08:00:00Z";
    json!({
        "apiVersion": "v1", "kind": "Pod",
        "metadata": {"name": name, "namespace": ns, "uid": format!("demo-{ns}-{name}"),
                     "creationTimestamp": since,
                     "labels": {"app.kubernetes.io/name": name.rsplit_once('-').map_or(name, |(a, _)| a)},
                     "ownerReferences": [{"kind": "ReplicaSet", "name": name.rsplit_once('-').map_or(name, |(a, _)| a), "controller": true}]},
        "spec": {
            "nodeName": node, "serviceAccountName": "default", "restartPolicy": "Always",
            "containers": ctrs.iter().map(|c| json!({
                "name": c.name, "image": c.image,
                "ports": if c.name == "app" { json!([{"containerPort": 8080, "protocol": "TCP"}]) } else { json!([]) },
                "resources": {"requests": {"cpu": "100m", "memory": "128Mi"}, "limits": {"memory": "256Mi"}},
            })).collect::<Vec<_>>(),
        },
        "status": {
            "phase": phase, "podIP": ip, "hostIP": "192.0.2.10", "qosClass": "Burstable", "startTime": since,
            "conditions": [{"type": "Ready", "status": if ctrs.iter().all(|c| c.ready) { "True" } else { "False" }}],
            "containerStatuses": ctrs.iter().map(|c| json!({
                "name": c.name, "image": c.image, "ready": c.ready, "restartCount": c.restarts, "state": c.state,
            })).collect::<Vec<_>>(),
        },
    })
}

fn cr_json(
    group: &str,
    version: &str,
    kind: &str,
    ns: &str,
    name: &str,
    ready: Option<bool>,
) -> Value {
    let cond = ready.map_or_else(
        || json!([]),
        |r| json!([{"type": "Ready", "status": if r { "True" } else { "False" }, "reason": if r { "Ready" } else { "Reconciling" }}]),
    );
    json!({
        "apiVersion": format!("{group}/{version}"), "kind": kind,
        "metadata": {"name": name, "namespace": ns, "uid": format!("demo-{ns}-{name}"), "creationTimestamp": "2026-11-25T08:00:00Z"},
        "spec": {},
        "status": {"conditions": cond},
    })
}

/// The demo's cluster: a few namespaces, their pods (one restarting, one pulling its image), and
/// custom resources from mediatore, banlieue and cert-manager. One pod cycles while it runs.
pub async fn demo(fleet: Arc<Fleet>) {
    let crds = [
        ("mediatore.io", "v1beta1", "AgentSandbox", "agentsandboxes"),
        (
            "banlieue.io",
            "v1alpha1",
            "VirtualMachine",
            "virtualmachines",
        ),
        (
            "sandbox.firestoned.io",
            "v1alpha2",
            "SandboxPolicy",
            "sandboxpolicies",
        ),
        ("cert-manager.io", "v1", "Certificate", "certificates"),
    ];
    for (g, v, k, p) in crds {
        fleet.put(
            "crd",
            format!("crd/{g}/{p}"),
            json!({"group": g, "version": v, "kind": k, "plural": p, "watch": format!("cr:{g}/{p}")}),
        );
    }
    for ns in [
        "default",
        "kube-system",
        "mediatore-system",
        "banlieue-system",
        "cert-manager",
        "team-a",
        "team-b",
    ] {
        fleet.put(
            "namespace",
            format!("namespace//{ns}"),
            json!({"apiVersion": "v1", "kind": "Namespace",
                   "metadata": {"name": ns, "creationTimestamp": "2026-11-20T09:00:00Z"},
                   "status": {"phase": "Active"}}),
        );
    }
    let ok = |name, image| DemoCtr {
        name,
        image,
        state: running("2026-11-25T08:00:00Z"),
        ready: true,
        restarts: 0,
    };
    let pods = [
        (
            "kube-system",
            "coredns-7db6d8ff4d-2xk9p",
            vec![ok("coredns", "registry.k8s.io/coredns/coredns:v1.12.0")],
        ),
        (
            "kube-system",
            "coredns-7db6d8ff4d-q8wz4",
            vec![ok("coredns", "registry.k8s.io/coredns/coredns:v1.12.0")],
        ),
        (
            "kube-system",
            "kube-proxy-hn5tl",
            vec![ok("kube-proxy", "registry.k8s.io/kube-proxy:v1.34.2")],
        ),
        (
            "kube-system",
            "kube-proxy-xv2rd",
            vec![ok("kube-proxy", "registry.k8s.io/kube-proxy:v1.34.2")],
        ),
        (
            "kube-system",
            "metrics-server-6d94bc8694-mm2sn",
            vec![ok(
                "metrics-server",
                "registry.k8s.io/metrics-server/metrics-server:v0.8.0",
            )],
        ),
        (
            "mediatore-system",
            "broker-5c8f7b9d6-4hlqz",
            vec![
                ok("broker", "ghcr.io/firestoned/mediatore:v0.9.0"),
                ok("log-shipper", "docker.io/fluent/fluent-bit:4.1"),
            ],
        ),
        (
            "mediatore-system",
            "broker-5c8f7b9d6-r7tmn",
            vec![
                ok("broker", "ghcr.io/firestoned/mediatore:v0.9.0"),
                ok("log-shipper", "docker.io/fluent/fluent-bit:4.1"),
            ],
        ),
        (
            "banlieue-system",
            "banlieue-controller-0",
            vec![ok("manager", "ghcr.io/firestoned/banlieue:v0.4.8")],
        ),
        (
            "cert-manager",
            "cert-manager-6c69f9f796-tq2bm",
            vec![ok(
                "cert-manager-controller",
                "quay.io/jetstack/cert-manager-controller:v1.19.1",
            )],
        ),
        (
            "cert-manager",
            "cert-manager-webhook-7d8f7f8b4-pw6xg",
            vec![ok(
                "cert-manager-webhook",
                "quay.io/jetstack/cert-manager-webhook:v1.19.1",
            )],
        ),
        (
            "team-a",
            "api-6f9c7d5b8-5xv7k",
            vec![
                ok("app", "ghcr.io/example/api:1.4.2"),
                ok("envoy", "docker.io/envoyproxy/envoy:v1.36.0"),
                ok("otel", "docker.io/otel/opentelemetry-collector:0.139.0"),
            ],
        ),
        (
            "team-a",
            "api-6f9c7d5b8-9kq2t",
            vec![
                ok("app", "ghcr.io/example/api:1.4.2"),
                ok("envoy", "docker.io/envoyproxy/envoy:v1.36.0"),
                ok("otel", "docker.io/otel/opentelemetry-collector:0.139.0"),
            ],
        ),
        (
            "team-a",
            "worker-7b5d9c8f6-lw4hz",
            vec![DemoCtr {
                name: "app",
                image: "ghcr.io/example/worker:2.0.0",
                state: waiting("CrashLoopBackOff"),
                ready: false,
                restarts: 7,
            }],
        ),
        (
            "team-b",
            "web-0",
            vec![ok("app", "ghcr.io/example/web:0.9.1")],
        ),
        (
            "team-b",
            "web-1",
            vec![DemoCtr {
                name: "app",
                image: "ghcr.io/example/web:0.9.2",
                state: waiting("ImagePullBackOff"),
                ready: false,
                restarts: 0,
            }],
        ),
        (
            "default",
            "debug-shell",
            vec![ok("shell", "docker.io/library/busybox:1.37")],
        ),
    ];
    for (i, (ns, name, ctrs)) in pods.iter().enumerate() {
        let phase = if ctrs.iter().any(|c| c.state.get("waiting").is_some())
            && ctrs.iter().all(|c| c.restarts == 0)
        {
            "Pending"
        } else {
            "Running"
        };
        fleet.put(
            "pod",
            format!("pod/{ns}/{name}"),
            pod_json(
                ns,
                name,
                if i % 2 == 0 { "worker-1" } else { "worker-2" },
                &format!("10.244.{}.{}", i % 3, 10 + i),
                phase,
                ctrs,
            ),
        );
    }
    let resources = [
        (
            "mediatore.io",
            "v1beta1",
            "AgentSandbox",
            "agentsandboxes",
            "team-a",
            "sandbox-f8e3aa8a",
            Some(true),
        ),
        (
            "mediatore.io",
            "v1beta1",
            "AgentSandbox",
            "agentsandboxes",
            "team-a",
            "sandbox-2b91c0de",
            None,
        ),
        (
            "mediatore.io",
            "v1beta1",
            "AgentSandbox",
            "agentsandboxes",
            "team-b",
            "sandbox-77d0e412",
            Some(false),
        ),
        (
            "sandbox.firestoned.io",
            "v1alpha2",
            "SandboxPolicy",
            "sandboxpolicies",
            "team-a",
            "default",
            Some(true),
        ),
        (
            "sandbox.firestoned.io",
            "v1alpha2",
            "SandboxPolicy",
            "sandboxpolicies",
            "team-b",
            "default",
            Some(true),
        ),
        (
            "banlieue.io",
            "v1alpha1",
            "VirtualMachine",
            "virtualmachines",
            "banlieue-system",
            "gateway-0",
            Some(true),
        ),
        (
            "banlieue.io",
            "v1alpha1",
            "VirtualMachine",
            "virtualmachines",
            "banlieue-system",
            "pool-standard-x4k2",
            Some(true),
        ),
        (
            "banlieue.io",
            "v1alpha1",
            "VirtualMachine",
            "virtualmachines",
            "banlieue-system",
            "pool-standard-m9p7",
            Some(false),
        ),
        (
            "cert-manager.io",
            "v1",
            "Certificate",
            "certificates",
            "mediatore-system",
            "broker-tls",
            Some(true),
        ),
        (
            "cert-manager.io",
            "v1",
            "Certificate",
            "certificates",
            "team-b",
            "web-tls",
            Some(false),
        ),
    ];
    for (g, v, k, p, ns, name, ready) in resources {
        fleet.put(
            &format!("cr:{g}/{p}"),
            format!("cr:{g}/{p}/{ns}/{name}"),
            cr_json(g, v, k, ns, name, ready),
        );
    }
    for (ns, name, _, _) in DEMO_SECRETS {
        fleet.put(
            "secret",
            format!("secret/{ns}/{name}"),
            json!({"apiVersion": "v1", "kind": "Secret",
                   "metadata": {"name": name, "namespace": ns, "uid": format!("demo-{ns}-{name}"),
                                "creationTimestamp": "2026-11-21T10:00:00Z"}}),
        );
    }
    // One pod cycles: pending, running, restarting.
    let mut tick = 0u32;
    loop {
        tokio::time::sleep(Duration::from_secs(6)).await;
        tick += 1;
        let (phase, state, ready) = match tick % 3 {
            0 => ("Pending", waiting("ContainerCreating"), false),
            1 => (
                "Running",
                running(&jiff::Timestamp::now().to_string()),
                true,
            ),
            _ => ("Running", waiting("CrashLoopBackOff"), false),
        };
        let ctrs = [DemoCtr {
            name: "app",
            image: "ghcr.io/example/batch:1.0.0",
            state,
            ready,
            restarts: tick / 3,
        }];
        fleet.put(
            "pod",
            "pod/team-b/batch-28f1c".to_owned(),
            pod_json(
                "team-b",
                "batch-28f1c",
                "worker-1",
                "10.244.1.40",
                phase,
                &ctrs,
            ),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_custom_resource_is_named_by_group_and_plural() {
        let ar = ApiResource::from_gvk_with_plural(
            &GroupVersionKind::gvk("mediatore.io", "v1beta1", "AgentSandbox"),
            "agentsandboxes",
        );
        assert_eq!(cr_kind(&ar), "cr:mediatore.io/agentsandboxes");
        let o: DynamicObject = serde_json::from_value(json!({
            "metadata": {"name": "s", "namespace": "team-a", "managedFields": [{}],
                         "annotations": {"kubectl.kubernetes.io/last-applied-configuration": "{}", "keep": "1"}}
        }))
        .unwrap();
        let (k, v) = keyed(&cr_kind(&ar), &ar, &o);
        assert_eq!(k, "cr:mediatore.io/agentsandboxes/team-a/s");
        assert_eq!(v["kind"], "AgentSandbox");
        assert_eq!(v["apiVersion"], "mediatore.io/v1beta1");
        assert!(v.pointer("/metadata/managedFields").is_none());
        assert_eq!(v.pointer("/metadata/annotations/keep"), Some(&json!("1")));
        assert!(
            v.pointer("/metadata/annotations/kubectl.kubernetes.io~1last-applied-configuration")
                .is_none()
        );
    }

    #[test]
    fn a_drawer_lists_keys_without_values_until_one_is_asked_for() {
        let sec = Secret {
            type_: Some("kubernetes.io/tls".into()),
            data: Some(
                [
                    (
                        "tls.key".to_owned(),
                        k8s_openapi::ByteString(b"secret".to_vec()),
                    ),
                    ("bin".to_owned(), k8s_openapi::ByteString(vec![0xff, 0x00])),
                ]
                .into(),
            ),
            ..Default::default()
        };
        let keys = drawer(&sec, None).ok().unwrap();
        assert_eq!(keys["type"], "kubernetes.io/tls");
        assert!(
            !keys.to_string().contains("secret\""),
            "no value in the listing"
        );
        assert_eq!(keys["keys"].as_array().unwrap().len(), 2);
        let v = drawer(&sec, Some("tls.key")).ok().unwrap();
        assert_eq!(v["value"], "secret");
        let b = drawer(&sec, Some("bin")).ok().unwrap();
        assert_eq!(
            (b["text"].as_bool(), b["value"].as_str()),
            (Some(false), Some("/wA="))
        );
        assert_eq!(drawer(&sec, Some("nope")).err().unwrap().code, 404);
        assert_eq!(
            demo_secret("kube-system", "x", None).err().unwrap().code,
            403
        );
    }

    #[test]
    fn a_secrets_last_applied_copy_never_reaches_the_page() {
        let m: SecretMeta = serde_json::from_value(json!({
            "apiVersion": "v1", "kind": "Secret",
            "metadata": {"name": "s", "namespace": "a", "annotations": {
                "kubectl.kubernetes.io/last-applied-configuration": "{\"data\":{\"p\":\"c2VjcmV0\"}}",
                "keep": "1"}}
        }))
        .unwrap();
        let (k, v) = secret_keyed(&m);
        assert_eq!(k, "secret/a/s");
        assert!(!v.to_string().contains("c2VjcmV0"));
        assert_eq!(v.pointer("/metadata/annotations/keep"), Some(&json!("1")));
    }

    #[test]
    fn kubernetes_own_groups_are_not_custom_resources() {
        for g in ["", "apps", "networking.k8s.io", "rbac.authorization.k8s.io"] {
            assert!(BUILTIN.contains(&g), "{g}");
        }
        // CRDs that live in .k8s.io groups stay custom.
        for g in [
            "gateway.networking.k8s.io",
            "snapshot.storage.k8s.io",
            "cluster.x-k8s.io",
        ] {
            assert!(!BUILTIN.contains(&g), "{g}");
        }
    }
}
