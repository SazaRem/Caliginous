Caliginous Browser

Caliginous is a standalone, privacy-focused desktop browser built with Tauri 2 (Rust backend) and vanilla HTML/CSS/JavaScript (frontend).

It is not a Chrome skin, not an Electron wrapper, and not an extension host. The goal is a lean, native browser shell with strong defaults, clear identity, and privacy-first behavior.

Vision
Privacy by design (default-on protections, no telemetry-first mindset)
Lean and intentional (small stack, low bloat)
Aesthetic discipline (dark-only UI, Junicode + JetBrains Mono, restrained neon accents)
Native-first extensibility (modules/integrations instead of full Chrome-extension complexity)
Current Architecture
Frontend: src/index.html, src/styles.css, src/main.js
Backend: src-tauri/src/lib.rs command layer + webview/tab orchestration
Permissions: src-tauri/capabilities/default.json
App config: src-tauri/tauri.conf.json
Current Status (April 2026)

The project has a strong design identity and functional browser shell primitives, but is in an architecture transition:

UI shell and tab model are in place
Rust webview orchestration exists and should become the authority
Privacy counters are currently placeholder/simulated in parts
Some planned privacy features remain roadmap items
Prioritized Roadmap
Phase 1 — Make browsing path structurally correct
Standardize on native webviews for page hosting
Keep frontend as control surface and state/UI renderer
Ensure robust open/close/switch/navigate tab lifecycle
Phase 2 — Stabilize browser behavior
Improve URL/address parsing and error states
Harden back/forward/reload behavior and sync
Improve tab metadata sync (title/url/loading)
Phase 3 — Implement real privacy layer
Request filtering and tracker/ad blocking
HTTPS enforcement and URL tracking-parameter stripping
Privacy UI indicators driven by real blocked events
Phase 4 — Isolation and advanced capabilities
Session/state isolation options
Password manager hardening flow
Optional advanced integrations after core stability
Design Rules (Non-negotiable)
Dark-only chrome
Junicode for browser UI text
JetBrains Mono for URLs/numeric/technical text
Single neon-white accent family
Subtle animation and depth; no flashy motion
Development
# Install dependencies
npm install

# Run development build
npm run tauri dev

# Build production bundles
npm run tauri build
Notes for Contributors
Keep Rust command API small and explicit.
Prefer clarity over cleverness in main.js until module split is completed.
Any new privacy-facing feature must be measurable and real (not simulated) before being marketed as complete.
