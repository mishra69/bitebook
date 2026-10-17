# Bitebook: working rules

Bitebook is a personal PWA for logging meal photos. Batches of photos are analyzed by
pasting them into a chatbot, and the replies are imported back into the app. Start with
`docs/SPEC.md`, but read it according to the rules below.

## How to trust the docs

The spec ages, and its sections age at different speeds. Every section has a header line:

> **Tier:** Core | Contract | Plan · **Verified:** YYYY-MM-DD · **Expires:** YYYY-MM-DD

- **Core** (long-lived): the purpose, principles and invariants. It has no expiry. If code
  contradicts Core, treat that as a bug, or ask whether Core should change. Never quietly
  follow the code. Any change to Core needs a dated entry in `docs/decisions.md`.
- **Contract** (medium-lived): formats that outlive any one version of the code, such as the
  reply JSON, the D1 schema and the R2 key layout. They are versioned. Once a contract is
  implemented, **the code is authoritative**: shrink the section to a pointer to the file
  plus the reasoning the code can't hold.
- **Plan** (short-lived): stack choices, screens, build order and open questions. A Plan
  section past its `Expires` date is a **hint, not an instruction**. Check the code first,
  then update the section (new Verified/Expires dates) or delete it. Delete Plan sections
  once they are built, because the code and git history are the record.

Precedence when they disagree: **Core > code > Contract text > Plan text.**

## Keeping it fresh

- At the start of a session, run `scripts/spec-expired.sh` and mention any expired
  sections before relying on them.
- If a commit changes behavior that the spec describes, update that section in the
  same commit and bump its `Verified` date. A doc change in a later commit tends to
  never happen.
- Don't restate in the spec what the code already says clearly.
- `docs/decisions.md` is append-only. Never edit old entries. Add a new entry that
  supersedes the old one.
