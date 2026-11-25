// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

//! What the Kubernetes API says around the sandbox: the egress gateway VMs, the sandbox's own
//! member VM (banlieue `VirtualMachine`s), and the Secrets the `AgentSandbox` owns, read as
//! metadata only. A Secret's data is never requested: the metadata API returns none.

use k8s_openapi::api::core::v1::Secret;
use kube::api::{ApiResource, DynamicObject, GroupVersionKind, ListParams};
use serde_json::{Value, json};

use crate::util::str_at;

/// How to find the egress gateways.
#[derive(Debug, Clone)]
pub struct GatewayQuery {
    /// A label selector; `mediatore.io/role=gateway` is what `deploy/gateway` labels them.
    pub selector: String,
    /// The namespace to look in; all namespaces when empty.
    pub namespace: String,
    /// Used when the selector finds nothing: VMs whose name starts with this.
    pub name_prefix: String,
}

fn vm_resource() -> ApiResource {
    ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk("banlieue.io", "v1alpha1", "VirtualMachine"),
        "virtualmachines",
    )
}

/// A banlieue `VirtualMachine` as the UI shows it.
#[must_use]
pub fn vm_summary(obj: &Value) -> Value {
    let ready = obj
        .pointer("/status/conditions")
        .and_then(Value::as_array)
        .and_then(|cs| cs.iter().find(|c| str_at(c, "/type") == "Ready"))
        .map(|c| {
            let reason = str_at(c, "/reason");
            if reason.is_empty() {
                str_at(c, "/status").to_owned()
            } else {
                format!("{} ({reason})", str_at(c, "/status"))
            }
        })
        .unwrap_or_default();
    let addresses: Vec<String> = obj
        .pointer("/status/addresses")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|x| {
                    let (t, ad) = (str_at(x, "/type"), str_at(x, "/address"));
                    if t.is_empty() {
                        ad.to_owned()
                    } else {
                        format!("{ad} ({t})")
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "name": str_at(obj, "/metadata/name"),
        "namespace": str_at(obj, "/metadata/namespace"),
        "uid": str_at(obj, "/metadata/uid"),
        "created": str_at(obj, "/metadata/creationTimestamp"),
        "role": str_at(obj, "/metadata/labels/mediatore.io~1role"),
        "class": str_at(obj, "/spec/classRef/name"),
        "image": str_at(obj, "/spec/imageRef/name"),
        "power": str_at(obj, "/status/observedPowerState"),
        "ready": ready,
        "provider": str_at(obj, "/status/scheduled/providerName"),
        "providerClass": str_at(obj, "/status/scheduled/providerClass"),
        "failureDomain": str_at(obj, "/status/scheduled/failureDomain"),
        "addresses": addresses,
        "attestationSubject": str_at(obj, "/status/attestationSubject"),
    })
}

/// The egress gateway VMs: by label, then by name prefix if the label finds none.
///
/// # Errors
/// The list call failing (no RBAC to list `virtualmachines.banlieue.io`, no such CRD).
pub async fn gateways(client: kube::Client, q: &GatewayQuery) -> anyhow::Result<Vec<Value>> {
    let ar = vm_resource();
    let api: kube::Api<DynamicObject> = if q.namespace.is_empty() {
        kube::Api::all_with(client, &ar)
    } else {
        kube::Api::namespaced_with(client, &q.namespace, &ar)
    };
    let mut items = if q.selector.is_empty() {
        vec![]
    } else {
        api.list(&ListParams::default().labels(&q.selector))
            .await?
            .items
    };
    if items.is_empty() && !q.name_prefix.is_empty() {
        items = api
            .list(&ListParams::default())
            .await?
            .items
            .into_iter()
            .filter(|o| {
                o.metadata
                    .name
                    .as_deref()
                    .is_some_and(|n| n.starts_with(&q.name_prefix))
            })
            .collect();
    }
    let mut out: Vec<Value> = items
        .iter()
        .filter_map(|o| serde_json::to_value(o).ok())
        .map(|v| vm_summary(&v))
        .collect();
    out.sort_by(|a, b| str_at(a, "/name").cmp(str_at(b, "/name")));
    Ok(out)
}

/// One `VirtualMachine` by name, if it exists and is readable.
pub async fn vm(client: kube::Client, ns: &str, name: &str) -> Option<Value> {
    let api: kube::Api<DynamicObject> = kube::Api::namespaced_with(client, ns, &vm_resource());
    let o = api.get_opt(name).await.ok().flatten()?;
    serde_json::to_value(&o).ok().map(|v| vm_summary(&v))
}

/// The Secrets mediatore wrote for this sandbox and claim, in the broker's namespace, as
/// metadata only: name, labels, the `mediatore.io/` annotations (sequence numbers and the seal
/// marker), creation time. Never the data. Matched by label, not owner: a sandbox in another
/// namespace than the broker's has no owner reference on them.
///
/// # Errors
/// The list call failing (no RBAC to list Secrets' metadata there).
pub async fn claim_secrets(
    client: kube::Client,
    broker_ns: &str,
    sandbox_uid: &str,
    claim_uid: &str,
) -> anyhow::Result<Vec<Value>> {
    let api: kube::Api<Secret> = kube::Api::namespaced(client, broker_ns);
    let mut selectors = Vec::new();
    if !sandbox_uid.is_empty() {
        selectors.push(format!("mediatore.io/sandbox-uid={sandbox_uid}"));
    }
    if !claim_uid.is_empty() {
        selectors.push(format!(
            "mediatore.io/logs=segment,mediatore.io/claim-uid={claim_uid}"
        ));
    }
    let mut seen = std::collections::BTreeMap::new();
    for sel in selectors {
        for m in api
            .list_metadata(&ListParams::default().labels(&sel))
            .await?
            .items
        {
            let md = m.metadata;
            let name = md.name.unwrap_or_default();
            let annotations: std::collections::BTreeMap<String, String> = md
                .annotations
                .unwrap_or_default()
                .into_iter()
                .filter(|(k, _)| k.starts_with("mediatore.io/"))
                .collect();
            seen.insert(
                name.clone(),
                json!({
                    "name": name,
                    "labels": md.labels.unwrap_or_default(),
                    "annotations": annotations,
                    "created": md.creation_timestamp.map(|t| t.0.to_string()).unwrap_or_default(),
                }),
            );
        }
    }
    Ok(seen.into_values().collect())
}

/// A banlieue `VirtualMachinePool` and its members, for "why is my claim not bound yet":
/// how many are warm, claimed, provisioning, and which member is booting since when.
///
/// # Errors
/// The get or list call failing.
pub async fn pool_status(client: kube::Client, ns: &str, name: &str) -> anyhow::Result<Value> {
    let pools = ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk("banlieue.io", "v1alpha1", "VirtualMachinePool"),
        "virtualmachinepools",
    );
    let api: kube::Api<DynamicObject> = kube::Api::namespaced_with(client.clone(), ns, &pools);
    let Some(pool) = api.get_opt(name).await? else {
        return Ok(json!({"name": name, "missing": true}));
    };
    let p = serde_json::to_value(&pool)?;
    let warm = p
        .pointer("/status/conditions")
        .and_then(Value::as_array)
        .and_then(|cs| cs.iter().find(|c| str_at(c, "/type") == "Warm"))
        .map(|c| str_at(c, "/message").to_owned())
        .unwrap_or_default();
    let vms: kube::Api<DynamicObject> = kube::Api::namespaced_with(client, ns, &vm_resource());
    let mut members: Vec<Value> = vms
        .list(&ListParams::default())
        .await?
        .items
        .iter()
        .filter(|o| {
            o.metadata
                .owner_references
                .as_ref()
                .is_some_and(|rs| rs.iter().any(|r| r.name == name))
                || o.metadata
                    .name
                    .as_deref()
                    .is_some_and(|n| n.starts_with(&format!("{name}-")))
        })
        .filter_map(|o| serde_json::to_value(o).ok())
        .map(|v| {
            let guest = v
                .pointer("/status/conditions")
                .and_then(Value::as_array)
                .and_then(|cs| cs.iter().find(|c| str_at(c, "/type") == "GuestReady"))
                .is_some_and(|c| str_at(c, "/status") == "True");
            json!({
                "name": str_at(&v, "/metadata/name"),
                "created": str_at(&v, "/metadata/creationTimestamp"),
                "power": str_at(&v, "/status/observedPowerState"),
                "guestReady": guest,
            })
        })
        .collect();
    members.sort_by(|a, b| str_at(a, "/created").cmp(str_at(b, "/created")));
    let n = |k: &str| {
        p.pointer(&format!("/status/{k}"))
            .and_then(Value::as_i64)
            .unwrap_or(0)
    };
    Ok(json!({
        "name": name,
        "available": n("available"),
        "claimed": n("claimed"),
        "provisioning": n("provisioning"),
        "replicas": n("replicas"),
        "warm": warm,
        "members": members,
    }))
}

/// The banlieue claim's `Bound` condition: why a claim is not bound yet, in banlieue's words
/// (`NoMemberAvailable: no Ready, unclaimed member in pool ...`).
///
/// # Errors
/// The get call failing.
pub async fn claim_bound(
    client: kube::Client,
    ns: &str,
    name: &str,
) -> anyhow::Result<Option<Value>> {
    let ar = ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk("banlieue.io", "v1alpha1", "VirtualMachineClaim"),
        "virtualmachineclaims",
    );
    let api: kube::Api<DynamicObject> = kube::Api::namespaced_with(client, ns, &ar);
    let Some(o) = api.get_opt(name).await? else {
        return Ok(None);
    };
    let v = serde_json::to_value(&o)?;
    Ok(v.pointer("/status/conditions")
        .and_then(Value::as_array)
        .and_then(|cs| cs.iter().find(|c| str_at(c, "/type") == "Bound"))
        .map(|c| {
            json!({
                "status": str_at(c, "/status"),
                "reason": str_at(c, "/reason"),
                "message": str_at(c, "/message"),
                "since": str_at(c, "/lastTransitionTime"),
            })
        }))
}

/// One `AgentSandbox` as the recent-runs list shows it: what ran, where, and how it ended.
#[must_use]
pub fn recent_summary(obj: &Value) -> Value {
    let exit = obj.pointer("/status/record/exit");
    let phase = str_at(obj, "/status/phase");
    let revoked = !str_at(obj, "/status/record/revokedAt").is_empty();
    let reported = obj.pointer("/status/record/report").is_some();
    let (status, tone) = match exit {
        Some(x) => match (
            x.get("code").and_then(Value::as_i64),
            x.get("signal").and_then(Value::as_i64),
        ) {
            (Some(0), _) => ("exit 0".to_owned(), "ok"),
            (Some(c), _) => (format!("exit {c}"), "bad"),
            (None, Some(sig)) => (format!("signal {sig}"), "bad"),
            _ => ("exited".to_owned(), "ok"),
        },
        None if phase == "Failed" => {
            let r = str_at(obj, "/status/reason");
            (
                if r.is_empty() {
                    "failed".to_owned()
                } else {
                    format!("failed: {r}")
                },
                "bad",
            )
        }
        None if revoked => ("released before an exit".to_owned(), "idle"),
        None if phase == "Bound" && reported => ("running".to_owned(), "live"),
        None if phase == "Bound" => ("starting: no guest report yet".to_owned(), "live"),
        None if phase == "Releasing" => ("releasing".to_owned(), "idle"),
        None => ("waiting for a VM".to_owned(), "live"),
    };
    let args: Vec<String> = obj
        .pointer("/spec/workload/args")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(ToOwned::to_owned))
                .collect()
        })
        .unwrap_or_default();
    json!({
        "name": str_at(obj, "/metadata/name"),
        "namespace": str_at(obj, "/metadata/namespace"),
        "created": str_at(obj, "/metadata/creationTimestamp"),
        "image": str_at(obj, "/spec/workload/image"),
        "args": args,
        "phase": phase,
        "vm": str_at(obj, "/status/virtualMachineRef/name"),
        "addresses": obj.pointer("/status/addresses").cloned().unwrap_or(json!([])),
        "boundAt": str_at(obj, "/status/boundAt"),
        "reportedAt": str_at(obj, "/status/record/report/reported_at"),
        "exitedAt": exit.map(|x| str_at(x, "/exited_at")).unwrap_or_default(),
        "status": status,
        "tone": tone,
    })
}

/// The `AgentSandbox`es in `ns` whose subject is `ids` at `issuer` (any of the ID token's
/// names: the broker's `subject_claim` decides which one it pinned), newest first. Without
/// ids, every sandbox the kubeconfig may list.
///
/// # Errors
/// The list call failing.
pub async fn recent_sandboxes(
    client: kube::Client,
    ns: &str,
    issuer: &str,
    ids: &[String],
    limit: usize,
) -> anyhow::Result<Vec<Value>> {
    let ar = ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk("mediatore.io", "v1beta1", "AgentSandbox"),
        "agentsandboxes",
    );
    let api: kube::Api<DynamicObject> = kube::Api::namespaced_with(client, ns, &ar);
    let trim = |s: &str| s.trim_end_matches('/').to_owned();
    let mut items: Vec<Value> = api
        .list(&ListParams::default())
        .await?
        .items
        .iter()
        .filter_map(|o| serde_json::to_value(o).ok())
        .filter(|o| {
            ids.is_empty()
                || (trim(str_at(o, "/spec/subject/issuer")) == trim(issuer)
                    && ids.iter().any(|id| id == str_at(o, "/spec/subject/id")))
        })
        .collect();
    items.sort_by(|a, b| {
        str_at(b, "/metadata/creationTimestamp").cmp(str_at(a, "/metadata/creationTimestamp"))
    });
    Ok(items.iter().take(limit).map(recent_summary).collect())
}

fn entry_resource() -> ApiResource {
    ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk("spire.spiffe.io", "v1alpha1", "ClusterStaticEntry"),
        "clusterstaticentries",
    )
}

/// A SPIRE `ClusterStaticEntry` as the UI shows it: who the entry names, under which agent,
/// with which selectors, and whether the controller manager has put it on the SPIRE server.
#[must_use]
pub fn entry_summary(obj: &Value) -> Value {
    json!({
        "name": str_at(obj, "/metadata/name"),
        "created": str_at(obj, "/metadata/creationTimestamp"),
        "spiffeId": str_at(obj, "/spec/spiffeID"),
        "parentId": str_at(obj, "/spec/parentID"),
        "selectors": obj.pointer("/spec/selectors").cloned().unwrap_or_else(|| json!([])),
        "ttl": str_at(obj, "/spec/x509SVIDTTL"),
        "className": str_at(obj, "/spec/className"),
        "hint": str_at(obj, "/spec/hint"),
        "rendered": obj.pointer("/status/rendered").and_then(Value::as_bool),
        "masked": obj.pointer("/status/masked").and_then(Value::as_bool),
        "set": obj.pointer("/status/set").and_then(Value::as_bool),
    })
}

/// The claim's SPIRE registration entries, as the broker declares them (mediatore ADR-0006):
/// `mediatore-claim-<claim uid>`, and the node entry under the same agent
/// (`mediatore-node-...`). Empty until the broker writes them; an error when this kubeconfig
/// may not read `clusterstaticentries` (cluster-scoped, `spire.spiffe.io`).
pub async fn spire_entries(client: kube::Client, claim_uid: &str) -> anyhow::Result<Vec<Value>> {
    if claim_uid.is_empty() {
        return Ok(Vec::new());
    }
    let api: kube::Api<DynamicObject> = kube::Api::all_with(client, &entry_resource());
    let Some(claim) = api.get_opt(&format!("mediatore-claim-{claim_uid}")).await? else {
        return Ok(Vec::new());
    };
    let claim = serde_json::to_value(&claim)?;
    let parent = str_at(&claim, "/spec/parentID").to_owned();
    let mut out = vec![entry_summary(&claim)];
    if !parent.is_empty() {
        let all = api.list(&ListParams::default()).await?;
        for o in all {
            let v = serde_json::to_value(&o)?;
            if str_at(&v, "/metadata/name").starts_with("mediatore-node-")
                && str_at(&v, "/spec/parentID") == parent
            {
                out.push(entry_summary(&v));
            }
        }
    }
    Ok(out)
}

fn notaio_resource(kind: &str, plural: &str) -> ApiResource {
    ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk("sandbox.firestoned.io", "v1alpha2", kind),
        plural,
    )
}

/// An object as the page shows it: without `managedFields`, which only the API server reads.
fn trimmed(o: &DynamicObject) -> anyhow::Result<Value> {
    let mut v = serde_json::to_value(o)?;
    if let Some(m) = v.get_mut("metadata").and_then(Value::as_object_mut) {
        m.remove("managedFields");
    }
    Ok(v)
}

/// The notaio `SandboxPolicy` a sandbox runs under, and its `ExposureCeiling` (notaio ADR-0007:
/// the same name, in the policy's namespace; none fails closed, the policy is not published).
/// The policy is found by the uid the broker put on the record (it may live in another
/// namespace than the sandbox, mediatore ADR-0054), else by name in the sandbox's namespace.
/// `{"object": .., "ceiling": ..}`, each null when there is none.
///
/// # Errors
/// A get or list this kubeconfig may not make.
pub async fn policy_and_ceiling(
    client: kube::Client,
    sandbox_ns: &str,
    name: &str,
    uid: &str,
) -> anyhow::Result<Value> {
    let pr = notaio_resource("SandboxPolicy", "sandboxpolicies");
    let mut policy = None;
    if !uid.is_empty() {
        let all: kube::Api<DynamicObject> = kube::Api::all_with(client.clone(), &pr);
        policy = all
            .list(&ListParams::default())
            .await?
            .into_iter()
            .find(|o| o.metadata.uid.as_deref() == Some(uid));
    }
    if policy.is_none() && !name.is_empty() {
        let api: kube::Api<DynamicObject> =
            kube::Api::namespaced_with(client.clone(), sandbox_ns, &pr);
        policy = api.get_opt(name).await?;
    }
    let Some(policy) = policy else {
        return Ok(json!({"object": null, "ceiling": null}));
    };
    let ns = policy.metadata.namespace.clone().unwrap_or_default();
    let pname = policy.metadata.name.clone().unwrap_or_default();
    let cr = notaio_resource("ExposureCeiling", "exposureceilings");
    let api: kube::Api<DynamicObject> = kube::Api::namespaced_with(client, &ns, &cr);
    let ceiling = match api.get_opt(&pname).await? {
        Some(c) => trimmed(&c)?,
        None => Value::Null,
    };
    Ok(json!({"object": trimmed(&policy)?, "ceiling": ceiling}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarises_a_gateway_vm() {
        let vm = json!({
            "metadata": {"name": "gateway-01", "namespace": "gateways", "uid": "u1",
                "labels": {"mediatore.io/role": "gateway"}},
            "spec": {"classRef": {"name": "gateway-standard"}, "imageRef": {"name": "mediatore-gateway"}},
            "status": {
                "observedPowerState": "PoweredOn",
                "scheduled": {"providerName": "host-a", "providerClass": "libvirt", "failureDomain": "fd-1"},
                "addresses": [{"type": "InternalIP", "address": "198.51.100.1"}],
                "attestationSubject": "spiffe://sandbox.test/gateway/01",
                "conditions": [{"type": "Ready", "status": "True", "reason": "Running"}]
            }
        });
        let s = vm_summary(&vm);
        assert_eq!(s["name"], "gateway-01");
        assert_eq!(s["role"], "gateway");
        assert_eq!(s["power"], "PoweredOn");
        assert_eq!(s["ready"], "True (Running)");
        assert_eq!(s["failureDomain"], "fd-1");
        assert_eq!(s["addresses"], json!(["198.51.100.1 (InternalIP)"]));
        assert_eq!(s["class"], "gateway-standard");
    }

    #[test]
    fn an_empty_vm_summarises_to_blanks() {
        let s = vm_summary(&json!({"metadata": {"name": "x"}}));
        assert_eq!(s["ready"], "");
        assert_eq!(s["addresses"], json!([]));
    }

    #[test]
    fn summarises_how_a_run_ended() {
        let base = |status: Value| {
            json!({"metadata": {"name": "s", "creationTimestamp": "2026-11-20T06:14:35Z"},
            "spec": {"workload": {"image": "registry.internal:5000/python", "args": ["python3", "-c", "print(1)"]}},
            "status": status})
        };
        let st = |status: Value| {
            let v = recent_summary(&base(status));
            (
                v["status"].as_str().unwrap().to_owned(),
                v["tone"].as_str().unwrap().to_owned(),
            )
        };
        assert_eq!(
            st(json!({"phase": "Bound", "record": {"exit": {"code": 0}}})),
            ("exit 0".into(), "ok".into())
        );
        assert_eq!(
            st(json!({"phase": "Bound", "record": {"exit": {"code": 3}}})),
            ("exit 3".into(), "bad".into())
        );
        assert_eq!(
            st(json!({"phase": "Bound", "record": {}})),
            ("starting: no guest report yet".into(), "live".into())
        );
        assert_eq!(
            st(json!({"phase": "Bound", "record": {"report": {}}})),
            ("running".into(), "live".into())
        );
        assert_eq!(
            st(json!({"phase": "Failed", "reason": "no member"})),
            ("failed: no member".into(), "bad".into())
        );
        assert_eq!(
            st(json!({"phase": "Bound", "record": {"revokedAt": "t"}})),
            ("released before an exit".into(), "idle".into())
        );
        assert_eq!(
            st(json!({"phase": "Pending"})),
            ("waiting for a VM".into(), "live".into())
        );
        assert_eq!(
            recent_summary(&base(json!({})))["args"],
            json!(["python3", "-c", "print(1)"])
        );
    }
}
