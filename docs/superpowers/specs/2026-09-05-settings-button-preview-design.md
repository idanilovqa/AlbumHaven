# Settings Button Preview Design

## Goal

Show how confirmation and cancellation actions respond to hover, press, and keyboard focus inside the Appearance settings preview.

## Design

Add a compact footer beneath the miniature player in the existing Main elements preview. A short `Buttons` label explains that the controls are an interaction preview. The footer contains a quiet secondary `Cancel` button and a primary `Save` button rendered by the shared JavaScript Button component.

The buttons are focusable so keyboard users can preview the focus outline. They carry no settings action attributes, so clicking them cannot save, discard, or mutate the Appearance draft. Their colors and interaction states come from the preview's live appearance tokens and the production Button stylesheet.

The footer remains inside the existing preview frame and uses restrained spacing so it works at the current narrow preview width. No new palette, button variant, or animation is introduced.

## Verification

- A runtime markup test proves the preview uses the shared Button renderer, exposes the explanatory label, and does not attach save/cancel action attributes.
- The existing focused Appearance and Button tests guard the surrounding behavior.
- A focused Playwright component test verifies the preview buttons receive the live hover and focus outline styling.

