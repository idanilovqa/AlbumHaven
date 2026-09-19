# SEARCH028 trace and case adaptation

The retained initial trace is under `album-haven-functional-local-287951cfb4c3-gallery_search_visual/output/wave-01-02-playwright-config-js/searchTreeCorrectness-FTC--b7198--artist-name-match-complete-functional/trace.zip` in the owned temporary fixture.

At 06:37:38.337Z, the `q=transatlantic` search response resource `fd8544cf9e6b353251b33de7f05f05d057a72912.json` selects Transatlantic with `auto_top_match` provenance and 18 primary albums. Call `call@132` then clicks the Neal Morse sidebar row. At 06:37:39.363Z its request contains `artist=Neal+Morse` and no `q`; response `f589a938eb6b16e0646f8a27b935cd264f6f58e6.json` has empty query, Neal primary, null search context and 10 primary albums plus family.

This click changes primary artist and therefore falls under the owner's explicit Gallery approval to clear search/family on different-primary selection. It does not demonstrate the separate cache-provenance defect.

The existing case now asserts the automatic Transatlantic selection, then compares the reset Neal gallery against its captured no-query baseline. Explicit normal `artist`/`q` URLs preserve the content-only Neal, full artist-name Transatlantic, and track-title-only Neal contracts. Same-primary Neal selection retains the query and exact one-heading/one-album result. No budgets, retries, conditional passes or case title changes were introduced. Native verification remains pending.
