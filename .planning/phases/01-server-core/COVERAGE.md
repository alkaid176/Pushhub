# API Coverage — Phase 01 server-core

No external API integration: Phase 1 builds the first-party PushHub server on Cloudflare Workers runtime (Durable Objects / KV / WebSocket are platform bindings, not third-party services). The `/api/send` endpoint is PushHub's own surface, and "SDK" in scope prose refers to the first-party web client planned for a later phase.
