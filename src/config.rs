// Copyright (c) 2026 Erick Bourgeois, Low Tide
// SPDX-License-Identifier: Apache-2.0

//! The config file: `KEY=VALUE` lines in the mediatore CLI's own environment variables
//! (`MEDIATORE_ISSUER`, `MEDIATORE_URL`, `MEDIATORE_CA_FILE`, ...) and Low Tide's
//! (`LOW_TIDE_*`), so one file serves both and nothing is spelled twice. It only fills what
//! the environment leaves unset: a flag beats the environment, the environment beats the file,
//! the file beats the built-in default.
//!
//! Where: `--config <path>`, else `LOW_TIDE_CONFIG`, else
//! `$XDG_CONFIG_HOME/low-tide/config.env` (`~/.config/low-tide/config.env`). A missing default
//! file is fine; a missing file that was named is an error.

use std::path::{Path, PathBuf};

/// The keys the file may set: the CLI's, Low Tide's, and the kubeconfig.
fn allowed(key: &str) -> bool {
    key.starts_with("MEDIATORE_") || key.starts_with("LOW_TIDE_") || key == "KUBECONFIG"
}

/// One parsed file: the pairs it sets, in order, and the lines it ignored (with why).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Parsed {
    pub pairs: Vec<(String, String)>,
    pub ignored: Vec<(usize, String)>,
}

/// Parse a dotenv-style file: `KEY=VALUE`, `export KEY=VALUE`, `#` comments, blank lines,
/// values optionally in single or double quotes. No expansion of any kind.
#[must_use]
pub fn parse(text: &str) -> Parsed {
    let mut out = Parsed::default();
    for (i, raw) in text.lines().enumerate() {
        let n = i + 1;
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").map_or(line, str::trim_start);
        let Some((k, v)) = line.split_once('=') else {
            out.ignored.push((n, "not KEY=VALUE".into()));
            continue;
        };
        let k = k.trim();
        if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            out.ignored
                .push((n, format!("{k:?} is not a variable name")));
            continue;
        }
        if !allowed(k) {
            out.ignored.push((
                n,
                format!("{k} is not a MEDIATORE_*, LOW_TIDE_* or KUBECONFIG key"),
            ));
            continue;
        }
        let v = v.trim();
        let v = if v.len() >= 2
            && ((v.starts_with('"') && v.ends_with('"'))
                || (v.starts_with('\'') && v.ends_with('\'')))
        {
            &v[1..v.len() - 1]
        } else {
            // An unquoted value ends at a ` #` comment.
            v.split(" #").next().unwrap_or_default().trim_end()
        };
        out.pairs.push((k.to_owned(), v.to_owned()));
    }
    out
}

/// The default file's path.
#[must_use]
pub fn default_path() -> Option<PathBuf> {
    let base = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => PathBuf::from(std::env::var_os("HOME")?).join(".config"),
    };
    Some(base.join("low-tide").join("config.env"))
}

/// Which file to read: `--config`, else `LOW_TIDE_CONFIG`, else the default; and whether it
/// was named (a named file must exist).
#[must_use]
pub fn choose(flag: Option<PathBuf>) -> Option<(PathBuf, bool)> {
    if let Some(p) = flag {
        return Some((p, true));
    }
    match std::env::var_os("LOW_TIDE_CONFIG") {
        Some(p) if !p.is_empty() => Some((PathBuf::from(p), true)),
        _ => default_path().map(|p| (p, false)),
    }
}

/// `--config <path>` or `--config=<path>` from the raw arguments, read before clap so the
/// file can feed clap's `env` defaults.
#[must_use]
pub fn flag_from_args(args: &[String]) -> Option<PathBuf> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--config" {
            return it.next().map(PathBuf::from);
        }
        if let Some(p) = a.strip_prefix("--config=") {
            return Some(PathBuf::from(p));
        }
    }
    None
}

/// What loading did, for `low-tide config` and the web page's hint.
#[derive(Debug, Default, Clone)]
pub struct Loaded {
    pub path: Option<PathBuf>,
    pub found: bool,
    /// Keys the file set (the environment did not have them).
    pub set: Vec<String>,
    /// Keys the file had but the environment already set.
    pub shadowed: Vec<String>,
    pub ignored: Vec<(usize, String)>,
}

/// Read the file and fill the environment with what it leaves unset.
///
/// # Safety
/// Calls `std::env::set_var`: call it before any other thread exists (before the tokio
/// runtime is built), as `main` does.
///
/// # Errors
/// A named file that cannot be read.
pub unsafe fn load(chosen: Option<(PathBuf, bool)>) -> anyhow::Result<Loaded> {
    let Some((path, named)) = chosen else {
        return Ok(Loaded::default());
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if !named && e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Loaded {
                path: Some(path),
                ..Loaded::default()
            });
        }
        Err(e) => anyhow::bail!("config {}: {e}", path.display()),
    };
    let parsed = parse(&text);
    let mut loaded = Loaded {
        path: Some(path),
        found: true,
        ignored: parsed.ignored,
        ..Loaded::default()
    };
    for (k, v) in parsed.pairs {
        if std::env::var_os(&k).is_some_and(|x| !x.is_empty()) {
            loaded.shadowed.push(k);
        } else {
            // SAFETY: the caller guarantees no other thread exists yet.
            unsafe { std::env::set_var(&k, v) };
            loaded.set.push(k);
        }
    }
    Ok(loaded)
}

/// The template `low-tide config init` writes.
pub const TEMPLATE: &str = r#"# Low Tide config: KEY=VALUE, the mediatore CLI's own variables plus LOW_TIDE_*.
# A flag beats the environment, the environment beats this file. Lists are comma-separated;
# booleans are true unless empty, 0, false, no or off.
# Never put a token or a secret here: the login keeps those in the session file.

# mediatore login
#MEDIATORE_ISSUER=https://dex.example.com
#MEDIATORE_CLIENT_ID=mediatore
#MEDIATORE_CA_FILE=/path/to/ca.pem
#LOW_TIDE_SCOPES=openid,profile,email,groups,offline_access
#LOW_TIDE_AUTH_PARAMS=prompt=consent
#LOW_TIDE_LOGIN_HINT=
#LOW_TIDE_CLIENT_SECRET_FILE=
#LOW_TIDE_REDIRECT_PORTS=8000,18000
#LOW_TIDE_REDIRECT_HOST=localhost
#LOW_TIDE_REDIRECT_PATH=
#LOW_TIDE_NO_BROWSER=false
#LOW_TIDE_REUSE_SESSION=false
#MEDIATORE_SESSION=/path/to/session.json

# mediatore sandbox create
#MEDIATORE_URL=https://mediatore.example.com
#MEDIATORE_ALLOW_PLAIN_HTTP=false
#MEDIATORE_NAMESPACE=sandboxes
#LOW_TIDE_POOL=
#LOW_TIDE_POOL_SELECTOR=
#LOW_TIDE_STRATEGY=
#LOW_TIDE_TTL=3600
#LOW_TIDE_AUDIENCES=
#LOW_TIDE_DELEGATE=
#LOW_TIDE_POLICY=
#LOW_TIDE_RESTART=never
#LOW_TIDE_NO_LOGS=false
# The workload the form starts with: an image from a registry the pool reaches.
#LOW_TIDE_WORKLOAD=registry.internal:5000/library/python:3.13-slim python3 -u -c "print('hello world')"

# Where to watch, and the server
#KUBECONFIG=/path/to/kubeconfig
#LOW_TIDE_CONTEXT=
#LOW_TIDE_BROKER_NAMESPACE=banlieue-system
#LOW_TIDE_GATEWAY_SELECTOR=mediatore.io/role=gateway
#LOW_TIDE_GATEWAY_NAMESPACE=
#LOW_TIDE_GATEWAY_PREFIX=gateway-
#LOW_TIDE_NO_GATEWAYS=false
#LOW_TIDE_LISTEN=127.0.0.1:7480
#LOW_TIDE_NO_OPEN=false
#LOW_TIDE_DEMO=false
"#;

/// Write the template at `path`, never over an existing file.
///
/// # Errors
/// The file exists, or cannot be written.
pub fn init(path: &Path) -> anyhow::Result<()> {
    anyhow::ensure!(!path.exists(), "{} exists; edit it instead", path.display());
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, TEMPLATE)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_cli_variables_and_ignores_the_rest() {
        let p = parse(
            "# comment\n\
             \n\
             MEDIATORE_ISSUER=https://dex.example.com\n\
             export MEDIATORE_URL = \"https://mediatore.example.com\"\n\
             LOW_TIDE_WORKLOAD='img python3 -c \"print(1)\"'\n\
             MEDIATORE_NAMESPACE=sandboxes # trailing comment\n\
             HOME=/tmp\n\
             not a pair\n\
             BAD-KEY=x\n",
        );
        assert_eq!(
            p.pairs,
            [
                ("MEDIATORE_ISSUER".into(), "https://dex.example.com".into()),
                (
                    "MEDIATORE_URL".into(),
                    "https://mediatore.example.com".into()
                ),
                (
                    "LOW_TIDE_WORKLOAD".into(),
                    r#"img python3 -c "print(1)""#.into()
                ),
                ("MEDIATORE_NAMESPACE".into(), "sandboxes".into()),
            ]
        );
        let lines: Vec<usize> = p.ignored.iter().map(|(n, _)| *n).collect();
        assert_eq!(lines, [7, 8, 9]);
    }

    #[test]
    fn the_config_flag_is_read_before_clap() {
        let a = |v: &[&str]| v.iter().map(ToString::to_string).collect::<Vec<_>>();
        assert_eq!(
            flag_from_args(&a(&["low-tide", "--config", "/x", "web"])),
            Some(PathBuf::from("/x"))
        );
        assert_eq!(
            flag_from_args(&a(&["low-tide", "web", "--config=/y"])),
            Some(PathBuf::from("/y"))
        );
        assert_eq!(flag_from_args(&a(&["low-tide", "web"])), None);
    }

    #[test]
    fn the_template_parses_to_nothing_set() {
        let p = parse(TEMPLATE);
        assert_eq!(p, Parsed::default());
    }
}
