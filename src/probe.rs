// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

//! A TLS handshake of Recess's own to the broker or the issuer, for the 3D page's details:
//! what was negotiated and which certificates were presented. Observed, not assumed: the same
//! client configuration the mediatore CLI uses (TLS 1.3, the Mozilla roots or the CA file),
//! one connection, closed after the handshake. Nothing is sent over it.

use std::sync::Arc;
use std::time::Duration;

use axum::http::Uri;
use serde::Serialize;
use x509_parser::der_parser::oid::Oid;
use x509_parser::prelude::*;
use x509_parser::public_key::PublicKey;

/// What one handshake showed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TlsProbe {
    pub host: String,
    pub port: u16,
    pub version: String,
    pub cipher: String,
    pub key_exchange: String,
    pub alpn: String,
    /// What the chain was verified against.
    pub verified_with: String,
    /// The server's chain as presented, leaf first.
    pub chain: Vec<Cert>,
    pub at: String,
    /// A placeholder, from `--demo`: nothing was dialled.
    pub demo: bool,
}

/// One certificate of a presented chain.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cert {
    pub subject: String,
    pub issuer: String,
    pub sans: Vec<String>,
    pub not_before: String,
    pub not_after: String,
    pub key: String,
    pub signature: String,
    pub serial: String,
}

const TIMEOUT: Duration = Duration::from_secs(5);

/// The host and port of an `https` URL; anything else is refused.
pub fn endpoint(url: &str) -> anyhow::Result<(String, u16)> {
    let uri: Uri = url.trim().parse()?;
    anyhow::ensure!(uri.scheme_str() == Some("https"), "{url}: not an https URL");
    let host = uri
        .host()
        .ok_or_else(|| anyhow::anyhow!("{url}: no host"))?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    Ok((host, uri.port_u16().unwrap_or(443)))
}

/// Handshake with the server at `url` and report what it negotiated and presented.
pub async fn probe(url: &str, ca_file: &str) -> anyhow::Result<TlsProbe> {
    let (host, port) = endpoint(url)?;
    let mut cfg = if ca_file.is_empty() {
        mediatore_proto::tls::https_client_config()
    } else {
        mediatore_proto::tls::https_client_config_with_ca(&std::fs::read(ca_file)?)?
    };
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    let connector = tokio_rustls::TlsConnector::from(Arc::new(cfg));
    let tcp = tokio::time::timeout(
        TIMEOUT,
        tokio::net::TcpStream::connect((host.as_str(), port)),
    )
    .await
    .map_err(|_| anyhow::anyhow!("{host}:{port}: no TCP connection within 5 s"))??;
    let name = rustls::pki_types::ServerName::try_from(host.clone())?;
    let tls = tokio::time::timeout(TIMEOUT, connector.connect(name, tcp))
        .await
        .map_err(|_| anyhow::anyhow!("{host}:{port}: no TLS handshake within 5 s"))??;
    let (_, conn) = tls.get_ref();
    let chain = conn
        .peer_certificates()
        .unwrap_or_default()
        .iter()
        .map(|c| cert(c.as_ref()))
        .collect();
    Ok(TlsProbe {
        host,
        port,
        version: conn.protocol_version().map_or_else(String::new, version),
        cipher: conn
            .negotiated_cipher_suite()
            .map(|s| format!("{:?}", s.suite()))
            .unwrap_or_default(),
        key_exchange: conn
            .negotiated_key_exchange_group()
            .map(|g| format!("{:?}", g.name()))
            .unwrap_or_default(),
        alpn: conn
            .alpn_protocol()
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .unwrap_or_default(),
        verified_with: if ca_file.is_empty() {
            "the Mozilla roots (webpki-roots)".into()
        } else {
            format!("the CA file {ca_file}")
        },
        chain,
        at: jiff::Timestamp::now().to_string(),
        demo: false,
    })
}

fn version(v: rustls::ProtocolVersion) -> String {
    match v {
        rustls::ProtocolVersion::TLSv1_3 => "TLS 1.3".into(),
        rustls::ProtocolVersion::TLSv1_2 => "TLS 1.2".into(),
        other => format!("{other:?}"),
    }
}

/// The parts of a certificate worth reading, from its DER.
#[must_use]
pub fn cert(der: &[u8]) -> Cert {
    let Ok((_, c)) = X509Certificate::from_der(der) else {
        return Cert {
            subject: "(not a parsable X.509 certificate)".into(),
            ..Cert::default()
        };
    };
    let reg = oid_registry();
    let name = |o: &Oid| oid2sn(o, reg).map_or_else(|_| o.to_id_string(), str::to_owned);
    let spki = c.public_key();
    let key = match spki.parsed() {
        Ok(PublicKey::RSA(k)) => format!("RSA {} bits", k.key_size()),
        Ok(PublicKey::EC(_)) => {
            let curve = spki
                .algorithm
                .parameters
                .as_ref()
                .and_then(|p| p.as_oid().ok())
                .map_or_else(|| "unknown curve".to_owned(), |o| name(&o));
            format!("EC {curve}")
        }
        _ => name(&spki.algorithm.algorithm),
    };
    let sans = c
        .subject_alternative_name()
        .ok()
        .flatten()
        .map(|ext| {
            ext.value
                .general_names
                .iter()
                .map(|g| match g {
                    GeneralName::DNSName(s) | GeneralName::URI(s) | GeneralName::RFC822Name(s) => {
                        (*s).to_owned()
                    }
                    GeneralName::IPAddress(b) => ip(b),
                    other => format!("{other:?}"),
                })
                .collect()
        })
        .unwrap_or_default();
    Cert {
        subject: c.subject().to_string(),
        issuer: c.issuer().to_string(),
        sans,
        not_before: c.validity().not_before.to_string(),
        not_after: c.validity().not_after.to_string(),
        key,
        signature: name(&c.signature_algorithm.algorithm),
        serial: c.raw_serial_as_string(),
    }
}

fn ip(b: &[u8]) -> String {
    match b.len() {
        4 => std::net::Ipv4Addr::new(b[0], b[1], b[2], b[3]).to_string(),
        16 => <[u8; 16]>::try_from(b).map_or_else(
            |_| String::new(),
            |a| std::net::Ipv6Addr::from(a).to_string(),
        ),
        _ => format!("{b:02x?}"),
    }
}

/// What `--demo` shows instead of a handshake: placeholders, marked as such.
#[must_use]
pub fn demo(url: &str) -> TlsProbe {
    let (host, port) = endpoint(url).unwrap_or_else(|_| ("example.com".into(), 443));
    TlsProbe {
        chain: vec![
            Cert {
                subject: format!("CN={host}"),
                issuer: "C=US, O=Example Trust, CN=Example TLS CA E1".into(),
                sans: vec![host.clone()],
                not_before: "Oct  1 00:00:00 2026 +00:00".into(),
                not_after: "Dec 30 23:59:59 2026 +00:00".into(),
                key: "EC prime256v1".into(),
                signature: "ecdsa-with-SHA384".into(),
                serial: "0a:1b:2c:3d".into(),
            },
            Cert {
                subject: "C=US, O=Example Trust, CN=Example TLS CA E1".into(),
                issuer: "C=US, O=Example Trust, CN=Example Root X2".into(),
                sans: vec![],
                not_before: "Mar 13 00:00:00 2024 +00:00".into(),
                not_after: "Mar 12 23:59:59 2027 +00:00".into(),
                key: "EC secp384r1".into(),
                signature: "ecdsa-with-SHA384".into(),
                serial: "4e:5f:60:71".into(),
            },
        ],
        host,
        port,
        version: "TLS 1.3".into(),
        cipher: "TLS13_AES_256_GCM_SHA384".into(),
        key_exchange: "X25519MLKEM768".into(),
        alpn: "h2".into(),
        verified_with: "the Mozilla roots (webpki-roots)".into(),
        at: jiff::Timestamp::now().to_string(),
        demo: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_endpoints_are_probed_and_the_port_defaults_to_443() {
        assert_eq!(
            endpoint("https://dex.example.com").unwrap(),
            ("dex.example.com".into(), 443)
        );
        assert_eq!(
            endpoint("https://mediatore.example.com:8443/x").unwrap(),
            ("mediatore.example.com".into(), 8443)
        );
        assert_eq!(
            endpoint("https://[2001:db8::1]:9443").unwrap(),
            ("2001:db8::1".into(), 9443)
        );
        assert!(endpoint("http://plain.example.com").is_err());
        assert!(endpoint("not a url").is_err());
    }

    #[test]
    fn a_der_that_is_not_a_certificate_is_said_so_not_a_panic() {
        assert!(cert(b"nope").subject.contains("not a parsable"));
    }

    #[test]
    fn the_demo_probe_is_marked_and_names_the_configured_host() {
        let p = demo("https://mediatore.example.com:8443");
        assert!(p.demo);
        assert_eq!((p.host.as_str(), p.port), ("mediatore.example.com", 8443));
        assert_eq!(p.chain[0].sans, ["mediatore.example.com"]);
    }

    #[test]
    fn ip_sans_read_as_addresses() {
        assert_eq!(ip(&[192, 0, 2, 7]), "192.0.2.7");
        assert_eq!(
            ip(&[0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            "2001:db8::1"
        );
    }
}
