// Copyright (c) 2026 Erick Bourgeois, Low Tide
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
}
