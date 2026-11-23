// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

//! The HTTP proxy, for a network that reaches the outside (or the cluster) only through one.
//!
//! Recess reads it as every other tool does: `HTTPS_PROXY` (or `https_proxy`), with the hosts
//! that skip it in `NO_PROXY` (or `no_proxy`). The Kubernetes client takes it from there or from
//! the kubeconfig's `proxy-url` (kube-rs, with its `http-proxy` and `socks5` features), and the
//! issuer and the broker are reached through it by reqwest. This module covers the one
//! connection Recess dials itself: the TLS probe, tunnelled with `CONNECT`.

use std::fmt::Write as _;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpStream;

/// A proxy to tunnel through: where it is, and its credentials if the URL carries them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proxy {
    pub host: String,
    pub port: u16,
    /// `user:password`, from the URL's userinfo; never printed.
    auth: Option<String>,
}

impl Proxy {
    /// `host:port`, for display: never the credentials.
    #[must_use]
    pub fn display(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

fn first_env(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|n| std::env::var(n).ok())
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

/// The proxy for `host`, from the environment.
///
/// # Errors
/// A proxy URL that is not one, or one this tunnel cannot use (only `http://` proxies).
pub fn for_host(host: &str) -> anyhow::Result<Option<Proxy>> {
    choose(
        first_env(&["HTTPS_PROXY", "https_proxy"]).as_deref(),
        first_env(&["NO_PROXY", "no_proxy"]).as_deref(),
        host,
    )
}

/// The proxy for `host`, given `HTTPS_PROXY` and `NO_PROXY`'s values.
fn choose(
    proxy: Option<&str>,
    no_proxy: Option<&str>,
    host: &str,
) -> anyhow::Result<Option<Proxy>> {
    let Some(raw) = proxy else { return Ok(None) };
    if no_proxy.is_some_and(|np| exempt(np, host)) {
        return Ok(None);
    }
    let with_scheme = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("http://{raw}")
    };
    let u = reqwest::Url::parse(&with_scheme)
        .map_err(|e| anyhow::anyhow!("HTTPS_PROXY is not a URL: {e}"))?;
    anyhow::ensure!(
        u.scheme() == "http",
        "HTTPS_PROXY {}://{}: the TLS probe tunnels through http:// proxies only",
        u.scheme(),
        u.host_str().unwrap_or_default()
    );
    let host_p = u
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("HTTPS_PROXY has no host"))?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    let auth = (!u.username().is_empty()).then(|| {
        format!(
            "{}:{}",
            percent_decode(u.username()),
            percent_decode(u.password().unwrap_or_default())
        )
    });
    Ok(Some(Proxy {
        host: host_p,
        port: u.port().unwrap_or(80),
        auth,
    }))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(v);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Whether `NO_PROXY` exempts `host`: `*`; the host itself; a domain it is in (`example.com`
/// or `.example.com` both cover `a.example.com`); an IP address, or a CIDR block holding it.
/// A `:port` on an entry is ignored.
#[must_use]
pub fn exempt(no_proxy: &str, host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let ip = host.parse::<std::net::IpAddr>().ok();
    no_proxy
        .split(',')
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .any(|e| {
            if e == "*" {
                return true;
            }
            if let Some((net, bits)) = e.split_once('/') {
                return ip.is_some_and(|ip| in_cidr(ip, net, bits));
            }
            let e = e.trim_start_matches('[');
            let e = match e.split_once(']') {
                Some((addr, _)) => addr,
                None => e
                    .rsplit_once(':')
                    .filter(|(_, p)| p.bytes().all(|b| b.is_ascii_digit()))
                    .map_or(e, |(h, _)| h),
            };
            let e = e
                .trim_start_matches("*.")
                .trim_start_matches('.')
                .trim_end_matches('.')
                .to_ascii_lowercase();
            host == e || host.ends_with(&format!(".{e}"))
        })
}

fn in_cidr(ip: std::net::IpAddr, net: &str, bits: &str) -> bool {
    use std::net::IpAddr;
    let (Ok(net), Ok(bits)) = (net.parse::<IpAddr>(), bits.parse::<u32>()) else {
        return false;
    };
    match (ip, net) {
        (IpAddr::V4(a), IpAddr::V4(n)) if bits <= 32 => {
            let mask = if bits == 0 {
                0
            } else {
                u32::MAX << (32 - bits)
            };
            u32::from(a) & mask == u32::from(n) & mask
        }
        (IpAddr::V6(a), IpAddr::V6(n)) if bits <= 128 => {
            let mask = if bits == 0 {
                0
            } else {
                u128::MAX << (128 - bits)
            };
            u128::from(a) & mask == u128::from(n) & mask
        }
        _ => false,
    }
}

/// A TCP connection to `host:port`: through the proxy's `CONNECT` tunnel when there is one.
///
/// # Errors
/// No connection within `timeout`, or the proxy refused the tunnel.
pub async fn connect(
    proxy: Option<&Proxy>,
    host: &str,
    port: u16,
    timeout: Duration,
) -> anyhow::Result<TcpStream> {
    let Some(p) = proxy else {
        return tokio::time::timeout(timeout, TcpStream::connect((host, port)))
            .await
            .map_err(|_| anyhow::anyhow!("{host}:{port}: no TCP connection within {timeout:?}"))?
            .map_err(Into::into);
    };
    let mut s = tokio::time::timeout(timeout, TcpStream::connect((p.host.as_str(), p.port)))
        .await
        .map_err(|_| {
            anyhow::anyhow!(
                "proxy {}: no TCP connection within {timeout:?}",
                p.display()
            )
        })??;
    let target = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut req = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if let Some(a) = &p.auth {
        let _ = write!(req, "Proxy-Authorization: Basic {}\r\n", STANDARD.encode(a));
    }
    req.push_str("\r\n");
    let answer = async {
        s.write_all(req.as_bytes()).await?;
        // The proxy's answer, up to the blank line; nothing of the tunnel's own bytes is read,
        // since the server says nothing before the client's hello.
        let mut head = Vec::with_capacity(256);
        let mut b = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            anyhow::ensure!(head.len() < 8192, "the proxy's answer has no end");
            anyhow::ensure!(
                s.read(&mut b).await? == 1,
                "the proxy closed the connection"
            );
            head.push(b[0]);
        }
        anyhow::Ok(head)
    };
    let head = tokio::time::timeout(timeout, answer).await.map_err(|_| {
        anyhow::anyhow!(
            "proxy {}: no answer to CONNECT within {timeout:?}",
            p.display()
        )
    })??;
    let status = String::from_utf8_lossy(&head);
    let line = status.lines().next().unwrap_or_default();
    anyhow::ensure!(
        line.split_whitespace().nth(1) == Some("200"),
        "proxy {} refused the tunnel to {target}: {line}",
        p.display()
    );
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_proxy_entries_cover_hosts_domains_and_addresses() {
        let np = "localhost, .corp.example, example.org:8443, 10.0.0.0/8, 192.0.2.7, [2001:db8::1]";
        for yes in [
            "localhost",
            "a.corp.example",
            "corp.example",
            "api.example.org",
            "10.1.2.3",
            "192.0.2.7",
            "2001:db8::1",
        ] {
            assert!(exempt(np, yes), "{yes}");
        }
        for no in [
            "example.com",
            "notcorp.example",
            "11.0.0.1",
            "192.0.2.8",
            "2001:db8::2",
        ] {
            assert!(!exempt(np, no), "{no}");
        }
        assert!(exempt("*", "anything.example"));
    }

    #[test]
    fn the_proxy_is_read_with_its_credentials_kept_out_of_display() {
        let p = choose(
            Some("http://alice:p%40ss@proxy.example:3128"),
            None,
            "dex.example.com",
        )
        .unwrap()
        .unwrap();
        assert_eq!(p.display(), "proxy.example:3128");
        assert_eq!(p.auth.as_deref(), Some("alice:p@ss"));
        let bare = choose(Some("proxy.example:8080"), None, "x")
            .unwrap()
            .unwrap();
        assert_eq!((bare.port, bare.auth), (8080, None));
    }

    #[test]
    fn no_proxy_and_no_setting_mean_a_direct_connection() {
        assert_eq!(choose(None, None, "dex.example.com").unwrap(), None);
        assert_eq!(
            choose(
                Some("http://proxy.example:3128"),
                Some(".example.com"),
                "dex.example.com"
            )
            .unwrap(),
            None
        );
        assert!(choose(Some("socks5://proxy.example:1080"), None, "x").is_err());
    }

    #[tokio::test]
    async fn a_tunnel_is_asked_for_and_a_refusal_is_reported() {
        use tokio::net::TcpListener;
        for (answer, ok) in [
            ("HTTP/1.1 200 Connection established\r\n\r\n", true),
            ("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n", false),
        ] {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = l.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (mut s, _) = l.accept().await.unwrap();
                let mut buf = vec![0u8; 512];
                let n = s.read(&mut buf).await.unwrap();
                s.write_all(answer.as_bytes()).await.unwrap();
                String::from_utf8_lossy(&buf[..n]).into_owned()
            });
            let p = Proxy {
                host: "127.0.0.1".into(),
                port,
                auth: Some("u:p".into()),
            };
            let r = connect(Some(&p), "broker.example.com", 443, Duration::from_secs(2)).await;
            let asked = server.await.unwrap();
            assert!(
                asked.starts_with("CONNECT broker.example.com:443 HTTP/1.1\r\n"),
                "{asked}"
            );
            assert!(asked.contains("Proxy-Authorization: Basic dTpw\r\n"));
            assert_eq!(r.is_ok(), ok, "{answer}");
        }
    }
}
