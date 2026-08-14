# Go AI Agent Runtime

This internal service pins AgentScope 2.0.6 and provides Redis-backed sessions
with persistent per-project Docker workspaces. It is a runtime dependency of
the Go AI workbench, not a public chat API.

Security boundaries:

- Expose the service only to the Go AI BFF. `X-User-ID` is trusted only after
  the BFF authenticates the request and replaces any client-supplied value.
- Enable AgentScope `bypass` only for a strongly isolated Docker workspace.
  `dont_ask` denies operations that require confirmation; it is not full access.
- Never combine a public AgentScope endpoint with a host Docker socket. Use a
  dedicated rootless daemon or a sandbox node in production.
- Never pass provider credentials or host secrets into workspace `env`.

The development stack in `deploy/agentscope/compose.yaml` uses a dedicated
rootless Docker-in-Docker daemon over an internal TLS network. It deliberately
does not mount the host Docker socket. The workspace volume must also be
mounted by the Go AI BFF at the same `AGENTSCOPE_WORKSPACE_ROOT` so uploads and
agent tools operate on one source of truth.

The current Windows development machine has no Docker runtime, so the real
container and model loop are not claimed as verified. On the Linux sandbox
host, install the pinned project, start Redis, provide the variables from
`.env.example`, start `uvicorn main:app`, verify `/go-ai/health`, then run the
end-to-end project-file acceptance flow through the Go AI BFF.
