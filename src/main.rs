// Copyright (c) 2026 Erick Bourgeois, Low Tide
// SPDX-License-Identifier: Apache-2.0

//! Low Tide: walk one workload through mediatore and watch each stage happen, in a
//! browser (`web`) or a terminal (`tui`). Both drive the same pipeline (`engine`), which uses
//! mediatore's own client crate for the login, the claim and the output, and the Kubernetes
//! API for the `AgentSandbox`.

mod demo;
mod engine;
mod kubeinfo;
mod phases;
mod secrets;
mod tui;
mod util;
mod web;

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

/// The workload the form and the TUI start with: real output, a pause, an exit code.
const DEFAULT_WORKLOAD: &str = "docker.io/library/python:3.13-slim python3 -u -c \"import time; print('hello world'); time.sleep(10); print('slept 10 s, exiting')\"";

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Serve the pipeline as a web page on loopback and open it.
    Web {
        #[command(flatten)]
        common: Common,
        /// Where to listen; loopback only
        #[arg(long, env = "LOW_TIDE_LISTEN", default_value = "127.0.0.1:7480")]
        listen: SocketAddr,
        /// Print the link instead of opening the browser
        #[arg(long)]
        no_open: bool,
    },
    /// Show the pipeline in this terminal.
    Tui {
        #[command(flatten)]
        common: Common,
        /// The workload to start with, `IMAGE [ARG...]` (editable before the run)
        #[arg(long)]
        workload: Option<String>,
    },
}

/// Where to log in, where to claim, and the claim's shape. The web form starts from these.
#[derive(Args, Clone)]
#[allow(clippy::struct_excessive_bools)] // flags: each bool is one switch
struct Common {
    /// The OIDC issuer, exactly as mediatore's config names it
    #[arg(long, env = "MEDIATORE_ISSUER", default_value = "")]
    issuer: String,
    /// mediatore's public client id at the issuer
    #[arg(long, env = "MEDIATORE_CLIENT_ID", default_value = "mediatore")]
    client_id: String,
    /// mediatore's user API base URL
    #[arg(long = "mediatore", env = "MEDIATORE_URL", default_value = "")]
    url: String,
    /// PEM CA for the issuer and the user API (private PKI); when given, nothing else is trusted
    #[arg(long, env = "MEDIATORE_CA_FILE", default_value = "")]
    ca_file: String,
    /// Allow a plain http user API on another host (test clusters only)
    #[arg(long, env = "MEDIATORE_ALLOW_PLAIN_HTTP")]
    allow_plain_http: bool,
    /// The namespace to claim in (ADR-0046)
    #[arg(long, env = "MEDIATORE_NAMESPACE", default_value = "")]
    namespace: String,
    /// One pool by name
    #[arg(long, default_value = "")]
    pool: String,
    /// Any pool whose labels match, KEY=VALUE (repeatable)
    #[arg(long = "pool-selector")]
    pool_selector: Vec<String>,
    /// longest-ready, most-available or spread
    #[arg(long, default_value = "")]
    strategy: String,
    /// Lifetime in seconds, from bind
    #[arg(long, default_value_t = 3600)]
    ttl: u32,
    /// Downstream audience the sandbox may request (repeatable)
    #[arg(long = "audience")]
    audiences: Vec<String>,
    /// AUDIENCE=SOURCE: claude-code, env:NAME or file:PATH (repeatable)
    #[arg(long)]
    delegate: Vec<String>,
    /// The notaio policy, by name
    #[arg(long, default_value = "")]
    policy: String,
    /// never (the default here: one run, one exit), on-failure or always
    #[arg(long, default_value = "never")]
    restart: String,
    /// Do not capture the workload's output
    #[arg(long)]
    no_logs: bool,
    /// Skip the login when the saved session is fresh and its delegation unspent
    #[arg(long)]
    reuse_session: bool,
    /// Do not open a browser for the login; the authorization URL is shown instead
    #[arg(long)]
    no_browser: bool,
    /// Kubeconfig for the AgentSandbox watch (default: KUBECONFIG, then ~/.kube/config)
    #[arg(long)]
    kubeconfig: Option<PathBuf>,
    /// Kube context (default: the kubeconfig's current one)
    #[arg(long)]
    context: Option<String>,
    /// Label selector for the egress gateway VMs (banlieue VirtualMachines)
    #[arg(
        long,
        env = "LOW_TIDE_GATEWAY_SELECTOR",
        default_value = "mediatore.io/role=gateway"
    )]
    gateway_selector: String,
    /// Namespace of the gateway VMs (default: all namespaces)
    #[arg(long, env = "LOW_TIDE_GATEWAY_NAMESPACE", default_value = "")]
    gateway_namespace: String,
    /// When the selector finds none: VMs whose name starts with this
    #[arg(long, env = "LOW_TIDE_GATEWAY_PREFIX", default_value = "gateway-")]
    gateway_prefix: String,
    /// Replay a scripted run with placeholder values: no login, no claim, no cluster
    #[arg(long)]
    demo: bool,
    /// Do not look for gateway VMs
    #[arg(long)]
    no_gateways: bool,
    /// The broker's namespace, where it writes the sealed Secrets
    #[arg(
        long,
        env = "LOW_TIDE_BROKER_NAMESPACE",
        default_value = "banlieue-system"
    )]
    broker_namespace: String,
}

impl Common {
    fn settings(&self, workload: String) -> engine::Settings {
        engine::Settings {
            workload,
            issuer: self.issuer.clone(),
            client_id: self.client_id.clone(),
            url: self.url.clone(),
            ca_file: self.ca_file.clone(),
            allow_plain_http: self.allow_plain_http,
            namespace: self.namespace.clone(),
            pool: self.pool.clone(),
            pool_selector: self.pool_selector.clone(),
            strategy: self.strategy.clone(),
            ttl: self.ttl,
            audiences: self.audiences.clone(),
            delegate: self.delegate.clone(),
            policy: self.policy.clone(),
            restart: self.restart.clone(),
            logs: !self.no_logs,
            reuse_session: self.reuse_session,
            no_browser: self.no_browser,
        }
    }

    fn kube(&self) -> engine::KubeTarget {
        engine::KubeTarget {
            kubeconfig: self.kubeconfig.clone(),
            context: self.context.clone(),
            gateways: (!self.no_gateways).then(|| kubeinfo::GatewayQuery {
                selector: self.gateway_selector.clone(),
                namespace: self.gateway_namespace.clone(),
                name_prefix: self.gateway_prefix.clone(),
            }),
            broker_namespace: self.broker_namespace.clone(),
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    mediatore_proto::tls::ensure_provider();
    match Cli::parse().cmd {
        Cmd::Web {
            common,
            listen,
            no_open,
        } => {
            web::serve(
                listen,
                common.settings(DEFAULT_WORKLOAD.to_owned()),
                common.kube(),
                !no_open,
                common.demo,
            )
            .await
        }
        Cmd::Tui { common, workload } => {
            tui::run(
                common.settings(workload.unwrap_or_else(|| DEFAULT_WORKLOAD.to_owned())),
                common.kube(),
                common.demo,
            )
            .await
        }
    }
}
