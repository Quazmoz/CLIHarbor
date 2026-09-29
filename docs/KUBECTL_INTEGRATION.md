# kubectl Integration

CLIHarbor includes a small first-party read-only kubectl pack at:

```text
packs/kubectl/kubectl.yaml
```

The pack is embedded for normal `serve` and `doctor` startup alongside the Conjur and Docker packs. kubectl itself is **not** bundled, downloaded, installed, configured, or authenticated by CLIHarbor. Normal executable discovery and identity verification remain authoritative.

## Upstream command baseline

The initial pack is derived from the current official Kubernetes kubectl reference for:

- `kubectl config current-context`
- `kubectl version --client=true --output=json`
- `kubectl get namespaces` with fixed custom-column output
- `kubectl get nodes` with fixed custom-column output
- `kubectl get pods --all-namespaces` with fixed custom-column output
- `kubectl get deployments --all-namespaces` with fixed custom-column output
- `kubectl get statefulsets --all-namespaces` with fixed custom-column output
- `kubectl get daemonsets --all-namespaces` with fixed custom-column output
- `kubectl get jobs --all-namespaces` with fixed custom-column output
- `kubectl top node`
- `kubectl top pod --all-namespaces`

Official references:

- https://kubernetes.io/docs/reference/kubectl/generated/kubectl_config/kubectl_config_current-context/
- https://kubernetes.io/docs/reference/kubectl/generated/kubectl_version/
- https://kubernetes.io/docs/reference/kubectl/generated/kubectl_get/
- https://kubernetes.io/docs/reference/kubectl/generated/kubectl_top/
- https://kubernetes.io/docs/reference/kubectl/generated/kubectl_top/kubectl_top_node/
- https://kubernetes.io/docs/reference/kubectl/generated/kubectl_top/kubectl_top_pod/

## Safety scope

The first pack is intentionally metadata-only. It excludes:

- kubeconfig contents, users, certificates, bearer tokens, and credential material;
- Secrets and ConfigMaps;
- raw object JSON/YAML and manifests;
- logs, exec, attach, cp, debug, and shell-like container access;
- port-forward, proxy, and local forwarding surfaces;
- impersonation flags and browser-selected context/server/user overrides;
- context switching or kubeconfig mutation;
- create/apply/patch/replace/delete/scale/rollout/cordon/drain/taint and other mutations.

`Show active Kubernetes context` exposes only the current context name so the operator can see which target the cluster inventory tasks will use. The pack never changes that context. Cluster-backed tasks use `vendor-session`, meaning kubectl remains responsible for kubeconfig/session/credential handling; CLIHarbor accepts no Kubernetes credentials.

Inventory commands use fixed custom-column projections to avoid returning complete Kubernetes objects. Stage 5 workload views expose only namespace/name and selected status counters; they do not return pod templates, commands, environment data, labels, annotations, manifests, or event text. `kubectl top` commands are one-shot CPU/memory snapshots and may fail normally when the Metrics API / Metrics Server is unavailable. Raw output is not persisted by the pack.

## Runtime qualification

Public CI validates schema loading, static lint, exact production-planner argv, default-pack composition, and the no-auto-provisioning boundary without requiring a Kubernetes cluster.

Real execution still depends on an approved local kubectl installation, a valid current context, network reachability, and whatever authentication/authorization the target cluster requires. CLIHarbor does not auto-provision kubectl or bypass cluster/device policy.
