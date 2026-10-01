# r-blog maintenance context

Before continuing work, read `docs/PROJECT_CONTEXT.md` and `README.md`.
The context document records the implemented architecture, product requirements,
deployment workflow, and the last verified handoff state. Recheck current GitHub
and Cloudflare state before deployment; recorded version IDs are historical facts.

Preserve the established product requirements unless the user changes them:

- One owner account, no public registration.
- Markdown editing with the existing Rust rendering and preview engine.
- Private R2 storage for article originals, drafts, history, and release snapshots.
- GitHub stores project code; daily article publication does not create Git commits.
- Saving a draft and publishing are separate operations.
- Preserve existing published pages and images during migrations and failed builds.

Keep passwords, setup tokens, build tokens, deployment hook URLs, and private
article contents out of Git, documentation, tool output, and chat. Use the existing
authenticated connectors or configured CLI credentials for account operations.
Explain results and writing operations in plain Chinese when replying to the user.
