<!-- Copyright (c) 2026 Erick Bourgeois, Recess -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Recess in a cluster, behind Dex

Run this way, Recess is a page your team opens to watch every live agent (the Admin view).
Everyone signs in with Dex first: `/` and every other page send a visitor who is not signed in
to Dex, then back. Every Kubernetes read is then made with **that person's own ID token**, so
the API server applies their RBAC: two people can see different things on the same page, and a
kind someone may not read is named on the page instead of shown.

Recess itself holds no access. Its service account is bound to nothing, and its token is never
mounted. The pod gets only the cluster's CA and its namespace, which is all the client needs to
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

**4. TLS in front.** The Service is plain HTTP. Put an ingress with TLS in front of it, at the
host in `RECESS_PUBLIC_URL`. Recess refuses an `http://` public URL other than localhost,
because the session cookie must not cross a network in clear.

## Deploy

```sh
$EDITOR deploy/config.env        # the issuer, the public URL, the broker's namespace
kubectl apply -k deploy/
kubectl -n banlieue-system apply -f deploy/broker-rbac.yaml   # optional, see above
```

The image is built from the repository's `Dockerfile` (`make image`): the release binary on
`gcr.io/distroless/cc-debian13:nonroot`, running as uid 65532 with a read-only root
filesystem.

## How a sign-in goes

1. A visitor without a session is sent to `/auth/login`. That starts the authorization code
   flow with PKCE, binds its `state` to the browser with a cookie, and redirects to Dex.
2. Dex redirects back to `/auth/callback`. Recess trades the code for tokens and checks the ID
   token: the issuer, the audience, the authorized party, the expiry and the nonce. It then asks
   the API server who the token makes them (a SelfSubjectReview). A token the API server will
   not take is refused right there, with the reason.
3. The tokens stay on the server, keyed by a random `HttpOnly` cookie. The ID token is
   refreshed before it expires (with `offline_access`). Signing out, 12 idle hours, or a
   refused refresh ends the session and stops its watches.

Sessions live in memory: a restart signs everyone out, and the Deployment has one replica.

The 3D views show the layout as shipped. Ctrl-drag, which moves a station and saves the layout
on your own machine, is off here: nothing is written, so the root filesystem stays read-only.

## On your own machine

Without `--oidc-issuer`, nothing changes. Recess listens on loopback only, the printed link
carries its key, and the cluster is read with your kubeconfig. You can also try the sign-in
locally against a Dex whose `kubernetes` client is public, since Dex accepts any
`http://localhost` redirect for a public client:

```sh
recess web --view admin --listen 127.0.0.1:7491 \
  --oidc-issuer https://dex.bar.foo.io --public-url http://localhost:7491
```
