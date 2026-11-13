/**
 * PATCH(jchl254 2026-11-02): the draft route id lives on its own module.
 *
 * The sidebar and the app shell both need `DRAFT_SESSION_ID`. Importing it from chat-page dragged
 * the whole page into the entry chunk — composer, markdown renderer, mermaid, katex and the
 * remark/rehype pipeline — because a static import takes the entire module. Measured before this
 * split: the entry was 2.8MB, of which roughly 1.1MB was code only /chat ever runs.
 */

/**
 * Route id for a draft chat (`/chat/new`): the Session hasn't been persisted yet — the user may
 * still want to change the model or configure a key first. The actual Session is only created
 * once **the first message is sent** (once created, the model is locked into its meta).
 * Real session ids always start with `session-`, so there's no collision with this constant —
 * nor with parked draft conversations, whose route ids start with `draft-` (draft-sessions.ts).
 */
export const DRAFT_SESSION_ID = "new";

/** Parked-draft route id (`/chat/draft-…` — a draft conversation row in the sidebar list), or null. */
export const parkedDraftIdOf = (routeSessionId: string | null): string | null =>
  routeSessionId !== null && routeSessionId.startsWith("draft-") ? routeSessionId : null;
