# Copyright (c) 2026 Erick Bourgeois, Recess
# SPDX-License-Identifier: Apache-2.0
#
# Recess as a distroless image: the release binary on gcr.io/distroless/cc (glibc and libgcc,
# nothing else: no shell, no package manager), running as nonroot (65532). Both images are
# pinned by digest; Dependabot moves them.
#
#   podman build -t recess:dev .        (or: make image)
#
# In a pod, run it shared behind Dex (deploy/): without --oidc-issuer it listens on loopback
# only, which a pod's network does not reach.

FROM docker.io/library/rust:1.99-slim-trixie@sha256:f6c4a35d21dbb3c89d7a8d056c193e94fc09037f2b58dd858b09c39a47dd02d7 AS build
WORKDIR /src
# The manifests first, so the dependencies are a layer of their own.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
    && cargo fetch --locked \
    && cargo build --release --locked \
    && rm -rf src
COPY src src
COPY assets assets
# The stub's binary is newer than nothing: touch so cargo rebuilds the real one.
RUN touch src/main.rs && cargo build --release --locked

FROM gcr.io/distroless/cc-debian13:nonroot@sha256:532c7a94f9e96ba9db75eb9388f4227751131c7cb0a411d1a8521af4096135de
LABEL org.opencontainers.image.title="recess" \
      org.opencontainers.image.description="Recess: every live agent in the cluster, read with each signed-in person's own RBAC" \
      org.opencontainers.image.source="https://github.com/firestoned/recess" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=build /src/target/release/recess /usr/local/bin/recess
COPY LICENSE NOTICE /usr/share/doc/recess/
USER 65532:65532
EXPOSE 7480
ENTRYPOINT ["/usr/local/bin/recess"]
CMD ["web", "--no-open"]
