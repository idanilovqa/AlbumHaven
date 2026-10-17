# Multi-root gallery provenance v001

Status: draft for owner review; no production implementation approval.

The September 23, 2026 owner approval confirms the permission, deployment,
and client proposal in this task. Root administration and scans remain
owner/admin operations under existing capabilities. Browse, playback, and
Problematic Files retain their existing library-scoped capabilities.
Self-hosted/private node and web are required; Tauri optional; native Android,
TV, and Apple and public hosted cloud are unsupported for this delivery.
No new preset grant or move capability is introduced.

Mockup preparation is authorized by the owner's request for mocks. The
current-stack exception is awaiting an explicit answer because this branch
predates the React migration required by the Wave 2 plan.

Reference: ../../../screens/utilities-refactor/v001/references/stored-library-desktop.jpg
(historical gallery screenshot). Current implementation reference:
music_app/static/js/runtime/gallery-card-component.js and associated gallery
styles at base commit 0900c81a. The current HTTPS app could not be reached
during this pass. The preview uses synthetic art and metadata, not private
library assets or media requests.

Two treatments will compare subtle category tint with stronger category fill.
Both retain the established card geometry, image area, typography, hover glow,
year, and accessible focus. Hoard and New Arrivals receive distinct icons and
text labels. Mixed-source albums retain both labels. Color alone never
communicates category. The source control opens the existing Album Details
source/location presentation; no move action is proposed.
