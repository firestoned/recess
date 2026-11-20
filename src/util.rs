// Copyright (c) 2026 Erick Bourgeois, Low Tide
// SPDX-License-Identifier: Apache-2.0

//! The pure pieces: the workload text field, the ID token's claims for display, and the
//! AgentSandbox's changes between two watch events.

use std::collections::{BTreeMap, BTreeSet};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest as _, Sha256};

/// Read the workload field, `IMAGE [ARG...]`, split as a POSIX shell splits words (single
/// quotes, double quotes, backslash escapes) with no expansion of any kind.
///
/// # Errors
/// An unterminated quote, a trailing backslash, or no image.
pub fn split_workload(s: &str) -> anyhow::Result<(String, Vec<String>)> {
    let mut words: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for c in s.chars() {
        if escaped {
            cur.push(c);
            escaped = false;
            continue;
        }
        match (quote, c) {
            (Some('\''), '\'') | (Some('"'), '"') => quote = None,
            (Some('"'), '\\') => escaped = true,
            (Some(_), _) => cur.push(c),
            (None, '\\') => (escaped, in_word) = (true, true),
            (None, '\'' | '"') => (quote, in_word) = (Some(c), true),
            (None, ' ' | '\t' | '\n' | '\r') => {
                if in_word {
                    words.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            (None, _) => {
                cur.push(c);
                in_word = true;
            }
        }
    }
    if let Some(q) = quote {
        anyhow::bail!("unterminated {q} quote");
    }
    anyhow::ensure!(!escaped, "trailing backslash");
    if in_word {
        words.push(cur);
    }
    let mut it = words.into_iter();
    match it.next() {
        Some(image) if !image.is_empty() => Ok((image, it.collect())),
        _ => anyhow::bail!("no image: the field is IMAGE [ARG...]"),
    }
}

/// What the UI shows of the ID token: the claims a person reads, never the token.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub issuer: String,
    pub subject: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub username: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub email: String,
    pub audience: Vec<String>,
    pub groups: Vec<String>,
    pub issued_at: Option<i64>,
    pub expires_at: Option<i64>,
    /// Every claim's name, sorted; values not listed above are not carried.
    pub claim_names: Vec<String>,
    /// The first 8 bytes of the token's SHA-256, hex: tells two logins apart, reveals nothing.
    pub fingerprint: String,
}

/// The token's fingerprint: the first 8 bytes of its SHA-256, hex.
#[must_use]
pub fn fingerprint(token: &str) -> String {
    hex::encode(&Sha256::digest(token.as_bytes())[..8])
}

/// Decode the ID token's payload for display. The signature is not verified: the broker
/// verifies it on every call, and nothing here grants anything.
///
/// # Errors
/// Not three dot-separated parts, or a payload that is not a base64url JSON object.
pub fn identity_of(token: &str) -> anyhow::Result<Identity> {
    let parts: Vec<&str> = token.split('.').collect();
    anyhow::ensure!(
        parts.len() == 3,
        "the ID token is not a JWS compact serialization"
    );
    let raw = URL_SAFE_NO_PAD
        .decode(parts[1].trim_end_matches('='))
        .map_err(|e| anyhow::anyhow!("the ID token's payload: {e}"))?;
    let c: serde_json::Map<String, Value> =
        serde_json::from_slice(&raw).map_err(|e| anyhow::anyhow!("the ID token's payload: {e}"))?;
    let s = |k: &str| {
        c.get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let n = |k: &str| c.get(k).and_then(Value::as_i64);
    let list = |k: &str| -> Vec<String> {
        match c.get(k) {
            Some(Value::String(v)) => vec![v.clone()],
            Some(Value::Array(v)) => v
                .iter()
                .filter_map(|x| x.as_str().map(ToOwned::to_owned))
                .collect(),
            _ => vec![],
        }
    };
    let mut claim_names: Vec<String> = c.keys().cloned().collect();
    claim_names.sort();
    Ok(Identity {
        issuer: s("iss"),
        subject: s("sub"),
        username: s("preferred_username"),
        name: s("name"),
        email: s("email"),
        audience: list("aud"),
        groups: list("groups"),
        issued_at: n("iat"),
        expires_at: n("exp"),
        claim_names,
        fingerprint: fingerprint(token),
    })
}

/// Paths `flatten` leaves out: noise on every write, or a copy of the spec.
const DROPPED: &[&str] = &[
    "metadata.managedFields",
    "metadata.resourceVersion",
    "metadata.annotations.kubectl.kubernetes.io/last-applied-configuration",
];

/// An object as dotted paths and the text of each leaf (a string as is, anything else as
/// JSON). Arrays are leaves.
#[must_use]
pub fn flatten(obj: &Value) -> BTreeMap<String, String> {
    fn walk(prefix: &str, v: &Value, out: &mut BTreeMap<String, String>) {
        if DROPPED.contains(&prefix) {
            return;
        }
        match v {
            Value::Object(m) => {
                for (k, x) in m {
                    let p = if prefix.is_empty() {
                        k.clone()
                    } else {
                        format!("{prefix}.{k}")
                    };
                    walk(&p, x, out);
                }
            }
            Value::String(s) => {
                out.insert(prefix.to_owned(), s.clone());
            }
            other => {
                out.insert(prefix.to_owned(), other.to_string());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk("", obj, &mut out);
    out
}

/// One path whose value differs between two versions of an object; absent is "".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Change {
    pub path: String,
    pub from: String,
    pub to: String,
}

/// What changed from `a` to `b`, sorted by path.
#[must_use]
pub fn diff(a: &BTreeMap<String, String>, b: &BTreeMap<String, String>) -> Vec<Change> {
    let keys: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
    keys.into_iter()
        .filter_map(|k| {
            let (x, y) = (
                a.get(k).map_or("", String::as_str),
                b.get(k).map_or("", String::as_str),
            );
            (x != y).then(|| Change {
                path: k.clone(),
                from: x.to_owned(),
                to: y.to_owned(),
            })
        })
        .collect()
}

/// `status.record.exit` as the broker records it (`WorkloadExit`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exit {
    pub exited_at: String,
    pub code: Option<i64>,
    pub signal: Option<i64>,
    pub restarts: i64,
}

/// The workload's exit off an AgentSandbox, once the guest has reported one.
#[must_use]
pub fn exit_of(obj: &Value) -> Option<Exit> {
    let x = obj.pointer("/status/record/exit")?.as_object()?;
    Some(Exit {
        exited_at: x
            .get("exited_at")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        code: x.get("code").and_then(Value::as_i64),
        signal: x.get("signal").and_then(Value::as_i64),
        restarts: x.get("restarts").and_then(Value::as_i64).unwrap_or(0),
    })
}

/// A string at a JSON pointer, or "".
#[must_use]
pub fn str_at<'a>(v: &'a Value, pointer: &str) -> &'a str {
    v.pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn splits_the_workload_like_a_shell() {
        let ok = |s: &str, image: &str, args: &[&str]| {
            let (i, a) = split_workload(s).unwrap();
            assert_eq!(i, image, "{s}");
            assert_eq!(a, args, "{s}");
        };
        ok("alpine:3.20", "alpine:3.20", &[]);
        ok("  alpine echo hi  ", "alpine", &["echo", "hi"]);
        ok(
            r#"alpine sh -c 'echo "a b"; exit 3'"#,
            "alpine",
            &["sh", "-c", r#"echo "a b"; exit 3"#],
        );
        ok(r#"img "x y" z\ w"#, "img", &["x y", "z w"]);
        ok("img ''", "img", &[""]);
        ok(r#"img "say \"hi\"""#, "img", &[r#"say "hi""#]);
        for bad in [
            "",
            "   ",
            "img 'open",
            r#"img "open"#,
            "img trailing\\",
            "'' arg",
        ] {
            assert!(split_workload(bad).is_err(), "{bad:?} must be refused");
        }
    }

    fn jwt(claims: &Value) -> String {
        format!(
            "eyJhbGciOiJub25lIn0.{}.sig",
            URL_SAFE_NO_PAD.encode(claims.to_string())
        )
    }

    #[test]
    fn reads_the_claims_a_person_reads() {
        let id = identity_of(&jwt(&json!({
            "iss": "https://dex.example.com", "sub": "abc", "aud": "mediatore",
            "exp": 2_000_000_000, "iat": 1_999_990_000,
            "preferred_username": "octocat", "email": "octocat@example.com",
            "groups": ["sandbox-users", "admins"], "at_hash": "zzz"
        })))
        .unwrap();
        assert_eq!(id.username, "octocat");
        assert_eq!(id.subject, "abc");
        assert_eq!(id.groups, ["sandbox-users", "admins"]);
        assert_eq!(id.audience, ["mediatore"]);
        assert_eq!(id.expires_at, Some(2_000_000_000));
        assert_eq!(
            id.claim_names,
            [
                "at_hash",
                "aud",
                "email",
                "exp",
                "groups",
                "iat",
                "iss",
                "preferred_username",
                "sub"
            ]
        );
        assert_eq!(id.fingerprint.len(), 16);
    }

    #[test]
    fn an_audience_list_and_no_groups() {
        let id = identity_of(&jwt(&json!({"aud": ["a", "b"], "sub": "s"}))).unwrap();
        assert_eq!(id.audience, ["a", "b"]);
        assert!(id.groups.is_empty());
    }

    #[test]
    fn refuses_what_is_not_a_jwt() {
        let array = format!("a.{}.c", URL_SAFE_NO_PAD.encode("[1]"));
        for t in ["", "a.b", "a.!!!.c", array.as_str()] {
            assert!(identity_of(t).is_err(), "{t:?} must be refused");
        }
    }

    #[test]
    fn diffs_status_and_drops_noise() {
        let a = json!({"metadata": {"name": "s", "resourceVersion": "1", "managedFields": [{"x": 1}],
            "annotations": {"kubectl.kubernetes.io/last-applied-configuration": "{}", "k": "v"}},
            "status": {"phase": "Pending", "ready": false, "addresses": []}});
        let b = json!({"metadata": {"name": "s", "resourceVersion": "2", "managedFields": [{"x": 2}],
            "annotations": {"k": "v"}},
            "status": {"phase": "Bound", "ready": false, "boundAt": "2026-11-19T10:00:00Z",
                "addresses": ["192.0.2.5"], "record": {"exit": {"code": 0}}}});
        let (fa, fb) = (flatten(&a), flatten(&b));
        assert!(!fa.contains_key("metadata.managedFields"));
        assert!(!fa.contains_key("metadata.resourceVersion"));
        assert!(!fa.keys().any(|k| k.contains("last-applied")));
        let ch = |p: &str, f: &str, t: &str| Change {
            path: p.into(),
            from: f.into(),
            to: t.into(),
        };
        assert_eq!(
            diff(&fa, &fb),
            [
                ch("status.addresses", "[]", r#"["192.0.2.5"]"#),
                ch("status.boundAt", "", "2026-11-19T10:00:00Z"),
                ch("status.phase", "Pending", "Bound"),
                ch("status.record.exit.code", "", "0"),
            ]
        );
        assert!(diff(&fb, &fb).is_empty());
    }

    #[test]
    fn reads_the_exit() {
        let obj = json!({"status": {"record": {"exit":
            {"exited_at": "2026-11-19T10:00:00Z", "code": 3, "restarts": 1}}}});
        assert_eq!(
            exit_of(&obj),
            Some(Exit {
                exited_at: "2026-11-19T10:00:00Z".into(),
                code: Some(3),
                signal: None,
                restarts: 1
            })
        );
        assert_eq!(exit_of(&json!({"status": {"phase": "Bound"}})), None);
    }
}
