<!-- Copyright (c) 2026 Erick Bourgeois, Recess -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Recess in a cluster, behind Dex

> **⚠ NEVER GIVE RECESS ANY ACCESS OF ITS OWN.**
>
> Recess must never hold any Kubernetes permission. Do not bind its ServiceAccount to any
> Role or ClusterRole, do not grant it `impersonate`, do not mount its token, do not hand it
> a kubeconfig, and do not run it under another identity that has access. Every read it
> makes is the signed-in person's own, made with their own Dex token, so the API server
> checks **their** RBAC and nothing else. That is the whole of its security model: a page
> that cannot see anything on its own cannot show anyone more than they could see with
> `kubectl`, and cannot be turned against the cluster if it is compromised. A Recess with a
> grant of its own is a misconfiguration, whatever the grant.
>
> The RBAC files in `deploy/` are for **people** (their users or groups). Never put the
> `recess` ServiceAccount in their subjects.
>
> Recess enforces what it can: with `--oidc-issuer`, it refuses to start if a ServiceAccount
> token is mounted, drops any credentials from its kubeconfig (it keeps only the API server's
> address and CA), and never builds a client of its own. On your own machine, without an
> issuer, it is not shared: it reads with your kubeconfig, as you.

Run this way, Recess is a page your team opens to watch every live agent (the Admin view) and
the cluster itself (the Kubernetes view).
Everyone signs in with Dex first: `/` and every other page send a visitor who is not signed in
to Dex, then back. Every Kubernetes read is then made with **that person's own ID token**, so
the API server applies their RBAC: two people can see different things on the same page, and a
kind someone may not read is named on the page instead of shown.

Recess itself holds no access. Its service account is bound to nothing, and its token is never
mounted. Nor does it impersonate (as some dashboards do with an `impersonate` grant): it has no
access of its own to fall back on, so a read is never more than the person could make with
`kubectl`. The pod gets only the cluster's CA and its namespace, which is all the client needs to
find the API server.

Runs are refused on a shared Recess: a mediatore login and a claim would act as whoever
started the server. To run a workload, use `recess web` on your own machine.

## What the cluster needs

**1. The API server trusts Dex** for an audience. A structured authentication config, as an
example (the `github:` prefix is your choice):

```yaml
apiVersion: apiserver.config.k8s.io/v1
kind: AuthenticationConfiguration
jwt:
  - issuer:
      url: https://dex.bar.foo.io
      audiences: ["kubernetes"]
    claimMappings:
      username: { claim: preferred_username, prefix: "github:" }
      groups: { claim: groups, prefix: "github:" }
```

**2. Dex knows Recess's callback.** Pick one of these.

*A client of its own (recommended).* A confidential `recess` client, which the `kubernetes`
client trusts as a peer, so Dex issues tokens for the `kubernetes` audience to it:

```yaml
staticClients:
  - id: kubernetes
    public: true
    trustedPeers: [recess]
    # ...its redirectURIs, as before
  - id: recess
    name: Recess
    secretEnv: RECESS_CLIENT_SECRET
    redirectURIs: [https://recess.bar.foo.io/auth/callback]
```

Then in `config.env`: `RECESS_OIDC_CLIENT_ID=recess`, `RECESS_OIDC_AUDIENCE=kubernetes`,
`RECESS_OIDC_CLIENT_SECRET_FILE=/etc/recess/oidc/client-secret`. Put the secret in a Secret
named `recess-oidc` with the key `client-secret`.

*The `kubernetes` client.* Add `https://recess.bar.foo.io/auth/callback` to its
`redirectURIs`. No secret is needed (it is a public client), and `config.env` stays as shipped.

**3. People have RBAC.** [`viewer-rbac.yaml`](viewer-rbac.yaml) is a ClusterRole for every
kind the Admin view watches, with a binding to a placeholder group. Edit the subject to your own
group. [`broker-rbac.yaml`](broker-rbac.yaml) is for the broker's namespace: the broker's logs
(the gateway decisions) and its Secrets' names. It is applied on its own, and granted with care:
RBAC cannot grant "metadata only".

The Kubernetes view needs nothing more of Recess. A person sees what their own bindings let
them list across the cluster: people who already hold `view` or their own read roles see
their namespaces and pods with no change. For those who do not:

- [`kubernetes-rbac.yaml`](kubernetes-rbac.yaml): namespaces and pods, plus the custom
  resources' groups you list in it (a wildcard group would match Secrets too).
- [`kubernetes-secrets-rbac.yaml`](kubernetes-secrets-rbac.yaml): the vaults. Recess lists
  Secrets as metadata only and reads a value only when a drawer is opened, but RBAC cannot
  grant less than `get`, `list` and `watch`, which read every value by other means.

Both are examples with a placeholder group, applied on their own, and neither is in
`kustomization.yaml`. The view watches each kind across the whole cluster, so a RoleBinding
in one namespace does not show that namespace's pods or Secrets. Whether a vault's drawers
open is asked per namespace (a SelfSubjectAccessReview), which every signed-in person may do.

**4. TLS in front.** The Service is plain HTTP. Put an ingress with TLS in front of it, at the
host in `RECESS_PUBLIC_URL`. Recess refuses an `http://` public URL other than localhost,
because the session cookie must not cross a network in clear.

## Deploy

```sh
$EDITOR deploy/config.env        # the issuer, the public URL, the broker's namespace
kubectl apply -k deploy/
kubectl -n banlieue-system apply -f deploy/broker-rbac.yaml   # optional, see above
kubectl apply -f deploy/kubernetes-rbac.yaml                    # optional, see above
kubectl apply -f deploy/kubernetes-secrets-rbac.yaml            # optional, with care
```

The image is `ghcr.io/firestoned/recess`, built from the repository's `Dockerfile` (`make
image` locally): the release binary on `gcr.io/distroless/cc-debian13:nonroot`, running as
uid 65532 with a read-only root filesystem. CI pushes it on every merge to main (`main`,
`latest`, `sha-<commit>`) and on every release (its version: v0.1.0 is `0.1.0`), signed
with Cosign and attested:

```sh
cosign verify ghcr.io/firestoned/recess:0.1.0 \
  --certificate-identity-regexp '^https://github.com/firestoned/recess/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/firestoned/recess:0.1.0 --repo firestoned/recess | tee
```

`kustomization.yaml` pins the release; set `newTag` to `main` to follow main.

## How a sign-in goes

1. A visitor without a session is sent to `/auth/login`. That starts the authorization code
   flow with PKCE, binds its `state` to the browser with a cookie, and redirects to Dex.
2. Dex redirects back to `/auth/callback`. Recess trades the code for tokens and checks the ID
   token: its signature against Dex's published keys (fetched again when a token names a key
   not yet seen, as after a rotation; only asymmetric algorithms, never `none`), then the
   issuer, the audience, the authorized party, the expiry, not-before and the nonce. It then asks
   the API server who the token makes them (a SelfSubjectReview). A token the API server will
   not take is refused right there, with the reason.
3. The tokens stay on the server, keyed by a random `HttpOnly` cookie. The ID token is
   refreshed before it expires (with `offline_access`), and every refreshed token is checked
   as in step 2. Signing out, 12 idle hours, or a token that expires without a refresh Dex
   accepts ends the session and stops its watches.
4. A page whose session has ended is logged out and shown **Login to Recess**, as is a
   sign-out. An open page asks every 30 seconds (and when its tab comes back into view)
   whether it is still signed in; asking does not count as use, so an idle session still
   ends.

Sessions live in memory: a restart signs everyone out, and the Deployment has one replica.

The 3D views show the layout as shipped. Ctrl-drag, which moves a station and saves the layout
on your own machine, is off here: nothing is written, so the root filesystem stays read-only.

## On your own machine

Without `--oidc-issuer`, nothing changes. Recess listens on loopback only, the printed link
carries its key, and the cluster is read with your kubeconfig. You can also try the sign-in
locally against your Dex. The public URL is this server, so its port is the one it listens on
(7480 unless `--listen` says otherwise):

```sh
recess web --view admin \
  --oidc-issuer https://dex.bar.foo.io --public-url http://localhost:7480
```

Dex must accept `http://localhost:7480/auth/callback` as the client's redirect. A public
client that lists no `redirectURIs` accepts any `http://localhost` one. Most `kubernetes`
clients list kubelogin's (`http://localhost:8000`, `http://localhost:18000`), and then Dex
accepts only what is listed and answers "Unregistered redirect_uri": add the callback to the
list.
